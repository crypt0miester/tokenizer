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
        asset_token::AssetToken,
        offer::Offer,
        protocol_config::ProtocolConfig,
        validate_account_key, AccountKey, AssetStatus, OfferStatus,
        ASSET_SEED, ASSET_TOKEN_SEED, OFFER_ESCROW_SEED, OFFER_SEED,
        PROTOCOL_CONFIG_SEED,
    },
    utils::{spl_transfer, Pk},
    validation::{
        require_owner, require_pda, require_pda_with_bump, require_signer, require_system_program,
        require_token_program, require_writable,
    },
};

/// SPL Token account size (165 bytes).
const TOKEN_ACCOUNT_LEN: usize = 165;

/// Create an offer with escrow deposit.
///
/// Instruction data layout:
/// [0..8]   shares_requested: u64 (0 = all shares)
/// [8..16]  price_per_share: u64
/// [16..24] expiry: i64 (0 = no expiry)
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    let [
        config,
        asset_account,
        asset_token_account,
        offer_account,
        escrow,
        accepted_mint,
        buyer_token_acc,
        buyer,
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
    require_pda_with_bump(config, &[PROTOCOL_CONFIG_SEED, &[config_data.bump]], program_id, "config")?;
    config_data.require_not_paused()?;
    drop(config_ref);

    // Validate asset
    require_owner(asset_account, program_id, "asset_account")?;
    let asset_ref = asset_account.try_borrow()?;
    validate_account_key(&asset_ref, AccountKey::Asset)?;
    let asset = unsafe { Asset::load(&asset_ref) };

    if asset.status() != AssetStatus::Active {
        pinocchio_log::log!("asset.status: {}", asset.status);
        return Err(TokenizerError::AssetNotActiveForTrading.into());
    }

    // Block during active buyout
    if asset.active_buyout != [0u8; 32] {
        pinocchio_log::log!("blocked: active buyout exists");
        return Err(TokenizerError::BuyoutActiveBuyoutExists.into());
    }

    // Verify accepted mint matches
    if &asset.accepted_mint != accepted_mint.address().as_array() {
        pinocchio_log::log!("accepted_mint: expected {}, got {}", Pk(&asset.accepted_mint), Pk(accepted_mint.address().as_array()));
        return Err(TokenizerError::InvalidMint.into());
    }

    let org_key = asset.organization;
    let asset_id = asset.id;
    let asset_bump = asset.bump;
    drop(asset_ref);

    require_pda_with_bump(
        asset_account,
        &[ASSET_SEED, &org_key, &asset_id.to_le_bytes(), &[asset_bump]],
        program_id,
        "asset_account",
    )?;

    // Validate asset_token
    require_owner(asset_token_account, program_id, "asset_token_account")?;
    let at_ref = asset_token_account.try_borrow()?;
    validate_account_key(&at_ref, AccountKey::AssetToken)?;
    let at = unsafe { AssetToken::load(&at_ref) };

    // Verify token belongs to this asset
    if &at.asset != asset_account.address().as_array() {
        pinocchio_log::log!("at.asset: expected {}, got {}", Pk(&at.asset), Pk(asset_account.address().as_array()));
        return Err(TokenizerError::TokenAssetMismatch.into());
    }

    // Buyer must not be the owner
    require_signer(buyer, "buyer")?;
    if &at.owner == buyer.address().as_array() {
        pinocchio_log::log!("buyer is token owner ({})", Pk(buyer.address().as_array()));
        return Err(TokenizerError::InvalidBuyer.into());
    }

    // Token must not be listed for sale
    if at.is_listed() {
        pinocchio_log::log!("token is listed for sale");
        return Err(TokenizerError::TokenIsListed.into());
    }

    let token_shares = at.shares;
    let token_index = at.token_index;
    let at_bump = at.bump;
    drop(at_ref);

    // Validate asset_token PDA
    require_pda_with_bump(
        asset_token_account,
        &[ASSET_TOKEN_SEED, asset_account.address().as_ref(), &token_index.to_le_bytes(), &[at_bump]],
        program_id,
        "asset_token_account",
    )?;

    // Parse instruction data (24 bytes)
    if data.len() < 24 {
        return Err(TokenizerError::InstructionDataTooShort.into());
    }

    let shares_requested = u64::from_le_bytes(data[0..8].try_into().unwrap());
    let price_per_share = u64::from_le_bytes(data[8..16].try_into().unwrap());
    let expiry = i64::from_le_bytes(data[16..24].try_into().unwrap());

    // Validate price
    if price_per_share == 0 {
        return Err(TokenizerError::InvalidOfferPrice.into());
    }

    // Validate shares (0 = all shares)
    let effective_shares = if shares_requested == 0 {
        token_shares
    } else {
        if shares_requested > token_shares {
            return Err(TokenizerError::InvalidOfferShares.into());
        }
        shares_requested
    };

    // Calculate total deposit
    let total_deposit = u64::try_from(
        (effective_shares as u128)
            .checked_mul(price_per_share as u128)
            .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?
    ).map_err(|_| -> ProgramError { TokenizerError::MathOverflow.into() })?;

    // Validate expiry if set
    if expiry != 0 {
        let clock = Clock::get()?;
        if expiry <= clock.unix_timestamp {
            pinocchio_log::log!("expired: now={}, expiry={}", clock.unix_timestamp, expiry);
            return Err(TokenizerError::OfferExpired.into());
        }
    }

    // Validate remaining accounts
    require_signer(payer, "payer")?;
    require_writable(offer_account, "offer_account")?;
    require_writable(escrow, "escrow")?;
    require_writable(buyer_token_acc, "buyer_token_acc")?;
    require_system_program(system_program)?;
    require_token_program(token_program)?;

    // Validate offer PDA
    let offer_bump = require_pda(
        offer_account,
        &[OFFER_SEED, asset_token_account.address().as_ref(), buyer.address().as_ref()],
        program_id,
        "offer_account",
    )?;

    // Validate escrow PDA
    let escrow_bump = require_pda(
        escrow,
        &[OFFER_ESCROW_SEED, offer_account.address().as_ref()],
        program_id,
        "escrow",
    )?;

    // 1. Create Offer PDA account
    let offer_bump_bytes = [offer_bump];
    let offer_seeds = [
        Seed::from(OFFER_SEED),
        Seed::from(asset_token_account.address().as_ref()),
        Seed::from(buyer.address().as_ref()),
        Seed::from(&offer_bump_bytes),
    ];
    let offer_signer = Signer::from(&offer_seeds);

    CreateAccount {
        from: payer,
        to: offer_account,
        lamports: pinocchio::sysvars::rent::Rent::get()
            .map(|r| r.try_minimum_balance(Offer::LEN).unwrap_or(0))
            .unwrap_or(0),
        space: Offer::LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[offer_signer])?;

    // 2. Create escrow token account
    let escrow_bump_bytes = [escrow_bump];
    let escrow_seeds = [
        Seed::from(OFFER_ESCROW_SEED),
        Seed::from(offer_account.address().as_ref()),
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

    // 3. Initialize escrow as token account (authority = offer PDA)
    InitializeAccount3 {
        account: escrow,
        mint: accepted_mint,
        owner: offer_account.address(),
    }
    .invoke()?;

    // 4. Transfer stablecoins from buyer to escrow
    spl_transfer(buyer_token_acc, escrow, buyer, total_deposit, accepted_mint.address().as_array())?;

    // 5. Initialize Offer state
    let clock = Clock::get()?;
    let mut offer_data = offer_account.try_borrow_mut()?;
    let offer = unsafe { Offer::load_mut(&mut offer_data) };

    offer.account_key = AccountKey::Offer as u8;
    offer.version = 1;
    offer.asset_token = asset_token_account.address().to_bytes();
    offer.asset = asset_account.address().to_bytes();
    offer.buyer = buyer.address().to_bytes();
    offer.accepted_mint = accepted_mint.address().to_bytes();
    offer.shares_requested = shares_requested;
    offer.price_per_share = price_per_share;
    offer.expiry = expiry;
    offer.status = OfferStatus::Active as u8;
    offer.escrow = escrow.address().to_bytes();
    offer.total_deposited = total_deposit;
    offer.created_at = clock.unix_timestamp;
    offer.bump = offer_bump;
    offer.escrow_bump = escrow_bump;

    Ok(())
}
