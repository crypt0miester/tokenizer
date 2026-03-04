use pinocchio::{
    cpi::{Seed, Signer},
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    AccountView, Address, ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;

use crate::{
    error::TokenizerError,
    state::{
        asset::Asset,
        buyout_offer::BuyoutOffer,
        organization::Organization,
        protocol_config::ProtocolConfig,
        validate_account_key, AccountKey, AssetStatus, BuyoutStatus,
        ASSET_SEED, BUYOUT_OFFER_SEED, ORGANIZATION_SEED, PROTOCOL_CONFIG_SEED,
    },
    utils::{read_u8, read_u16, read_u64, read_i64, read_bytes32, Pk},
    validation::{
        require_owner, require_pda, require_pda_with_bump, require_signer,
        require_system_program, require_writable,
    },
};

/// Create a buyout offer for an asset.
///
/// Instruction data layout (84 bytes):
/// [0..8]   price_per_share: u64
/// [8]      is_council_buyout: u8
/// [9]      treasury_disposition: u8
/// [10..42] broker: [u8; 32]
/// [42..44] broker_bps: u16
/// [44..76] terms_hash: [u8; 32]
/// [76..84] expiry: i64
///
/// Accounts:
///   0. config (ro)           - ProtocolConfig
///   1. org (ro)              - Organization
///   2. asset (wr)            - Asset
///   3. buyout_offer (wr)     - BuyoutOffer PDA to create
///   4. accepted_mint (ro)    - SPL Token mint
///   5. buyer (signer)        - The buyer proposing the buyout
///   6. payer (signer, wr)    - Pays for account creation
///   7. system_program
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    let [
        config,
        org_account,
        asset_account,
        buyout_offer_account,
        accepted_mint,
        buyer,
        payer,
        system_program,
    ] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Parse instruction data (84 bytes)
    let price_per_share = read_u64(data, 0, "price_per_share")?;
    let is_council_buyout = read_u8(data, 8, "is_council_buyout")?;
    let treasury_disposition = read_u8(data, 9, "treasury_disposition")?;
    let broker = read_bytes32(data, 10, "broker")?;
    let broker_bps = read_u16(data, 42, "broker_bps")?;
    let terms_hash = read_bytes32(data, 44, "terms_hash")?;
    let expiry = read_i64(data, 76, "expiry")?;

    // Validate treasury_disposition (0-3)
    if treasury_disposition > 3 {
        pinocchio_log::log!("treasury_disposition: {}", treasury_disposition);
        return Err(TokenizerError::BuyoutInvalidTreasuryDisposition.into());
    }

    // Validate broker
    let zero_key = [0u8; 32];
    if broker != zero_key {
        // Broker is set: bps must be > 0 and <= 1000
        if broker_bps == 0 || broker_bps > 1000 {
            pinocchio_log::log!("broker_bps: {} (must be 1-1000 when broker set)", broker_bps);
            return Err(TokenizerError::BuyoutBrokerBpsTooHigh.into());
        }
        // Broker must not be the buyer
        if &broker == buyer.address().as_array() {
            pinocchio_log::log!("broker == buyer ({})", Pk(buyer.address().as_array()));
            return Err(TokenizerError::BuyoutBrokerIsBuyer.into());
        }
    } else {
        // Broker is zero: bps must be 0
        if broker_bps != 0 {
            pinocchio_log::log!("broker_bps: {} (must be 0 when broker is zero)", broker_bps);
            return Err(TokenizerError::BuyoutBrokerBpsTooHigh.into());
        }
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

    // Asset must be active
    if asset.status() != AssetStatus::Active {
        pinocchio_log::log!("asset.status: {}", asset.status);
        return Err(TokenizerError::BuyoutAssetNotActive.into());
    }

    // Asset must have governance (native_treasury != zero)
    if asset.native_treasury == zero_key {
        pinocchio_log::log!("asset has no governance (native_treasury is zero)");
        return Err(TokenizerError::BuyoutNoGovernance.into());
    }

    // No unminted succeeded rounds
    if asset.unminted_succeeded_rounds != 0 {
        pinocchio_log::log!("unminted_succeeded_rounds: {}", asset.unminted_succeeded_rounds);
        return Err(TokenizerError::BuyoutUnmintedSharesExist.into());
    }

    // No existing active buyout
    if asset.active_buyout != zero_key {
        pinocchio_log::log!("active_buyout already set: {}", Pk(&asset.active_buyout));
        return Err(TokenizerError::BuyoutActiveBuyoutExists.into());
    }

    // Price must be at least 110% of asset price_per_share (10% premium floor)
    let min_price = (asset.price_per_share as u128)
        .checked_mul(110)
        .and_then(|v| v.checked_div(100))
        .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())? as u64;
    if price_per_share < min_price {
        pinocchio_log::log!("price_per_share: {} < min {}", price_per_share, min_price);
        return Err(TokenizerError::BuyoutPriceTooLow.into());
    }

    // Accepted mint must match asset
    if &asset.accepted_mint != accepted_mint.address().as_array() {
        pinocchio_log::log!("accepted_mint: expected {}, got {}", Pk(&asset.accepted_mint), Pk(accepted_mint.address().as_array()));
        return Err(TokenizerError::InvalidMint.into());
    }

    // Verify asset belongs to this org
    if &asset.organization != org_account.address().as_array() {
        pinocchio_log::log!("asset.organization: expected {}, got {}", Pk(org_account.address().as_array()), Pk(&asset.organization));
        return Err(TokenizerError::Unauthorized.into());
    }

    let asset_id = asset.id;
    let asset_bump = asset.bump;
    let minted_shares = asset.minted_shares;
    drop(asset_ref);

    require_pda_with_bump(
        asset_account,
        &[ASSET_SEED, org_account.address().as_ref(), &asset_id.to_le_bytes(), &[asset_bump]],
        program_id,
        "asset_account",
    )?;

    // Validate signers & writable
    require_signer(buyer, "buyer")?;
    require_signer(payer, "payer")?;
    require_writable(payer, "payer")?;
    require_writable(buyout_offer_account, "buyout_offer_account")?;
    require_system_program(system_program)?;

    // Validate expiry is in the future
    let clock = Clock::get()?;
    if expiry <= clock.unix_timestamp {
        pinocchio_log::log!("expiry: {} <= now {}", expiry, clock.unix_timestamp);
        return Err(TokenizerError::BuyoutExpired.into());
    }

    // Validate buyout_offer PDA
    let offer_bump = require_pda(
        buyout_offer_account,
        &[BUYOUT_OFFER_SEED, asset_account.address().as_ref(), buyer.address().as_ref()],
        program_id,
        "buyout_offer_account",
    )?;

    // Buyout offer must not already exist
    if buyout_offer_account.data_len() > 0 {
        return Err(TokenizerError::BuyoutAlreadyExists.into());
    }

    // 1. Create BuyoutOffer PDA account
    let offer_bump_bytes = [offer_bump];
    let offer_seeds = [
        Seed::from(BUYOUT_OFFER_SEED),
        Seed::from(asset_account.address().as_ref()),
        Seed::from(buyer.address().as_ref()),
        Seed::from(&offer_bump_bytes),
    ];
    let offer_signer = Signer::from(&offer_seeds);

    CreateAccount {
        from: payer,
        to: buyout_offer_account,
        lamports: pinocchio::sysvars::rent::Rent::get()
            .map(|r| r.try_minimum_balance(BuyoutOffer::LEN).unwrap_or(0))
            .unwrap_or(0),
        space: BuyoutOffer::LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[offer_signer])?;

    // 2. Initialize BuyoutOffer state
    let mut offer_data = buyout_offer_account.try_borrow_mut()?;
    let offer = unsafe { BuyoutOffer::load_mut(&mut offer_data) };

    offer.account_key = AccountKey::BuyoutOffer as u8;
    offer.version = 1;
    offer.buyer = buyer.address().to_bytes();
    offer.asset = asset_account.address().to_bytes();
    offer.price_per_share = price_per_share;
    offer.accepted_mint = accepted_mint.address().to_bytes();
    offer.escrow = zero_key;
    offer.treasury_disposition = treasury_disposition;
    offer.terms_hash = terms_hash;
    offer.broker = broker;
    offer.broker_bps = broker_bps;
    offer.broker_amount = 0;
    offer.minted_shares = minted_shares;
    offer.shares_settled = 0;
    offer.treasury_amount = 0;
    offer.status = BuyoutStatus::Pending as u8;
    offer.is_council_buyout = is_council_buyout;
    offer.expires_at = expiry;
    offer.created_at = clock.unix_timestamp;
    offer.updated_at = clock.unix_timestamp;
    offer.bump = offer_bump;
    offer.rent_payer = payer.address().to_bytes();
    drop(offer_data);

    // 3. Set asset.active_buyout to the buyout offer key
    let mut asset_mut = asset_account.try_borrow_mut()?;
    let asset = unsafe { Asset::load_mut(&mut asset_mut) };
    asset.active_buyout = buyout_offer_account.address().to_bytes();
    asset.updated_at = clock.unix_timestamp;

    Ok(())
}
