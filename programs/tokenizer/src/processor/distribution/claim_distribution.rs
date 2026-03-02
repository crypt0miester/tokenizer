use pinocchio::{
    cpi::Seed,
    error::ProgramError,
    AccountView,
    Address,
    ProgramResult,
};

use crate::{
    error::TokenizerError,
    utils::{spl_transfer_signed, Pk},
    state::{
        asset::Asset,
        asset_token::AssetToken,
        dividend_distribution::DividendDistribution,
        validate_account_key, AccountKey,
        ASSET_SEED, ASSET_TOKEN_SEED,
        DISTRIBUTION_ESCROW_SEED, DIVIDEND_DISTRIBUTION_SEED,
    },
    validation::{
        create_ata_if_needed, require_ata_program, require_owner, require_pda_with_bump,
        require_signer, require_system_program, require_token_program, require_writable,
    },
};

const FIXED_ACCOUNTS: usize = 8;
const ACCOUNTS_PER_CLAIM: usize = 3;
const MAX_BATCH_SIZE: usize = 14;

/// Permissionless crank: batch-claim dividends for token holders.
///
/// Processes 1–14 claims per transaction. Double-claim prevention via
/// `asset_token.last_claimed_epoch` — no separate ClaimRecord needed
/// since tokens are frozen and can only move through program instructions.
///
/// Instruction data layout:
/// [0] count: u8 — number of claims in this batch (1–14)
///
/// Account layout:
///   Fixed (8):
///     0. distribution   — DividendDistribution (writable, updates shares_claimed)
///     1. escrow         — Escrow token account (writable)
///     2. asset          — Asset (read)
///     3. payer          — Signer, writable
///     4. accepted_mint
///     5. system_program
///     6. token_program
///     7. ata_program
///
///   Per claim (repeated `count` times, 3 accounts each):
///     8 + i*3 + 0. asset_token       — AssetToken (writable, updates last_claimed_epoch)
///     8 + i*3 + 1. holder_token_acc  — Holder's token account (writable)
///     8 + i*3 + 2. holder            — Holder wallet
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    // Parse batch count
    if data.is_empty() {
        return Err(TokenizerError::InstructionDataTooShort.into());
    }
    let count = data[0] as usize;
    if count == 0 || count > MAX_BATCH_SIZE {
        return Err(TokenizerError::InvalidRoundConfig.into());
    }

    let expected_accounts = FIXED_ACCOUNTS + count * ACCOUNTS_PER_CLAIM;
    if accounts.len() < expected_accounts {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    // Extract fixed accounts
    let distribution_account = &accounts[0];
    let escrow = &accounts[1];
    let asset_account = &accounts[2];
    let payer = &accounts[3];
    let accepted_mint = &accounts[4];
    let system_program = &accounts[5];
    let token_program = &accounts[6];
    let ata_program = &accounts[7];

    // ── Validate shared accounts (once) ─────────────────────────────

    // Validate distribution
    require_owner(distribution_account, program_id, "distribution_account")?;
    let dist_ref = distribution_account.try_borrow()?;
    validate_account_key(&dist_ref, AccountKey::DividendDistribution)?;
    let dist = unsafe { DividendDistribution::load(&dist_ref) };

    let dist_asset = dist.asset;
    let dist_epoch = dist.epoch;
    let dist_total_amount = dist.total_amount;
    let dist_total_shares = dist.total_shares;
    let dist_bump = dist.bump;
    let dist_escrow_bump = dist.escrow_bump;
    let dist_mint = dist.accepted_mint;

    if &dist.escrow != escrow.address().as_array() {
        pinocchio_log::log!("dist.escrow: expected {}, got {}", Pk(&dist.escrow), Pk(escrow.address().as_array()));
        return Err(TokenizerError::EscrowMismatch.into());
    }
    drop(dist_ref);

    let epoch_bytes = dist_epoch.to_le_bytes();
    require_pda_with_bump(
        distribution_account,
        &[DIVIDEND_DISTRIBUTION_SEED, &dist_asset, &epoch_bytes, &[dist_bump]],
        program_id,
        "distribution_account",
    )?;

    // Validate asset
    require_owner(asset_account, program_id, "asset_account")?;
    if asset_account.address().as_array() != &dist_asset {
        pinocchio_log::log!("dist.asset: expected {}, got {}", Pk(&dist_asset), Pk(asset_account.address().as_array()));
        return Err(TokenizerError::DistributionAssetMismatch.into());
    }
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
        "asset_account",
    )?;

    // Validate accepted_mint matches distribution
    if accepted_mint.address().as_array() != &dist_mint {
        pinocchio_log::log!("accepted_mint: expected {}, got {}", Pk(&dist_mint), Pk(accepted_mint.address().as_array()));
        return Err(TokenizerError::InvalidMint.into());
    }

    // Validate escrow PDA
    require_pda_with_bump(
        escrow,
        &[DISTRIBUTION_ESCROW_SEED, distribution_account.address().as_ref(), &[dist_escrow_bump]],
        program_id,
        "escrow",
    )?;

    require_signer(payer, "payer")?;
    require_writable(payer, "payer")?;
    require_writable(distribution_account, "distribution_account")?;
    require_writable(escrow, "escrow")?;
    require_system_program(system_program)?;
    require_token_program(token_program)?;
    require_ata_program(ata_program)?;

    let dist_bump_bytes = [dist_bump];

    // ── Process each claim ────────────────────────────────────────

    let mut batch_shares_claimed: u64 = 0;

    for i in 0..count {
        let base = FIXED_ACCOUNTS + i * ACCOUNTS_PER_CLAIM;
        let asset_token_account = &accounts[base];
        let holder_token_acc = &accounts[base + 1];
        let holder = &accounts[base + 2];

        // Validate asset_token
        require_owner(asset_token_account, program_id, "asset_token_account")?;
        require_writable(asset_token_account, "asset_token_account")?;
        let at_ref = asset_token_account.try_borrow()?;
        validate_account_key(&at_ref, AccountKey::AssetToken)?;
        let at = unsafe { AssetToken::load(&at_ref) };

        // Must belong to this asset
        if &at.asset != asset_account.address().as_array() {
            pinocchio_log::log!("at.asset: expected {}, got {}", Pk(&at.asset), Pk(asset_account.address().as_array()));
            return Err(TokenizerError::TokenAssetMismatch.into());
        }

        // Must have shares
        if at.shares == 0 {
            pinocchio_log::log!("at.shares: 0");
            return Err(TokenizerError::NoSharesToClaim.into());
        }

        // Distribution epoch must be newer than token's last claimed
        if dist_epoch <= at.last_claimed_epoch {
            pinocchio_log::log!("already claimed: dist_epoch={}, last_claimed={}", dist_epoch, at.last_claimed_epoch);
            return Err(TokenizerError::AlreadyClaimed.into());
        }

        // Verify holder matches token owner
        if &at.owner != holder.address().as_array() {
            pinocchio_log::log!("at.owner: expected {}, got {}", Pk(&at.owner), Pk(holder.address().as_array()));
            return Err(TokenizerError::NotTokenOwner.into());
        }

        let shares = at.shares;
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

        require_writable(holder_token_acc, "holder_token_acc")?;

        // Compute payout: shares * total_amount / total_shares
        let payout = (shares as u128)
            .checked_mul(dist_total_amount as u128)
            .and_then(|v| v.checked_div(dist_total_shares as u128))
            .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())? as u64;

        if payout == 0 {
            return Err(TokenizerError::NoSharesToClaim.into());
        }

        // Create holder ATA if needed
        create_ata_if_needed(payer, holder_token_acc, holder, accepted_mint, system_program, token_program)?;

        // Transfer payout from escrow to holder (distribution PDA signs)
        let dist_seeds = [
            Seed::from(DIVIDEND_DISTRIBUTION_SEED),
            Seed::from(dist_asset.as_ref()),
            Seed::from(epoch_bytes.as_ref()),
            Seed::from(&dist_bump_bytes),
        ];
        spl_transfer_signed(escrow, holder_token_acc, distribution_account, payout, &dist_mint, &dist_seeds)?;

        // Accumulate shares claimed
        batch_shares_claimed = batch_shares_claimed
            .checked_add(shares)
            .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;

        // Update asset_token.last_claimed_epoch
        let mut at_mut = asset_token_account.try_borrow_mut()?;
        let at = unsafe { AssetToken::load_mut(&mut at_mut) };
        at.last_claimed_epoch = dist_epoch;
        drop(at_mut);
    }

    // Update distribution.shares_claimed
    let mut dist_mut = distribution_account.try_borrow_mut()?;
    let dist = unsafe { DividendDistribution::load_mut(&mut dist_mut) };
    dist.shares_claimed = dist.shares_claimed
        .checked_add(batch_shares_claimed)
        .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;
    drop(dist_mut);

    Ok(())
}
