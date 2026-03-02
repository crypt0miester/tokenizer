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
    utils::{spl_transfer, Pk},
    state::{
        asset::Asset,
        dividend_distribution::DividendDistribution,
        organization::Organization,
        protocol_config::ProtocolConfig,
        validate_account_key, AccountKey, AssetStatus,
        ASSET_SEED, DISTRIBUTION_ESCROW_SEED, DIVIDEND_DISTRIBUTION_SEED,
        ORGANIZATION_SEED, PROTOCOL_CONFIG_SEED,
    },
    validation::{
        require_owner, require_pda, require_pda_with_bump, require_signer,
        require_system_program, require_token_account, require_token_program, require_writable,
    },
};

/// SPL Token account size (165 bytes).
const TOKEN_ACCOUNT_LEN: usize = 165;

/// Create a dividend distribution for an asset.
///
/// Org authority deposits stablecoins into distribution escrow.
/// Records total_amount (deposited) and total_shares (snapshot of asset.minted_shares).
/// Increments asset.dividend_epoch.
///
/// Instruction data layout:
/// [0..8] total_amount: u64
///
/// Accounts:
///   0. config
///   1. org_account
///   2. asset(w)
///   3. distribution_account(w)
///   4. escrow(w)
///   5. depositor_token_acc(w)
///   6. accepted_mint
///   7. authority(s)
///   8. payer(s,w)
///   9. system_program
///  10. token_program
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    let [
        config,
        org_account,
        asset_account,
        distribution_account,
        escrow,
        depositor_token_acc,
        accepted_mint,
        authority,
        payer,
        system_program,
        token_program,
    ] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Parse instruction data
    if data.len() < 8 {
        return Err(TokenizerError::InstructionDataTooShort.into());
    }
    let total_amount = u64::from_le_bytes(data[0..8].try_into().unwrap());
    if total_amount == 0 {
        return Err(TokenizerError::InvalidDistributionAmount.into());
    }

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
    if authority.address().as_array() != &org.authority {
        pinocchio_log::log!("org.authority: expected {}, got {}", Pk(&org.authority), Pk(authority.address().as_array()));
        return Err(TokenizerError::InvalidAuthority.into());
    }
    let org_id = org.id;
    let org_bump = org.bump;
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

    if asset.status() != AssetStatus::Active {
        pinocchio_log::log!("asset.status: {}", asset.status);
        return Err(TokenizerError::AssetNotActiveForDistribution.into());
    }

    // Verify asset belongs to this org
    if &asset.organization != org_account.address().as_array() {
        pinocchio_log::log!("asset.organization: expected {}, got {}", Pk(org_account.address().as_array()), Pk(&asset.organization));
        return Err(TokenizerError::DistributionAssetMismatch.into());
    }

    let asset_id = asset.id;
    let epoch = asset.dividend_epoch;
    let minted_shares = asset.minted_shares;
    let accepted_mint_key = asset.accepted_mint;
    let asset_bump = asset.bump;
    drop(asset_ref);

    if minted_shares == 0 {
        return Err(TokenizerError::NoSharesToClaim.into());
    }

    require_pda_with_bump(
        asset_account,
        &[ASSET_SEED, org_account.address().as_ref(), &asset_id.to_le_bytes(), &[asset_bump]],
        program_id,
        "asset_account",
    )?;

    // Validate accepted_mint matches asset
    if accepted_mint.address().as_array() != &accepted_mint_key {
        pinocchio_log::log!("accepted_mint: expected {}, got {}", Pk(&accepted_mint_key), Pk(accepted_mint.address().as_array()));
        return Err(TokenizerError::InvalidMint.into());
    }

    // Validate signers & writable
    require_signer(authority, "authority")?;
    require_signer(payer, "payer")?;
    require_writable(payer, "payer")?;
    require_writable(distribution_account, "distribution_account")?;
    require_writable(escrow, "escrow")?;
    require_writable(depositor_token_acc, "depositor_token_acc")?;
    require_system_program(system_program)?;
    require_token_program(token_program)?;

    // Validate depositor token account: correct mint, owned by authority
    require_token_account(depositor_token_acc, &accepted_mint_key, authority.address().as_array())?;

    // Validate distribution PDA
    let epoch_bytes = epoch.to_le_bytes();
    let dist_bump = require_pda(
        distribution_account,
        &[DIVIDEND_DISTRIBUTION_SEED, asset_account.address().as_ref(), &epoch_bytes],
        program_id,
        "distribution_account",
    )?;

    // Distribution must not already exist
    if distribution_account.data_len() > 0 {
        return Err(TokenizerError::DistributionAlreadyExists.into());
    }

    // Validate escrow PDA
    let escrow_bump = require_pda(
        escrow,
        &[DISTRIBUTION_ESCROW_SEED, distribution_account.address().as_ref()],
        program_id,
        "escrow",
    )?;

    // 1. Create DividendDistribution PDA account
    let dist_bump_bytes = [dist_bump];
    let dist_seeds = [
        Seed::from(DIVIDEND_DISTRIBUTION_SEED),
        Seed::from(asset_account.address().as_ref()),
        Seed::from(epoch_bytes.as_ref()),
        Seed::from(&dist_bump_bytes),
    ];
    let dist_signer = Signer::from(&dist_seeds);

    CreateAccount {
        from: payer,
        to: distribution_account,
        lamports: pinocchio::sysvars::rent::Rent::get()
            .map(|r| r.try_minimum_balance(DividendDistribution::LEN).unwrap_or(0))
            .unwrap_or(0),
        space: DividendDistribution::LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[dist_signer])?;

    // 2. Create escrow token account
    let escrow_bump_bytes = [escrow_bump];
    let escrow_seeds = [
        Seed::from(DISTRIBUTION_ESCROW_SEED),
        Seed::from(distribution_account.address().as_ref()),
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

    // 3. Initialize escrow as token account (authority = distribution PDA)
    InitializeAccount3 {
        account: escrow,
        mint: accepted_mint,
        owner: distribution_account.address(),
    }
    .invoke()?;

    // 4. Transfer stablecoins from depositor to escrow
    spl_transfer(depositor_token_acc, escrow, authority, total_amount, &accepted_mint_key)?;

    // 5. Initialize DividendDistribution state
    let clock = Clock::get()?;
    let mut dist_data = distribution_account.try_borrow_mut()?;
    let dist = unsafe { DividendDistribution::load_mut(&mut dist_data) };
    dist.account_key = AccountKey::DividendDistribution as u8;
    dist.version = 1;
    dist.asset = asset_account.address().to_bytes();
    dist.epoch = epoch;
    dist.accepted_mint = accepted_mint.address().to_bytes();
    dist.total_amount = total_amount;
    dist.total_shares = minted_shares;
    dist.shares_claimed = 0;
    dist.escrow = escrow.address().to_bytes();
    dist.created_at = clock.unix_timestamp;
    dist.bump = dist_bump;
    dist.escrow_bump = escrow_bump;
    drop(dist_data);

    // 6. Increment asset.dividend_epoch
    let mut asset_mut = asset_account.try_borrow_mut()?;
    let asset = unsafe { Asset::load_mut(&mut asset_mut) };
    asset.dividend_epoch = epoch
        .checked_add(1)
        .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;
    asset.open_distributions = asset.open_distributions
        .checked_add(1)
        .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;
    asset.updated_at = clock.unix_timestamp;

    Ok(())
}
