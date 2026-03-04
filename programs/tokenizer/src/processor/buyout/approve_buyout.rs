use pinocchio::{
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    AccountView, Address, ProgramResult,
};
use crate::{
    error::TokenizerError,
    state::{
        asset::Asset,
        buyout_offer::BuyoutOffer,
        organization::Organization,
        validate_account_key, AccountKey, BuyoutStatus,
        ASSET_SEED, BUYOUT_OFFER_SEED, ORGANIZATION_SEED,
    },
    utils::Pk,
    validation::{
        require_owner, require_pda_with_bump, require_signer, require_writable,
    },
};

/// Approve a funded buyout via organization authority (simplified governance).
///
/// In the full implementation this would use sysvar introspection to verify
/// a governance proposal executed this instruction. For now we require the
/// org authority to sign directly.
///
/// Accounts:
///   0. buyout_offer (writable)  -- BuyoutOffer PDA
///   1. asset_account (read)     -- Asset PDA
///   2. org_account (read)       -- Organization PDA
///   3. authority (signer)       -- org authority
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    _data: &[u8],
) -> ProgramResult {
    let [
        buyout_offer_account,
        asset_account,
        org_account,
        authority,
    ] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate buyout offer───
    require_owner(buyout_offer_account, program_id, "buyout_offer_account")?;
    require_writable(buyout_offer_account, "buyout_offer_account")?;
    let bo_ref = buyout_offer_account.try_borrow()?;
    validate_account_key(&bo_ref, AccountKey::BuyoutOffer)?;
    let bo = unsafe { BuyoutOffer::load(&bo_ref) };

    // Must be Funded
    if bo.status != BuyoutStatus::Funded as u8 {
        pinocchio_log::log!("buyout.status: {}", bo.status);
        return Err(TokenizerError::BuyoutNotFunded.into());
    }

    // Must not be expired
    let clock = Clock::get()?;
    if bo.expires_at != 0 && clock.unix_timestamp >= bo.expires_at {
        pinocchio_log::log!("buyout expired: now={}, expires_at={}", clock.unix_timestamp, bo.expires_at);
        return Err(TokenizerError::BuyoutExpired.into());
    }

    let bo_asset = bo.asset;
    let bo_buyer = bo.buyer;
    let bo_bump = bo.bump;
    let bo_minted_shares = bo.minted_shares;
    let bo_price_per_share = bo.price_per_share;
    let bo_broker = bo.broker;
    let bo_broker_bps = bo.broker_bps;
    drop(bo_ref);

    // Validate buyout offer PDA
    require_pda_with_bump(
        buyout_offer_account,
        &[BUYOUT_OFFER_SEED, &bo_asset, &bo_buyer, &[bo_bump]],
        program_id,
        "buyout_offer_account",
    )?;

    // Validate asset──
    require_owner(asset_account, program_id, "asset_account")?;
    let asset_ref = asset_account.try_borrow()?;
    validate_account_key(&asset_ref, AccountKey::Asset)?;
    let asset = unsafe { Asset::load(&asset_ref) };

    // Buyout offer must reference this asset
    if asset_account.address().as_array() != &bo_asset {
        pinocchio_log::log!("bo.asset: expected {}, got {}", Pk(&bo_asset), Pk(asset_account.address().as_array()));
        return Err(TokenizerError::TokenAssetMismatch.into());
    }

    // Must be the active buyout on the asset
    if &asset.active_buyout != buyout_offer_account.address().as_array() {
        pinocchio_log::log!("asset.active_buyout: expected {}, got {}", Pk(buyout_offer_account.address().as_array()), Pk(&asset.active_buyout));
        return Err(TokenizerError::BuyoutActiveBuyoutExists.into());
    }

    let org_key = asset.organization;
    let asset_id = asset.id;
    let asset_bump = asset.bump;
    drop(asset_ref);

    // Validate asset PDA
    require_pda_with_bump(
        asset_account,
        &[ASSET_SEED, &org_key, &asset_id.to_le_bytes(), &[asset_bump]],
        program_id,
        "asset_account",
    )?;

    // Validate organization───
    require_owner(org_account, program_id, "org_account")?;
    let org_ref = org_account.try_borrow()?;
    validate_account_key(&org_ref, AccountKey::Organization)?;
    let org = unsafe { Organization::load(&org_ref) };

    if org_account.address().as_array() != &org_key {
        pinocchio_log::log!("org_account: expected {}, got {}", Pk(&org_key), Pk(org_account.address().as_array()));
        return Err(TokenizerError::TokenAssetMismatch.into());
    }

    let org_authority = org.authority;
    let org_id = org.id;
    let org_bump = org.bump;
    drop(org_ref);

    // Validate org PDA
    require_pda_with_bump(
        org_account,
        &[ORGANIZATION_SEED, &org_id.to_le_bytes(), &[org_bump]],
        program_id,
        "org_account",
    )?;

    // Validate authority──
    require_signer(authority, "authority")?;
    if authority.address().as_array() != &org_authority {
        pinocchio_log::log!("org.authority: expected {}, got {}", Pk(&org_authority), Pk(authority.address().as_array()));
        return Err(TokenizerError::InvalidAuthority.into());
    }

    // Compute broker amount───
    let zero_key = [0u8; 32];
    let has_broker = bo_broker != zero_key;
    let broker_amount = if has_broker {
        (bo_minted_shares as u128)
            .checked_mul(bo_price_per_share as u128)
            .and_then(|v| v.checked_mul(bo_broker_bps as u128))
            .and_then(|v| v.checked_div(10_000))
            .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())? as u64
    } else {
        0u64
    };

    // Update buyout offer state───
    let mut bo_mut = buyout_offer_account.try_borrow_mut()?;
    let bo_w = unsafe { BuyoutOffer::load_mut(&mut bo_mut) };
    bo_w.status = BuyoutStatus::Approved as u8;
    bo_w.treasury_amount = 0; // Simplified: full impl would be escrow_balance - (minted_shares * price_per_share)
    bo_w.broker_amount = broker_amount;
    bo_w.updated_at = clock.unix_timestamp;

    Ok(())
}
