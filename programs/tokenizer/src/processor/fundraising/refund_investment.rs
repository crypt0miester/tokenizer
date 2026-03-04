use pinocchio::{
    cpi::Seed,
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    AccountView,
    Address,
    ProgramResult,
};
use crate::{
    error::TokenizerError,
    state::{
        fundraising_round::FundraisingRound,
        investment::Investment,
        validate_account_key, AccountKey, RoundStatus,
        FUNDRAISING_ROUND_SEED, INVESTMENT_SEED,
    },
    utils::{read_token_balance, spl_transfer_signed, close_token_account_signed, Pk},
    validation::{
        create_ata_if_needed, require_ata_program, require_owner, require_pda_with_bump,
        require_signer, require_system_program, require_token_account, require_token_program,
        require_writable,
    },
};

const FIXED_ACCOUNTS: usize = 7;
const ACCOUNTS_PER_INVESTOR: usize = 3;
const MAX_BATCH_SIZE: usize = 10;

/// Permissionless crank: batch-refund investors after failed/cancelled round.
///
/// Processes 1–10 investors per transaction.
///
/// Instruction data layout:
/// [0] count: u8 — number of investors in this batch (1–10)
///
/// Account layout:
///   Fixed (7):
///     0. round_account — FundraisingRound (writable)
///     1. escrow        — Escrow token account (writable)
///     2. payer         — Signer
///     3. accepted_mint
///     4. system_program
///     5. token_program
///     6. ata_program
///
///   Per investor (repeated `count` times, 3 accounts each):
///     7 + i*3 + 0. investment_account     — Investment PDA (writable)
///     7 + i*3 + 1. investor_token_account — Investor's token account (writable)
///     7 + i*3 + 2. investor               — Investor wallet (for PDA validation)
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

    let expected_accounts = FIXED_ACCOUNTS + count * ACCOUNTS_PER_INVESTOR;
    if accounts.len() < expected_accounts {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    // Extract fixed accounts
    let round_account = &accounts[0];
    let escrow = &accounts[1];
    let payer = &accounts[2];
    let accepted_mint = &accounts[3];
    let system_program = &accounts[4];
    let token_program = &accounts[5];
    let ata_program = &accounts[6];

    // Validate shared accounts (once)

    require_owner(round_account, program_id, "round_account")?;
    require_writable(round_account, "round_account")?;
    let round_ref = round_account.try_borrow()?;
    validate_account_key(&round_ref, AccountKey::FundraisingRound)?;
    let round = unsafe { FundraisingRound::load(&round_ref) };

    let status = round.status();
    if status != RoundStatus::Failed && status != RoundStatus::Cancelled {
        pinocchio_log::log!("round.status: {}", round.status);
        return Err(TokenizerError::RoundNotFailedOrCancelled.into());
    }

    let round_index = round.round_index;
    let asset_key = round.asset;
    let round_bump = round.bump;
    let investors_settled = round.investors_settled;

    if &round.escrow != escrow.address().as_array() {
        pinocchio_log::log!("round.escrow: expected {}, got {}", Pk(&round.escrow), Pk(escrow.address().as_array()));
        return Err(TokenizerError::EscrowMismatch.into());
    }
    let round_mint = round.accepted_mint;
    drop(round_ref);

    // Validate accepted_mint matches round
    if accepted_mint.address().as_array() != &round_mint {
        pinocchio_log::log!("accepted_mint: expected {}, got {}", Pk(&round_mint), Pk(accepted_mint.address().as_array()));
        return Err(TokenizerError::InvalidMint.into());
    }

    require_pda_with_bump(
        round_account,
        &[FUNDRAISING_ROUND_SEED, &asset_key, &round_index.to_le_bytes(), &[round_bump]],
        program_id,
        "round_account",
    )?;

    require_signer(payer, "payer")?;
    require_writable(escrow, "escrow")?;
    require_system_program(system_program)?;
    require_token_program(token_program)?;
    require_ata_program(ata_program)?;

    let round_index_bytes = round_index.to_le_bytes();
    let round_bump_bytes = [round_bump];
    let clock = Clock::get()?;

    // Process each investor

    let mut settled_count = 0u32;

    for i in 0..count {
        let base = FIXED_ACCOUNTS + i * ACCOUNTS_PER_INVESTOR;
        let investment_account = &accounts[base];
        let investor_token_account = &accounts[base + 1];
        let investor = &accounts[base + 2];

        // Validate investment
        require_owner(investment_account, program_id, "investment_account")?;
        require_writable(investment_account, "investment_account")?;
        let inv_ref = investment_account.try_borrow()?;
        validate_account_key(&inv_ref, AccountKey::Investment)?;
        let inv = unsafe { Investment::load(&inv_ref) };

        if inv.is_refunded != 0 {
            return Err(TokenizerError::InvestmentAlreadyRefunded.into());
        }
        if &inv.round != round_account.address().as_array() {
            pinocchio_log::log!("inv.round: expected {}, got {}", Pk(round_account.address().as_array()), Pk(&inv.round));
            return Err(TokenizerError::InvestmentRoundMismatch.into());
        }

        let amount = inv.amount_deposited;
        let investor_key = inv.investor;
        let inv_bump = inv.bump;
        drop(inv_ref);

        require_pda_with_bump(
            investment_account,
            &[INVESTMENT_SEED, round_account.address().as_ref(), &investor_key, &[inv_bump]],
            program_id,
            "investment_account",
        )?;

        if investor.address().as_array() != &investor_key {
            pinocchio_log::log!("inv.investor: expected {}, got {}", Pk(&investor_key), Pk(investor.address().as_array()));
            return Err(TokenizerError::InvestorMismatch.into());
        }

        require_writable(investor_token_account, "investor_token_account")?;

        // Create investor ATA if needed
        create_ata_if_needed(payer, investor_token_account, investor, accepted_mint, system_program, token_program)?;

        // Validate investor token account: correct mint and owner
        require_token_account(investor_token_account, &round_mint, investor.address().as_array())?;

        // Transfer from escrow back to investor
        let round_seeds = [
            Seed::from(FUNDRAISING_ROUND_SEED),
            Seed::from(asset_key.as_ref()),
            Seed::from(round_index_bytes.as_ref()),
            Seed::from(&round_bump_bytes),
        ];
        spl_transfer_signed(escrow, investor_token_account, round_account, amount, &round_mint, &round_seeds)?;

        // Mark investment as refunded
        let mut inv_mut = investment_account.try_borrow_mut()?;
        let inv = unsafe { Investment::load_mut(&mut inv_mut) };
        inv.is_refunded = 1;
        inv.updated_at = clock.unix_timestamp;
        drop(inv_mut);

        settled_count = settled_count
            .checked_add(1)
            .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;
    }

    // Update shared state (once)

    let all_settled = {
        let mut round_mut = round_account.try_borrow_mut()?;
        let round = unsafe { FundraisingRound::load_mut(&mut round_mut) };
        round.investors_settled = investors_settled
            .checked_add(settled_count)
            .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;
        round.updated_at = clock.unix_timestamp;
        round.investors_settled >= round.investor_count
    };

    // Close escrow when all investors have been refunded and balance is zero.
    // Skip if dust remains (e.g. rounding) — don't lock funds forever.
    if all_settled {
        let escrow_balance = {
            let data = escrow.try_borrow()?;
            read_token_balance(&data)?
        };
        if escrow_balance == 0 {
            let round_seeds = [
                Seed::from(FUNDRAISING_ROUND_SEED),
                Seed::from(asset_key.as_ref()),
                Seed::from(round_index_bytes.as_ref()),
                Seed::from(&round_bump_bytes),
            ];
            close_token_account_signed(escrow, payer, round_account, &round_seeds)?;
        }
    }

    Ok(())
}
