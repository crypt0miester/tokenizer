use pinocchio::{
    cpi::Seed,
    error::ProgramError,
    AccountView,
    Address,
    ProgramResult,
};
use crate::{
    error::TokenizerError,
    state::{
        asset_token::AssetToken,
        offer::Offer,
        validate_account_key, AccountKey, OfferStatus,
        ASSET_TOKEN_SEED, OFFER_ESCROW_SEED, OFFER_SEED,
    },
    utils::{spl_transfer_signed, close_token_account_signed, Pk},
    validation::{
        close_account, create_ata_if_needed, require_ata_program, require_owner,
        require_pda_with_bump, require_signer, require_system_program, require_token_program,
        require_writable,
    },
};

/// Seller rejects an offer, refunding buyer.
///
/// Accounts:
///   0. asset_token     — read
///   1. offer           — writable
///   2. escrow          — writable
///   3. buyer_token_acc — writable
///   4. seller          — signer
///   5. buyer
///   6. accepted_mint
///   7. system_program
///   8. token_program
///   9. ata_program
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    _data: &[u8],
) -> ProgramResult {
    let [
        asset_token_account,
        offer_account,
        escrow,
        buyer_token_acc,
        seller,
        buyer,
        accepted_mint,
        system_program,
        token_program,
        ata_program,
    ] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate seller is signer
    require_signer(seller, "seller")?;
    require_writable(seller, "seller")?;
    require_system_program(system_program)?;
    require_token_program(token_program)?;
    require_ata_program(ata_program)?;

    // Validate asset_token
    require_owner(asset_token_account, program_id, "asset_token_account")?;
    let at_ref = asset_token_account.try_borrow()?;
    validate_account_key(&at_ref, AccountKey::AssetToken)?;
    let at = unsafe { AssetToken::load(&at_ref) };

    // Verify seller owns token
    if &at.owner != seller.address().as_array() {
        pinocchio_log::log!("at.owner: expected {}, got {}", Pk(&at.owner), Pk(seller.address().as_array()));
        return Err(TokenizerError::NotTokenOwner.into());
    }

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

    // Validate offer
    require_owner(offer_account, program_id, "offer_account")?;
    require_writable(offer_account, "offer_account")?;
    let offer_ref = offer_account.try_borrow()?;
    validate_account_key(&offer_ref, AccountKey::Offer)?;
    let offer = unsafe { Offer::load(&offer_ref) };

    // Must be active
    if offer.status != OfferStatus::Active as u8 {
        pinocchio_log::log!("offer.status: {}", offer.status);
        return Err(TokenizerError::OfferNotActive.into());
    }

    // Verify offer targets this asset_token
    if &offer.asset_token != asset_token_account.address().as_array() {
        pinocchio_log::log!("offer.asset_token: expected {}, got {}", Pk(&offer.asset_token), Pk(asset_token_account.address().as_array()));
        return Err(TokenizerError::OfferTokenMismatch.into());
    }

    // Verify escrow matches
    if &offer.escrow != escrow.address().as_array() {
        pinocchio_log::log!("offer.escrow: expected {}, got {}", Pk(&offer.escrow), Pk(escrow.address().as_array()));
        return Err(TokenizerError::EscrowMismatch.into());
    }

    let total_deposited = offer.total_deposited;
    let offer_bump = offer.bump;
    let escrow_bump = offer.escrow_bump;
    let buyer_key = offer.buyer;
    let offer_mint = offer.accepted_mint;
    drop(offer_ref);

    // Validate buyer matches offer
    if buyer.address().as_array() != &buyer_key {
        pinocchio_log::log!("buyer: expected {}, got {}", Pk(&buyer_key), Pk(buyer.address().as_array()));
        return Err(TokenizerError::BuyerMismatch.into());
    }

    // Validate accepted_mint matches offer
    if accepted_mint.address().as_array() != &offer_mint {
        pinocchio_log::log!("accepted_mint: expected {}, got {}", Pk(&offer_mint), Pk(accepted_mint.address().as_array()));
        return Err(TokenizerError::InvalidMint.into());
    }

    // Validate offer PDA
    require_pda_with_bump(
        offer_account,
        &[OFFER_SEED, asset_token_account.address().as_ref(), &buyer_key, &[offer_bump]],
        program_id,
        "offer_account",
    )?;

    // Validate escrow PDA
    require_pda_with_bump(
        escrow,
        &[OFFER_ESCROW_SEED, offer_account.address().as_ref(), &[escrow_bump]],
        program_id,
        "escrow",
    )?;

    require_writable(escrow, "escrow")?;
    require_writable(buyer_token_acc, "buyer_token_acc")?;

    // Create buyer ATA if needed
    create_ata_if_needed(seller, buyer_token_acc, buyer, accepted_mint, system_program, token_program)?;

    // Transfer escrow → buyer (offer PDA signs)
    let offer_bump_bytes = [offer_bump];
    let offer_seeds = [
        Seed::from(OFFER_SEED),
        Seed::from(asset_token_account.address().as_ref()),
        Seed::from(buyer_key.as_ref()),
        Seed::from(&offer_bump_bytes),
    ];
    spl_transfer_signed(escrow, buyer_token_acc, offer_account, total_deposited, &offer_mint, &offer_seeds)?;

    // Close escrow token account — rent SOL to seller
    let offer_seeds2 = [
        Seed::from(OFFER_SEED),
        Seed::from(asset_token_account.address().as_ref()),
        Seed::from(buyer_key.as_ref()),
        Seed::from(&offer_bump_bytes),
    ];
    close_token_account_signed(escrow, seller, offer_account, &offer_seeds2)?;

    // Close offer account — rent SOL to seller
    close_account(offer_account, seller)?;

    Ok(())
}
