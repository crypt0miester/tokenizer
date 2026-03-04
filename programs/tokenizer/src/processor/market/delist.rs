use pinocchio::{
    error::ProgramError,
    AccountView,
    Address,
    ProgramResult,
};

use crate::{
    error::TokenizerError,
    state::{
        asset_token::AssetToken,
        listing::Listing,
        validate_account_key, AccountKey, ListingStatus,
        ASSET_TOKEN_SEED, LISTING_SEED,
    },
    utils::Pk,
    validation::{
        close_account, require_owner, require_pda_with_bump, require_rent_destination,
        require_signer, require_system_program, require_writable,
    },
};

/// Cancel a listing.
///
/// Accounts:
///   0. asset_token  — writable
///   1. listing      — writable
///   2. seller       — signer
///   3. system_program
///   4. rent_destination — writable (original rent payer)
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    _data: &[u8],
) -> ProgramResult {
    let [
        asset_token_account,
        listing_account,
        seller,
        system_program,
        rent_destination,
    ] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate seller is signer
    require_signer(seller, "seller")?;
    require_writable(seller, "seller")?;
    require_system_program(system_program)?;

    // Validate listing
    require_owner(listing_account, program_id, "listing_account")?;
    require_writable(listing_account, "listing_account")?;
    let listing_ref = listing_account.try_borrow()?;
    validate_account_key(&listing_ref, AccountKey::Listing)?;
    let listing = unsafe { Listing::load(&listing_ref) };

    // Must be active
    if listing.status != ListingStatus::Active as u8 {
        pinocchio_log::log!("listing.status: {}", listing.status);
        return Err(TokenizerError::ListingNotActive.into());
    }

    // Verify seller matches
    if &listing.seller != seller.address().as_array() {
        pinocchio_log::log!("listing.seller: expected {}, got {}", Pk(&listing.seller), Pk(seller.address().as_array()));
        return Err(TokenizerError::NotTokenOwner.into());
    }

    let listing_asset_token = listing.asset_token;
    let listing_bump = listing.bump;
    let listing_rent_payer = listing.rent_payer;
    drop(listing_ref);

    // Validate asset_token
    require_owner(asset_token_account, program_id, "asset_token_account")?;
    require_writable(asset_token_account, "asset_token_account")?;

    // Verify listing references this asset_token
    if asset_token_account.address().as_array() != &listing_asset_token {
        pinocchio_log::log!("listing.asset_token: expected {}, got {}", Pk(&listing_asset_token), Pk(asset_token_account.address().as_array()));
        return Err(TokenizerError::ListingTokenMismatch.into());
    }

    let at_ref = asset_token_account.try_borrow()?;
    validate_account_key(&at_ref, AccountKey::AssetToken)?;
    let at = unsafe { AssetToken::load(&at_ref) };
    let token_index = at.token_index;
    let asset_key = at.asset;
    let at_bump = at.bump;
    drop(at_ref);

    // Validate asset_token PDA
    require_pda_with_bump(
        asset_token_account,
        &[ASSET_TOKEN_SEED, &asset_key, &token_index.to_le_bytes(), &[at_bump]],
        program_id,
        "asset_token_account",
    )?;

    // Validate listing PDA
    require_pda_with_bump(
        listing_account,
        &[LISTING_SEED, asset_token_account.address().as_ref(), &[listing_bump]],
        program_id,
        "listing_account",
    )?;

    // Validate rent_destination
    require_rent_destination(rent_destination, &listing_rent_payer)?;

    // Unmark asset_token as listed
    let mut at_data = asset_token_account.try_borrow_mut()?;
    let at = unsafe { AssetToken::load_mut(&mut at_data) };
    at.is_listed = 0;
    drop(at_data);

    // Close listing account — rent SOL to original payer
    close_account(listing_account, rent_destination)?;

    Ok(())
}
