use pinocchio::{
    cpi::Seed,
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    AccountView, Address, ProgramResult,
};

use crate::{
    error::TokenizerError,
    state::{
        asset::Asset,
        buyout_offer::BuyoutOffer,
        validate_account_key, AccountKey, BuyoutStatus,
        ASSET_SEED, BUYOUT_ESCROW_SEED, BUYOUT_OFFER_SEED,
    },
    utils::{spl_transfer_signed, close_token_account_signed, Pk},
    validation::{
        close_account, require_owner, require_pda_with_bump, require_signer,
        require_system_program, require_token_program, require_writable,
    },
};

/// Cancel a buyout offer. Two cancel paths:
///
/// (a) Buyer voluntary: signer == buyer, status Pending/Funded/Approved
/// (b) Expired: Clock::now() >= expires_at, permissionless
///
/// If the offer was funded, the escrow is refunded to the buyer and closed.
///
/// Accounts:
///   0. buyout_offer    — writable (BuyoutOffer PDA)
///   1. asset           — writable (Asset PDA, to clear active_buyout)
///   2. buyer           — signer (optional for expired cancels)
///   3. system_program
/// For funded offers, also:
///   4. escrow          — writable (escrow token account)
///   5. buyer_token_acc — writable (buyer's token account for refund)
///   6. token_program
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    _data: &[u8],
) -> ProgramResult {
    // We need at least 4 accounts; funded offers need 7.
    if accounts.len() < 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let buyout_offer_account = &accounts[0];
    let asset_account = &accounts[1];
    let buyer_account = &accounts[2];
    let system_program = &accounts[3];

    // ── Validate basic accounts ──────────────────────────────────────────

    require_writable(buyout_offer_account, "buyout_offer")?;
    require_writable(asset_account, "asset")?;
    require_system_program(system_program)?;

    // ── Validate asset ───────────────────────────────────────────────────

    require_owner(asset_account, program_id, "asset")?;
    let asset_ref = asset_account.try_borrow()?;
    validate_account_key(&asset_ref, AccountKey::Asset)?;
    let asset = unsafe { Asset::load(&asset_ref) };

    let org_key = asset.organization;
    let asset_id = asset.id;
    let asset_bump = asset.bump;
    drop(asset_ref);

    require_pda_with_bump(
        asset_account,
        &[ASSET_SEED, &org_key, &asset_id.to_le_bytes(), &[asset_bump]],
        program_id,
        "asset",
    )?;

    // ── Validate buyout offer ────────────────────────────────────────────

    require_owner(buyout_offer_account, program_id, "buyout_offer")?;
    let bo_ref = buyout_offer_account.try_borrow()?;
    validate_account_key(&bo_ref, AccountKey::BuyoutOffer)?;
    let bo = unsafe { BuyoutOffer::load(&bo_ref) };

    // Status must not be terminal (Completed or Cancelled)
    let status = bo.status;
    if status == BuyoutStatus::Completed as u8 || status == BuyoutStatus::Cancelled as u8 {
        pinocchio_log::log!("buyout_offer.status: {} (terminal)", status);
        return Err(TokenizerError::BuyoutNotPending.into());
    }

    // Verify asset matches
    if &bo.asset != asset_account.address().as_array() {
        pinocchio_log::log!("buyout_offer.asset mismatch");
        return Err(TokenizerError::BuyoutAssetNotActive.into());
    }

    let buyer_key = bo.buyer;
    let bo_bump = bo.bump;
    let expires_at = bo.expires_at;
    let escrow_key = bo.escrow;
    let accepted_mint_key = bo.accepted_mint;
    let is_funded = status == BuyoutStatus::Funded as u8
        || status == BuyoutStatus::Approved as u8;
    drop(bo_ref);

    // Validate buyout offer PDA
    require_pda_with_bump(
        buyout_offer_account,
        &[BUYOUT_OFFER_SEED, asset_account.address().as_ref(), &buyer_key, &[bo_bump]],
        program_id,
        "buyout_offer",
    )?;

    // ── Determine cancel path ────────────────────────────────────────────

    let clock = Clock::get()?;
    let is_expired = clock.unix_timestamp >= expires_at;

    if is_expired {
        // Path (b): Expired — permissionless, no signer check needed.
    } else {
        // Path (a): Buyer voluntary — must be signed by the buyer.
        require_signer(buyer_account, "buyer")?;
        if buyer_account.address().as_array() != &buyer_key {
            pinocchio_log::log!("buyer: expected {}, got {}", Pk(&buyer_key), Pk(buyer_account.address().as_array()));
            return Err(TokenizerError::BuyoutNotBuyer.into());
        }
    }

    // ── Refund escrow if funded ──────────────────────────────────────────

    if is_funded {
        if accounts.len() < 7 {
            return Err(ProgramError::NotEnoughAccountKeys);
        }

        let escrow = &accounts[4];
        let buyer_token_acc = &accounts[5];
        let token_program = &accounts[6];

        require_writable(escrow, "escrow")?;
        require_writable(buyer_token_acc, "buyer_token_acc")?;
        require_token_program(token_program)?;

        // Verify escrow matches the stored key
        if escrow.address().as_array() != &escrow_key {
            pinocchio_log::log!("escrow: expected {}, got {}", Pk(&escrow_key), Pk(escrow.address().as_array()));
            return Err(TokenizerError::EscrowMismatch.into());
        }

        // Validate escrow PDA
        require_pda_with_bump(
            escrow,
            &[BUYOUT_ESCROW_SEED, buyout_offer_account.address().as_ref(), &[
                // Derive the escrow bump from its PDA seeds.
                // Since we already validated the escrow address matches the stored key,
                // and the escrow was created as a PDA, we can derive it.
                {
                    let (_, bump) = Address::find_program_address(
                        &[BUYOUT_ESCROW_SEED, buyout_offer_account.address().as_ref()],
                        program_id,
                    );
                    bump
                }
            ]],
            program_id,
            "escrow",
        )?;

        // Read escrow balance for the refund transfer.
        // SPL Token account layout: [64..72] = amount (u64 LE)
        let escrow_balance = {
            let escrow_data = escrow.try_borrow()?;
            if escrow_data.len() < 72 {
                return Err(TokenizerError::TokenAccountDataTooShort.into());
            }
            u64::from_le_bytes(escrow_data[64..72].try_into().unwrap())
        };

        // Build buyout_offer PDA signer seeds for CPI
        let bo_bump_bytes = [bo_bump];
        let bo_seeds = [
            Seed::from(BUYOUT_OFFER_SEED),
            Seed::from(asset_account.address().as_ref()),
            Seed::from(buyer_key.as_ref()),
            Seed::from(&bo_bump_bytes),
        ];

        // Transfer escrow -> buyer_token_acc (buyout_offer PDA signs)
        if escrow_balance > 0 {
            spl_transfer_signed(
                escrow,
                buyer_token_acc,
                buyout_offer_account,
                escrow_balance,
                &accepted_mint_key,
                &bo_seeds,
            )?;
        }

        // Close escrow token account — rent SOL to buyer
        let bo_seeds2 = [
            Seed::from(BUYOUT_OFFER_SEED),
            Seed::from(asset_account.address().as_ref()),
            Seed::from(buyer_key.as_ref()),
            Seed::from(&bo_bump_bytes),
        ];
        close_token_account_signed(escrow, buyer_account, buyout_offer_account, &bo_seeds2)?;
    }

    // ── Update buyout offer → Cancelled ──────────────────────────────────

    {
        let mut bo_data = buyout_offer_account.try_borrow_mut()?;
        let bo_mut = unsafe { BuyoutOffer::load_mut(&mut bo_data) };
        bo_mut.status = BuyoutStatus::Cancelled as u8;
        bo_mut.updated_at = clock.unix_timestamp;
    }

    // ── Clear active_buyout on asset ─────────────────────────────────────

    {
        let mut asset_data = asset_account.try_borrow_mut()?;
        let asset_mut = unsafe { Asset::load_mut(&mut asset_data) };
        asset_mut.active_buyout = [0u8; 32];
        asset_mut.updated_at = clock.unix_timestamp;
    }

    // ── Close buyout offer account — rent SOL to buyer ───────────────────

    close_account(buyout_offer_account, buyer_account)?;

    Ok(())
}
