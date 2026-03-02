use pinocchio::{
    cpi::{Seed, Signer},
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    AccountView,
    Address,
    ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;
use crate::{
    error::TokenizerError,
    state::{
        fundraising_round::FundraisingRound,
        investment::Investment,
        protocol_config::ProtocolConfig,
        validate_account_key, AccountKey, RoundStatus,
        FUNDRAISING_ROUND_SEED, INVESTMENT_SEED, PROTOCOL_CONFIG_SEED,
    },
    utils::{spl_transfer, Pk},
    validation::{
        require_owner, require_pda, require_pda_with_bump, require_signer,
        require_system_program, require_token_account, require_token_program, require_writable,
    },
};

/// Invest in a fundraising round: deposit stablecoins, reserve shares.
/// No NFT is minted at this stage — minting happens after finalization.
///
/// If the investor already has an Investment record for this round,
/// the new investment is added to the existing one.
///
/// Instruction data layout:
/// [0..8] shares: u64
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    let [
        config,
        round_account,          // FundraisingRound PDA — writable
        investment_account,     // Investment PDA — writable (create or update)
        escrow,                 // Escrow token account — writable
        investor_token_account, // Investor's token account — writable
        investor,               // Investor wallet — signer
        payer,                  // Payer — signer, writable
        system_program,
        token_program,
    ] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate protocol
    require_owner(config, program_id, "config")?;
    let config_ref = config.try_borrow()?;
    validate_account_key(&config_ref, AccountKey::ProtocolConfig)?;
    let config_data = unsafe { ProtocolConfig::load(&config_ref) };
    config_data.require_not_paused()?;
    let config_bump = config_data.bump;
    drop(config_ref);
    require_pda_with_bump(config, &[PROTOCOL_CONFIG_SEED, &[config_bump]], program_id, "config")?;

    // Validate round
    require_owner(round_account, program_id, "round_account")?;
    require_writable(round_account, "round_account")?;
    let round_ref = round_account.try_borrow()?;
    validate_account_key(&round_ref, AccountKey::FundraisingRound)?;
    let round = unsafe { FundraisingRound::load(&round_ref) };

    // Round must be active
    if round.status() != RoundStatus::Active {
        pinocchio_log::log!("round.status: {}", round.status);
        return Err(TokenizerError::RoundNotActive.into());
    }

    // Check timing
    let clock = Clock::get()?;
    if clock.unix_timestamp < round.start_time {
        pinocchio_log::log!("round not started: now={}, start={}", clock.unix_timestamp, round.start_time);
        return Err(TokenizerError::RoundNotStarted.into());
    }
    if clock.unix_timestamp > round.end_time {
        pinocchio_log::log!("round ended: now={}, end={}", clock.unix_timestamp, round.end_time);
        return Err(TokenizerError::RoundEnded.into());
    }

    // Validate escrow matches
    if &round.escrow != escrow.address().as_array() {
        pinocchio_log::log!("round.escrow: expected {}, got {}", Pk(&round.escrow), Pk(escrow.address().as_array()));
        return Err(TokenizerError::EscrowMismatch.into());
    }

    // Validate round PDA
    let round_index = round.round_index;
    let asset_key = round.asset;
    let price_per_share = round.price_per_share;
    let shares_offered = round.shares_offered;
    let shares_sold = round.shares_sold;
    let total_raised = round.total_raised;
    let max_raise = round.max_raise;
    let min_per_wallet = round.min_per_wallet;
    let max_per_wallet = round.max_per_wallet;
    let investor_count = round.investor_count;
    let round_mint = round.accepted_mint;
    let round_bump = round.bump;
    let round_terms_hash = round.terms_hash;
    drop(round_ref);

    require_pda_with_bump(
        round_account,
        &[FUNDRAISING_ROUND_SEED, &asset_key, &round_index.to_le_bytes(), &[round_bump]],
        program_id,
        "round_account",
    )?;

    // Parse instruction data (8 + 32 = 40 bytes)
    if data.len() < 40 {
        return Err(TokenizerError::InstructionDataTooShort.into());
    }
    let shares = u64::from_le_bytes(data[0..8].try_into().unwrap());
    if shares == 0 {
        return Err(TokenizerError::InvalidShareCount.into());
    }

    // Verify terms hash matches round
    let payload_terms_hash: [u8; 32] = data[8..40].try_into().unwrap();
    if payload_terms_hash != round_terms_hash {
        pinocchio_log::log!("terms hash mismatch");
        return Err(TokenizerError::TermsHashMismatch.into());
    }

    // Calculate deposit amount
    let amount = shares
        .checked_mul(price_per_share)
        .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;

    // Check shares don't exceed offered
    let new_shares_sold = shares_sold
        .checked_add(shares)
        .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;
    if new_shares_sold > shares_offered {
        return Err(TokenizerError::SharesExceedOffered.into());
    }

    // Check max_raise not exceeded
    let new_total_raised = total_raised
        .checked_add(amount)
        .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;
    if new_total_raised > max_raise {
        return Err(TokenizerError::RaiseExceedsMaximum.into());
    }

    // Validate accounts
    require_signer(investor, "investor")?;
    require_signer(payer, "payer")?;
    require_writable(investment_account, "investment_account")?;
    require_writable(escrow, "escrow")?;
    require_writable(investor_token_account, "investor_token_account")?;
    require_system_program(system_program)?;
    require_token_program(token_program)?;

    // Validate investment PDA
    let inv_bump = require_pda(
        investment_account,
        &[INVESTMENT_SEED, round_account.address().as_ref(), investor.address().as_ref()],
        program_id,
        "investment_account",
    )?;

    // Check if investment account already exists (has data)
    let is_new_investment = investment_account.try_borrow()
        .map(|d| d.is_empty() || d[0] == AccountKey::Uninitialized as u8)
        .unwrap_or(true);

    let existing_amount;
    let existing_shares;

    if is_new_investment {
        existing_amount = 0u64;
        existing_shares = 0u64;

        // Create Investment PDA account
        let inv_bump_bytes = [inv_bump];
        let inv_seeds = [
            Seed::from(INVESTMENT_SEED),
            Seed::from(round_account.address().as_ref()),
            Seed::from(investor.address().as_ref()),
            Seed::from(&inv_bump_bytes),
        ];
        let inv_signer = Signer::from(&inv_seeds);

        CreateAccount {
            from: payer,
            to: investment_account,
            lamports: pinocchio::sysvars::rent::Rent::get()
                .map(|r| r.try_minimum_balance(Investment::LEN).unwrap_or(0))
                .unwrap_or(0),
            space: Investment::LEN as u64,
            owner: program_id,
        }
        .invoke_signed(&[inv_signer])?;
    } else {
        // Existing investment — read current values
        let inv_ref = investment_account.try_borrow()?;
        validate_account_key(&inv_ref, AccountKey::Investment)?;
        let inv = unsafe { Investment::load(&inv_ref) };
        existing_amount = inv.amount_deposited;
        existing_shares = inv.shares_reserved;
        drop(inv_ref);
    }

    // Check per-wallet limits (existing + new)
    let total_wallet_amount = existing_amount
        .checked_add(amount)
        .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;
    let total_wallet_shares = existing_shares
        .checked_add(shares)
        .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;

    if min_per_wallet > 0 && total_wallet_amount < min_per_wallet {
        return Err(TokenizerError::InvestmentBelowMinimum.into());
    }
    if max_per_wallet > 0 && total_wallet_amount > max_per_wallet {
        return Err(TokenizerError::InvestmentAboveMaximum.into());
    }

    // Validate investor token account: correct mint and owner
    require_token_account(investor_token_account, &round_mint, investor.address().as_array())?;

    // Transfer stablecoins from investor to escrow
    spl_transfer(investor_token_account, escrow, investor, amount, &round_mint)?;

    // Update Investment state
    let mut inv_data = investment_account.try_borrow_mut()?;
    let inv = unsafe { Investment::load_mut(&mut inv_data) };

    if is_new_investment {
        inv.account_key = AccountKey::Investment as u8;
        inv.version = 1;
        inv.round = round_account.address().to_bytes();
        inv.investor = investor.address().to_bytes();
        inv.shares_reserved = shares;
        inv.amount_deposited = amount;
        inv.is_minted = 0;
        inv.is_refunded = 0;
        inv.created_at = clock.unix_timestamp;
        inv.updated_at = clock.unix_timestamp;
        inv.bump = inv_bump;
    } else {
        inv.shares_reserved = total_wallet_shares;
        inv.amount_deposited = total_wallet_amount;
        inv.updated_at = clock.unix_timestamp;
    }
    drop(inv_data);

    // Update round totals
    let mut round_mut = round_account.try_borrow_mut()?;
    let round = unsafe { FundraisingRound::load_mut(&mut round_mut) };
    round.total_raised = new_total_raised;
    round.shares_sold = new_shares_sold;
    if is_new_investment {
        round.investor_count = investor_count
            .checked_add(1)
            .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;
    }
    round.updated_at = clock.unix_timestamp;

    Ok(())
}
