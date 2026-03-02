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
        offer::Offer,
        validate_account_key, AccountKey, OfferStatus,
        OFFER_ESCROW_SEED, OFFER_SEED,
    },
    utils::{spl_transfer_signed, close_token_account_signed, Pk},
    validation::{
        close_account, create_ata_if_needed, require_ata_program, require_owner,
        require_pda_with_bump, require_signer, require_system_program, require_token_program,
        require_writable,
    },
};

/// Cancel an offer and refund buyer.
///
/// Accounts:
///   0. offer           — writable
///   1. escrow          — writable
///   2. buyer_token_acc — writable
///   3. buyer           — signer
///   4. accepted_mint
///   5. system_program
///   6. token_program
///   7. ata_program
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    _data: &[u8],
) -> ProgramResult {
    let [
        offer_account,
        escrow,
        buyer_token_acc,
        buyer,
        accepted_mint,
        system_program,
        token_program,
        ata_program,
    ] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate buyer is signer
    require_signer(buyer, "buyer")?;
    require_writable(buyer, "buyer")?;
    require_system_program(system_program)?;
    require_token_program(token_program)?;
    require_ata_program(ata_program)?;

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

    // Verify buyer matches
    if &offer.buyer != buyer.address().as_array() {
        pinocchio_log::log!("offer.buyer: expected {}, got {}", Pk(&offer.buyer), Pk(buyer.address().as_array()));
        return Err(TokenizerError::InvalidBuyer.into());
    }

    // Verify escrow matches
    if &offer.escrow != escrow.address().as_array() {
        pinocchio_log::log!("offer.escrow: expected {}, got {}", Pk(&offer.escrow), Pk(escrow.address().as_array()));
        return Err(TokenizerError::EscrowMismatch.into());
    }

    let total_deposited = offer.total_deposited;
    let offer_bump = offer.bump;
    let escrow_bump = offer.escrow_bump;
    let asset_token_key = offer.asset_token;
    let offer_mint = offer.accepted_mint;
    drop(offer_ref);

    // Validate accepted_mint matches offer
    if accepted_mint.address().as_array() != &offer_mint {
        pinocchio_log::log!("accepted_mint: expected {}, got {}", Pk(&offer_mint), Pk(accepted_mint.address().as_array()));
        return Err(TokenizerError::InvalidMint.into());
    }

    // Validate offer PDA
    require_pda_with_bump(
        offer_account,
        &[OFFER_SEED, &asset_token_key, buyer.address().as_ref(), &[offer_bump]],
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
    create_ata_if_needed(buyer, buyer_token_acc, buyer, accepted_mint, system_program, token_program)?;

    // Transfer escrow → buyer (offer PDA signs)
    let offer_bump_bytes = [offer_bump];
    let offer_seeds = [
        Seed::from(OFFER_SEED),
        Seed::from(asset_token_key.as_ref()),
        Seed::from(buyer.address().as_ref()),
        Seed::from(&offer_bump_bytes),
    ];
    spl_transfer_signed(escrow, buyer_token_acc, offer_account, total_deposited, &offer_mint, &offer_seeds)?;

    // Close escrow token account — rent SOL to buyer
    let offer_seeds2 = [
        Seed::from(OFFER_SEED),
        Seed::from(asset_token_key.as_ref()),
        Seed::from(buyer.address().as_ref()),
        Seed::from(&offer_bump_bytes),
    ];
    close_token_account_signed(escrow, buyer, offer_account, &offer_seeds2)?;

    // Close offer account — rent SOL to buyer
    close_account(offer_account, buyer)?;

    Ok(())
}
