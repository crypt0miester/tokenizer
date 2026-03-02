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
        registrar::Registrar,
        validate_account_key, AccountKey,
        REGISTRAR_SEED,
    },
    validation::{
        require_owner, require_pda_with_bump, require_writable,
    },
};

/// Relinquish voter weight — decrement active_votes on asset tokens after proposal ends.
/// Permissionless — anyone can crank after proposal reaches a terminal state.
///
/// Accounts (3 fixed + N asset_tokens, 1-8):
///   0. registrar
///   1. governance_program         — to verify proposal ownership
///   2. proposal                   — spl-gov proposal account (read)
///   3..3+N. asset_token accounts (w)
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    _data: &[u8],
) -> ProgramResult {
    if accounts.len() < 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let registrar_account = &accounts[0];
    let governance_program = &accounts[1];
    let proposal = &accounts[2];

    // Validate registrar
    require_owner(registrar_account, program_id, "registrar_account")?;
    let reg_ref = registrar_account.try_borrow()?;
    validate_account_key(&reg_ref, AccountKey::Registrar)?;
    let reg = unsafe { Registrar::load(&reg_ref) };

    let governance_program_id = reg.governance_program_id;
    let realm = reg.realm;
    let governing_token_mint = reg.governing_token_mint;
    let reg_bump = reg.bump;
    drop(reg_ref);

    require_pda_with_bump(
        registrar_account,
        &[REGISTRAR_SEED, &realm, &governing_token_mint, &[reg_bump]],
        program_id,
        "registrar_account",
    )?;

    // Verify governance_program matches registrar's governance_program_id
    if governance_program.address().as_array() != &governance_program_id {
        return Err(TokenizerError::InvalidGovernanceProgram.into());
    }

    // Verify proposal is owned by governance_program
    let proposal_owner = unsafe { proposal.owner() };
    if proposal_owner.as_ref() != &governance_program_id {
        return Err(TokenizerError::InvalidGovernanceProgram.into());
    }

    // Read and validate proposal account
    let proposal_ref = proposal.try_borrow()?;
    if !p_gov::state::proposal::ProposalV2::check_account_type(&proposal_ref) {
        return Err(ProgramError::InvalidAccountData);
    }
    let state = p_gov::state::proposal::ProposalV2::state(&proposal_ref)
        .ok_or(ProgramError::InvalidAccountData)?;
    drop(proposal_ref);

    if !state.is_terminal() {
        return Err(TokenizerError::ProposalNotTerminal.into());
    }

    // Decrement active_votes on each provided asset token
    let num_tokens = accounts.len() - 3;
    if num_tokens == 0 || num_tokens > 8 {
        return Err(ProgramError::InvalidInstructionData);
    }

    // Reject duplicate asset token accounts
    for i in 0..num_tokens {
        for j in (i + 1)..num_tokens {
            if accounts[3 + i].address() == accounts[3 + j].address() {
                return Err(TokenizerError::DuplicateAssetToken.into());
            }
        }
    }

    // Read registrar's asset to validate tokens
    let reg_ref2 = registrar_account.try_borrow()?;
    let reg2 = unsafe { Registrar::load(&reg_ref2) };
    let registrar_asset = reg2.asset;
    drop(reg_ref2);

    for i in 0..num_tokens {
        let at_account = &accounts[3 + i];

        require_owner(at_account, program_id, "at_account")?;
        require_writable(at_account, "at_account")?;

        let at_ref = at_account.try_borrow()?;
        validate_account_key(&at_ref, AccountKey::AssetToken)?;
        let at = unsafe { AssetToken::load(&at_ref) };

        // Verify token belongs to registrar's asset
        if &at.asset != &registrar_asset {
            return Err(TokenizerError::TokenAssetRegistrarMismatch.into());
        }
        drop(at_ref);

        let mut at_mut = at_account.try_borrow_mut()?;
        let at = unsafe { AssetToken::load_mut(&mut at_mut) };
        at.active_votes = at.active_votes
            .checked_sub(1)
            .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;
        drop(at_mut);
    }

    Ok(())
}
