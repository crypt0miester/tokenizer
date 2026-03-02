use pinocchio::{
    cpi::{Seed, Signer},
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    AccountView,
    Address,
    ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;

use crate::{
    error::TokenizerError,
    state::{
        asset::Asset,
        asset_token::AssetToken,
        listing::Listing,
        protocol_config::ProtocolConfig,
        validate_account_key, AccountKey, AssetStatus, ListingStatus,
        ASSET_SEED, ASSET_TOKEN_SEED, LISTING_SEED, PROTOCOL_CONFIG_SEED,
    },
    validation::{
        require_owner, require_pda, require_pda_with_bump, require_signer, require_system_program,
        require_writable,
    },
};
use crate::utils::Pk;

/// Create a listing for a token on the secondary market.
///
/// Instruction data layout:
/// [0..8]   shares_for_sale: u64
/// [8..16]  price_per_share: u64
/// [16]     is_partial: u8
/// [17..25] expiry: i64
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    let [
        config,
        asset_account,
        asset_token_account,
        listing_account,
        seller,
        payer,
        system_program,
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

    let accepted_mint = asset.accepted_mint;
    let org_key = asset.organization;
    let asset_id = asset.id;
    let asset_bump = asset.bump;
    let asset_transfer_cooldown = asset.transfer_cooldown;
    drop(asset_ref);

    require_pda_with_bump(
        asset_account,
        &[ASSET_SEED, &org_key, &asset_id.to_le_bytes(), &[asset_bump]],
        program_id,
        "asset_account",
    )?;

    // Validate asset_token
    require_owner(asset_token_account, program_id, "asset_token_account")?;
    require_writable(asset_token_account, "asset_token_account")?;
    let at_ref = asset_token_account.try_borrow()?;
    validate_account_key(&at_ref, AccountKey::AssetToken)?;
    let at = unsafe { AssetToken::load(&at_ref) };

    // Verify token belongs to this asset
    if &at.asset != asset_account.address().as_array() {
        pinocchio_log::log!("at.asset: expected {}, got {}", Pk(&at.asset), Pk(asset_account.address().as_array()));
        return Err(TokenizerError::TokenAssetMismatch.into());
    }

    // Verify seller owns the token
    require_signer(seller, "seller")?;
    if &at.owner != seller.address().as_array() {
        pinocchio_log::log!("at.owner: expected {}, got {}", Pk(&at.owner), Pk(seller.address().as_array()));
        return Err(TokenizerError::NotTokenOwner.into());
    }

    // Must not already be listed
    if at.is_listed() {
        pinocchio_log::log!("at: already listed");
        return Err(TokenizerError::TokenAlreadyListed.into());
    }

    // Must not have active governance votes
    if at.has_active_votes() {
        pinocchio_log::log!("at: has active votes");
        return Err(TokenizerError::GovernanceTokenLocked.into());
    }

    // Lockup check
    let at_lockup_end = at.lockup_end;
    let at_last_transfer_at = at.last_transfer_at;

    let token_shares = at.shares;
    let token_index = at.token_index;
    let at_bump = at.bump;
    drop(at_ref);

    // Check lockup and cooldown
    {
        let clock_now = Clock::get()?.unix_timestamp;
        if at_lockup_end != 0 && clock_now < at_lockup_end {
            pinocchio_log::log!("token locked until {}", at_lockup_end);
            return Err(TokenizerError::TokenLocked.into());
        }
        if asset_transfer_cooldown != 0 && clock_now - at_last_transfer_at < asset_transfer_cooldown {
            pinocchio_log::log!("transfer cooldown active");
            return Err(TokenizerError::TransferCooldownActive.into());
        }
    }

    // Validate asset_token PDA
    require_pda_with_bump(
        asset_token_account,
        &[ASSET_TOKEN_SEED, asset_account.address().as_ref(), &token_index.to_le_bytes(), &[at_bump]],
        program_id,
        "asset_token_account",
    )?;

    // Parse instruction data (25 bytes)
    if data.len() < 25 {
        return Err(TokenizerError::InstructionDataTooShort.into());
    }

    let shares_for_sale = u64::from_le_bytes(data[0..8].try_into().unwrap());
    let price_per_share = u64::from_le_bytes(data[8..16].try_into().unwrap());
    let is_partial = data[16];
    let expiry = i64::from_le_bytes(data[17..25].try_into().unwrap());

    // Validate shares
    if shares_for_sale == 0 {
        return Err(TokenizerError::InvalidSharesForSale.into());
    }
    if shares_for_sale > token_shares {
        return Err(TokenizerError::SharesExceedOwned.into());
    }

    // Validate price
    if price_per_share == 0 {
        return Err(TokenizerError::InvalidListingPrice.into());
    }

    // Validate expiry if set
    if expiry != 0 {
        let clock = Clock::get()?;
        if expiry <= clock.unix_timestamp {
            pinocchio_log::log!("expired: now={}, expiry={}", clock.unix_timestamp, expiry);
            return Err(TokenizerError::ListingExpired.into());
        }
    }

    // Validate remaining accounts
    require_signer(payer, "payer")?;
    require_writable(listing_account, "listing_account")?;
    require_system_program(system_program)?;

    // Validate listing PDA
    let listing_bump = require_pda(
        listing_account,
        &[LISTING_SEED, asset_token_account.address().as_ref()],
        program_id,
        "listing_account",
    )?;

    // Create Listing PDA account
    let listing_bump_bytes = [listing_bump];
    let listing_seeds = [
        Seed::from(LISTING_SEED),
        Seed::from(asset_token_account.address().as_ref()),
        Seed::from(&listing_bump_bytes),
    ];
    let listing_signer = Signer::from(&listing_seeds);

    CreateAccount {
        from: payer,
        to: listing_account,
        lamports: pinocchio::sysvars::rent::Rent::get()
            .map(|r| r.try_minimum_balance(Listing::LEN).unwrap_or(0))
            .unwrap_or(0),
        space: Listing::LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[listing_signer])?;

    // Initialize Listing state
    let clock = Clock::get()?;
    let mut listing_data = listing_account.try_borrow_mut()?;
    let listing = unsafe { Listing::load_mut(&mut listing_data) };

    listing.account_key = AccountKey::Listing as u8;
    listing.version = 1;
    listing.asset_token = asset_token_account.address().to_bytes();
    listing.asset = asset_account.address().to_bytes();
    listing.seller = seller.address().to_bytes();
    listing.accepted_mint = accepted_mint;
    listing.shares_for_sale = shares_for_sale;
    listing.price_per_share = price_per_share;
    listing.expiry = expiry;
    listing.status = ListingStatus::Active as u8;
    listing.is_partial = is_partial;
    listing.created_at = clock.unix_timestamp;
    listing.bump = listing_bump;

    drop(listing_data);

    // Mark asset_token as listed
    let mut at_data = asset_token_account.try_borrow_mut()?;
    let at = unsafe { AssetToken::load_mut(&mut at_data) };
    at.is_listed = 1;

    Ok(())
}
