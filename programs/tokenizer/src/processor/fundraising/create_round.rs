use pinocchio::{
    cpi::{Seed, Signer},
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    AccountView,
    Address,
    ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;
use pinocchio_token::instructions::InitializeAccount3;

use crate::{
    error::TokenizerError,
    state::{
        asset::Asset,
        fundraising_round::FundraisingRound,
        organization::Organization,
        protocol_config::ProtocolConfig,
        validate_account_key, AccountKey, AssetStatus, RoundStatus,
        ASSET_SEED, ESCROW_SEED, FUNDRAISING_ROUND_SEED, ORGANIZATION_SEED,
        PROTOCOL_CONFIG_SEED,
    },
    validation::{
        require_owner, require_pda, require_pda_with_bump, require_signer,
        require_system_program, require_token_program, require_writable,
    },
};
use crate::utils::{read_u64, read_i64, read_bytes32, Pk};

/// SPL Token account size (165 bytes).
const TOKEN_ACCOUNT_LEN: usize = 165;

/// Create a fundraising round for an asset with an escrow token account.
///
/// Instruction data layout:
/// [0..8]   shares_offered: u64
/// [8..16]  price_per_share: u64
/// [16..24] min_raise: u64
/// [24..32] max_raise: u64
/// [32..40] min_per_wallet: u64
/// [40..48] max_per_wallet: u64
/// [48..56] start_time: i64
/// [56..64] end_time: i64
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    let [
        config,
        org_account,
        asset_account,
        round_account,         // PDA to create
        escrow,                // Escrow token account PDA to create
        accepted_mint,         // SPL token mint
        authority,             // Org authority, signer
        payer,
        system_program,
        token_program,
    ] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate protocol
    require_owner(config, program_id, "config")?;
    let config_ref = config.try_borrow()?;
    validate_account_key(&config_ref, AccountKey::ProtocolConfig)?;
    let config_data = unsafe { ProtocolConfig::load(&config_ref) };
    config_data.require_not_paused()?;
    let config_bump = config_data.bump;
    drop(config_ref);
    require_pda_with_bump(config, &[PROTOCOL_CONFIG_SEED, &[config_bump]], program_id, "config")?;

    // Validate organization
    require_owner(org_account, program_id, "org_account")?;
    let org_ref = org_account.try_borrow()?;
    validate_account_key(&org_ref, AccountKey::Organization)?;
    let org = unsafe { Organization::load(&org_ref) };
    if !org.is_active() {
        pinocchio_log::log!("org: not active");
        return Err(TokenizerError::OrganizationNotActive.into());
    }
    // Validate authority matches org authority
    if authority.address().as_array() != &org.authority {
        pinocchio_log::log!("org.authority: expected {}, got {}", Pk(&org.authority), Pk(authority.address().as_array()));
        return Err(TokenizerError::InvalidAuthority.into());
    }
    // Validate accepted mint against org's list
    if !org.is_mint_accepted(accepted_mint.address().as_array()) {
        return Err(TokenizerError::OrgMintNotAccepted.into());
    }
    let org_id = org.id;
    let org_bump = org.bump;
    let org_authority = org.authority;
    drop(org_ref);

    require_pda_with_bump(
        org_account,
        &[ORGANIZATION_SEED, &org_id.to_le_bytes(), &[org_bump]],
        program_id,
        "org_account",
    )?;

    // Validate asset
    require_owner(asset_account, program_id, "asset_account")?;
    require_writable(asset_account, "asset_account")?;
    let asset_ref = asset_account.try_borrow()?;
    validate_account_key(&asset_ref, AccountKey::Asset)?;
    let asset = unsafe { Asset::load(&asset_ref) };

    let asset_id = asset.id;
    let asset_bump = asset.bump;
    require_pda_with_bump(
        asset_account,
        &[ASSET_SEED, org_account.address().as_ref(), &asset_id.to_le_bytes(), &[asset_bump]],
        program_id,
        "asset_account",
    )?;

    // Asset must be Draft or Active to create a round
    let status = asset.status();
    if status != AssetStatus::Draft && status != AssetStatus::Active {
        return Err(TokenizerError::AssetNotDraftOrActive.into());
    }

    // Block during active buyout
    if asset.active_buyout != [0u8; 32] {
        pinocchio_log::log!("blocked: active buyout exists");
        return Err(TokenizerError::BuyoutActiveBuyoutExists.into());
    }

    // Verify asset's accepted mint matches the provided mint
    if &asset.accepted_mint != accepted_mint.address().as_array() {
        pinocchio_log::log!("asset.accepted_mint: expected {}, got {}", Pk(&asset.accepted_mint), Pk(accepted_mint.address().as_array()));
        return Err(TokenizerError::MintNotAccepted.into());
    }

    // Check maturity — no new rounds after maturity date
    let asset_maturity_date = asset.maturity_date;
    if asset_maturity_date != 0 {
        let clock_check = Clock::get()?;
        if clock_check.unix_timestamp >= asset_maturity_date {
            pinocchio_log::log!("asset matured: now={}, maturity={}", clock_check.unix_timestamp, asset_maturity_date);
            return Err(TokenizerError::AssetMatured.into());
        }
    }

    let round_index = asset.fundraising_round_count;
    let total_shares = asset.total_shares;
    let minted_shares = asset.minted_shares;
    let native_treasury_addr = asset.native_treasury;
    drop(asset_ref);

    // Parse instruction data (104 bytes)
    let shares_offered = read_u64(data, 0, "shares_offered")?;
    let price_per_share = read_u64(data, 8, "price_per_share")?;
    let min_raise = read_u64(data, 16, "min_raise")?;
    let max_raise = read_u64(data, 24, "max_raise")?;
    let min_per_wallet = read_u64(data, 32, "min_per_wallet")?;
    let max_per_wallet = read_u64(data, 40, "max_per_wallet")?;
    let start_time = read_i64(data, 48, "start_time")?;
    let end_time = read_i64(data, 56, "end_time")?;
    let lockup_end = read_i64(data, 64, "lockup_end")?;
    let terms_hash = read_bytes32(data, 72, "terms_hash")?;

    // Validate round configuration
    if shares_offered == 0 {
        return Err(TokenizerError::InvalidShareCount.into());
    }

    let available_shares = total_shares
        .checked_sub(minted_shares)
        .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;
    if shares_offered > available_shares {
        return Err(TokenizerError::SharesExceedOffered.into());
    }

    if price_per_share == 0 {
        return Err(TokenizerError::InvalidRoundConfig.into());
    }
    if min_raise > max_raise {
        return Err(TokenizerError::InvalidRoundConfig.into());
    }
    if max_raise == 0 {
        return Err(TokenizerError::InvalidRoundConfig.into());
    }
    if start_time >= end_time {
        return Err(TokenizerError::InvalidTimeRange.into());
    }
    if max_per_wallet != 0 && min_per_wallet > max_per_wallet {
        return Err(TokenizerError::InvalidRoundConfig.into());
    }

    // Validate remaining accounts
    require_signer(authority, "authority")?;
    require_signer(payer, "payer")?;
    require_writable(round_account, "round_account")?;
    require_writable(escrow, "escrow")?;
    require_system_program(system_program)?;
    require_token_program(token_program)?;

    // Validate round PDA
    let round_bump = require_pda(
        round_account,
        &[FUNDRAISING_ROUND_SEED, asset_account.address().as_ref(), &round_index.to_le_bytes()],
        program_id,
        "round_account",
    )?;

    // Validate escrow PDA
    let escrow_bump = require_pda(
        escrow,
        &[ESCROW_SEED, round_account.address().as_ref()],
        program_id,
        "escrow",
    )?;

    // 1. Create FundraisingRound PDA account
    let round_index_bytes = round_index.to_le_bytes();
    let round_bump_bytes = [round_bump];
    let round_seeds = [
        Seed::from(FUNDRAISING_ROUND_SEED),
        Seed::from(asset_account.address().as_ref()),
        Seed::from(round_index_bytes.as_ref()),
        Seed::from(&round_bump_bytes),
    ];
    let round_signer = Signer::from(&round_seeds);

    CreateAccount {
        from: payer,
        to: round_account,
        lamports: pinocchio::sysvars::rent::Rent::get()
            .map(|r| r.try_minimum_balance(FundraisingRound::LEN).unwrap_or(0))
            .unwrap_or(0),
        space: FundraisingRound::LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[round_signer])?;

    // 2. Create escrow token account
    let escrow_bump_bytes = [escrow_bump];
    let escrow_seeds = [
        Seed::from(ESCROW_SEED),
        Seed::from(round_account.address().as_ref()),
        Seed::from(&escrow_bump_bytes),
    ];
    let escrow_signer = Signer::from(&escrow_seeds);

    CreateAccount {
        from: payer,
        to: escrow,
        lamports: pinocchio::sysvars::rent::Rent::get()
            .map(|r| r.try_minimum_balance(TOKEN_ACCOUNT_LEN).unwrap_or(0))
            .unwrap_or(0),
        space: TOKEN_ACCOUNT_LEN as u64,
        owner: &pinocchio_token::ID,
    }
    .invoke_signed(&[escrow_signer])?;

    // 3. Initialize escrow as token account (authority = round PDA)
    InitializeAccount3 {
        account: escrow,
        mint: accepted_mint,
        owner: round_account.address(),
    }
    .invoke()?;

    // 4. Initialize FundraisingRound state
    let clock = Clock::get()?;
    let mut round_data = round_account.try_borrow_mut()?;
    let round = unsafe { FundraisingRound::load_mut(&mut round_data) };

    round.account_key = AccountKey::FundraisingRound as u8;
    round.version = 1;
    round.round_index = round_index;
    round.asset = asset_account.address().to_bytes();
    round.organization = org_account.address().to_bytes();
    round.shares_offered = shares_offered;
    round.price_per_share = price_per_share;
    round.accepted_mint = accepted_mint.address().to_bytes();
    round.min_raise = min_raise;
    round.max_raise = max_raise;
    round.min_per_wallet = min_per_wallet;
    round.max_per_wallet = max_per_wallet;
    round.start_time = start_time;
    round.end_time = end_time;
    round.status = RoundStatus::Active as u8;
    round.escrow = escrow.address().to_bytes();
    round.total_raised = 0;
    round.shares_sold = 0;
    round.investor_count = 0;
    round.investors_settled = 0;
    round.created_at = clock.unix_timestamp;
    round.updated_at = clock.unix_timestamp;
    round.bump = round_bump;
    round.escrow_bump = escrow_bump;
    round.treasury = if native_treasury_addr != [0u8; 32] {
        native_treasury_addr
    } else {
        org_authority
    };
    round.lockup_end = lockup_end;
    round.terms_hash = terms_hash;
    drop(round_data);

    // 5. Update Asset: increment round count, set status to Fundraising
    let mut asset_mut = asset_account.try_borrow_mut()?;
    let asset = unsafe { Asset::load_mut(&mut asset_mut) };
    asset.fundraising_round_count = round_index
        .checked_add(1)
        .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;
    asset.status = AssetStatus::Fundraising as u8;
    asset.updated_at = clock.unix_timestamp;

    Ok(())
}
