use pinocchio::{
    cpi::{Seed, Signer},
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    AccountView, Address, ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;
use pinocchio_token::instructions::InitializeAccount3;

use crate::{
    error::TokenizerError,
    state::{
        asset::Asset,
        buyout_offer::BuyoutOffer,
        validate_account_key, AccountKey, BuyoutStatus,
        ASSET_SEED, BUYOUT_ESCROW_SEED, BUYOUT_OFFER_SEED,
    },
    utils::{spl_transfer, Pk},
    validation::{
        require_owner, require_pda, require_pda_with_bump, require_signer,
        require_system_program, require_token_program, require_writable,
    },
};

/// SPL Token account size (165 bytes).
const TOKEN_ACCOUNT_LEN: usize = 165;

/// 14 days in seconds.
const FUNDED_EXPIRY_SECS: i64 = 1_209_600;

/// Fund a buyout offer: create an escrow token account and deposit
/// `minted_shares * price_per_share` from the buyer.
///
/// Accounts:
///   0. buyout_offer    — writable (BuyoutOffer PDA)
///   1. asset           — read (Asset PDA, for validation)
///   2. escrow          — writable, init (token account to create)
///   3. buyer_token_acc — writable (buyer's SPL token account)
///   4. accepted_mint   — read (SPL Token mint)
///   5. buyer           — signer (must match buyout_offer.buyer)
///   6. payer           — signer, writable
///   7. system_program
///   8. token_program
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    _data: &[u8],
) -> ProgramResult {
    let [
        buyout_offer_account,
        asset_account,
        escrow,
        buyer_token_acc,
        accepted_mint,
        buyer,
        payer,
        system_program,
        token_program,
    ] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate signers & writable

    require_signer(buyer, "buyer")?;
    require_signer(payer, "payer")?;
    require_writable(buyout_offer_account, "buyout_offer")?;
    require_writable(escrow, "escrow")?;
    require_writable(buyer_token_acc, "buyer_token_acc")?;
    require_writable(payer, "payer")?;
    require_system_program(system_program)?;
    require_token_program(token_program)?;

    // Validate asset

    require_owner(asset_account, program_id, "asset")?;
    let asset_ref = asset_account.try_borrow()?;
    validate_account_key(&asset_ref, AccountKey::Asset)?;
    let asset = unsafe { Asset::load(&asset_ref) };

    let org_key = asset.organization;
    let asset_id = asset.id;
    let asset_bump = asset.bump;
    let minted_shares = asset.minted_shares;
    drop(asset_ref);

    require_pda_with_bump(
        asset_account,
        &[ASSET_SEED, &org_key, &asset_id.to_le_bytes(), &[asset_bump]],
        program_id,
        "asset",
    )?;

    // Validate buyout offer─

    require_owner(buyout_offer_account, program_id, "buyout_offer")?;
    let bo_ref = buyout_offer_account.try_borrow()?;
    validate_account_key(&bo_ref, AccountKey::BuyoutOffer)?;
    let bo = unsafe { BuyoutOffer::load(&bo_ref) };

    // Status must be Pending
    if bo.status != BuyoutStatus::Pending as u8 {
        pinocchio_log::log!("buyout_offer.status: {}", bo.status);
        return Err(TokenizerError::BuyoutNotPending.into());
    }

    // Only external buyouts need funding
    if bo.is_council_buyout != 0 {
        pinocchio_log::log!("council buyout does not need funding");
        return Err(TokenizerError::BuyoutInvalidFeeMode.into());
    }

    // Caller must be the buyer
    if &bo.buyer != buyer.address().as_array() {
        pinocchio_log::log!("buyer: expected {}, got {}", Pk(&bo.buyer), Pk(buyer.address().as_array()));
        return Err(TokenizerError::BuyoutNotBuyer.into());
    }

    // Verify asset matches
    if &bo.asset != asset_account.address().as_array() {
        pinocchio_log::log!("buyout_offer.asset mismatch");
        return Err(TokenizerError::BuyoutAssetNotActive.into());
    }

    // Not expired
    let clock = Clock::get()?;
    if clock.unix_timestamp >= bo.expires_at {
        pinocchio_log::log!("buyout expired: now={}, expires_at={}", clock.unix_timestamp, bo.expires_at);
        return Err(TokenizerError::BuyoutExpired.into());
    }

    // Verify accepted mint matches
    if &bo.accepted_mint != accepted_mint.address().as_array() {
        pinocchio_log::log!("accepted_mint mismatch");
        return Err(TokenizerError::InvalidMint.into());
    }

    let price_per_share = bo.price_per_share;
    let bo_bump = bo.bump;
    let buyer_key = bo.buyer;
    drop(bo_ref);

    // Validate buyout offer PDA
    require_pda_with_bump(
        buyout_offer_account,
        &[BUYOUT_OFFER_SEED, asset_account.address().as_ref(), &buyer_key, &[bo_bump]],
        program_id,
        "buyout_offer",
    )?;

    // Calculate total deposit───

    let total_deposit = u64::try_from(
        (minted_shares as u128)
            .checked_mul(price_per_share as u128)
            .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?
    ).map_err(|_| -> ProgramError { TokenizerError::MathOverflow.into() })?;

    // Validate escrow PDA───

    let escrow_bump = require_pda(
        escrow,
        &[BUYOUT_ESCROW_SEED, buyout_offer_account.address().as_ref()],
        program_id,
        "escrow",
    )?;

    // 1. Create escrow token account─

    let escrow_bump_bytes = [escrow_bump];
    let escrow_seeds = [
        Seed::from(BUYOUT_ESCROW_SEED),
        Seed::from(buyout_offer_account.address().as_ref()),
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

    // 2. Initialize escrow as token account (authority = buyout_offer PDA)

    InitializeAccount3 {
        account: escrow,
        mint: accepted_mint,
        owner: buyout_offer_account.address(),
    }
    .invoke()?;

    // 3. Transfer deposit from buyer to escrow

    spl_transfer(buyer_token_acc, escrow, buyer, total_deposit, accepted_mint.address().as_array())?;

    // 4. Update buyout offer state

    let mut bo_data = buyout_offer_account.try_borrow_mut()?;
    let bo_mut = unsafe { BuyoutOffer::load_mut(&mut bo_data) };

    bo_mut.escrow = escrow.address().to_bytes();
    bo_mut.minted_shares = minted_shares;
    bo_mut.status = BuyoutStatus::Funded as u8;
    bo_mut.expires_at = clock.unix_timestamp.saturating_add(FUNDED_EXPIRY_SECS);
    bo_mut.updated_at = clock.unix_timestamp;

    Ok(())
}
