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
        validate_account_key, AccountKey, AssetStatus, BuyoutStatus,
        ASSET_SEED, BUYOUT_OFFER_SEED,
    },
    utils::Pk,
    validation::{
        require_owner, require_pda_with_bump, require_writable,
    },
};

/// Complete a buyout after all holders have been settled.
///
/// This is permissionless — anyone can call it once all shares are settled
/// and all open distributions are closed.
///
/// Accounts:
///   0. buyout_offer (writable)  -- BuyoutOffer PDA
///   1. asset_account (writable) -- Asset PDA
///   2. buyer (signer, optional) -- Can be permissionless
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    _data: &[u8],
) -> ProgramResult {
    let [
        buyout_offer_account,
        asset_account,
        _buyer,
    ] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate buyout offer───
    require_owner(buyout_offer_account, program_id, "buyout_offer_account")?;
    require_writable(buyout_offer_account, "buyout_offer_account")?;
    let bo_ref = buyout_offer_account.try_borrow()?;
    validate_account_key(&bo_ref, AccountKey::BuyoutOffer)?;
    let bo = unsafe { BuyoutOffer::load(&bo_ref) };

    // Must be Approved
    if bo.status != BuyoutStatus::Approved as u8 {
        pinocchio_log::log!("buyout.status: {}", bo.status);
        return Err(TokenizerError::BuyoutNotApproved.into());
    }

    // All shares must be settled
    if bo.shares_settled != bo.minted_shares {
        pinocchio_log::log!("shares_settled: {}/{}", bo.shares_settled, bo.minted_shares);
        return Err(TokenizerError::BuyoutNotComplete.into());
    }

    let bo_asset = bo.asset;
    let bo_buyer = bo.buyer;
    let bo_bump = bo.bump;
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
    require_writable(asset_account, "asset_account")?;
    let asset_ref = asset_account.try_borrow()?;
    validate_account_key(&asset_ref, AccountKey::Asset)?;
    let asset = unsafe { Asset::load(&asset_ref) };

    // Buyout offer must reference this asset
    if asset_account.address().as_array() != &bo_asset {
        pinocchio_log::log!("bo.asset: expected {}, got {}", Pk(&bo_asset), Pk(asset_account.address().as_array()));
        return Err(TokenizerError::TokenAssetMismatch.into());
    }

    // No open distributions allowed
    if asset.open_distributions != 0 {
        pinocchio_log::log!("asset.open_distributions: {}", asset.open_distributions);
        return Err(TokenizerError::BuyoutOpenDistributions.into());
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

    // Update state
    let clock = Clock::get()?;

    // Update buyout offer: Approved -> Completed
    let mut bo_mut = buyout_offer_account.try_borrow_mut()?;
    let bo_w = unsafe { BuyoutOffer::load_mut(&mut bo_mut) };
    bo_w.status = BuyoutStatus::Completed as u8;
    bo_w.updated_at = clock.unix_timestamp;
    drop(bo_mut);

    // Update asset: status -> Closed, clear active_buyout
    let mut asset_mut = asset_account.try_borrow_mut()?;
    let asset_w = unsafe { Asset::load_mut(&mut asset_mut) };
    asset_w.status = AssetStatus::Closed as u8;
    asset_w.active_buyout = [0u8; 32];
    asset_w.updated_at = clock.unix_timestamp;

    Ok(())
}
