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
        vote_record::{self, VoteRecordHeader},
        validate_account_key, AccountKey,
        REGISTRAR_SEED, VOTE_RECORD_SEED,
    },
    validation::{
        close_account, require_owner, require_pda_with_bump, require_writable,
    },
};

/// Relinquish voter weight — decrement active_votes on asset tokens after proposal ends.
/// Permissionless — anyone can crank after proposal reaches a terminal state.
///
/// Accounts (4 fixed + 2*N pairs):
///   0. registrar
///   1. governance_program         — to verify proposal ownership
///   2. proposal                   — spl-gov proposal account (read)
///   3. rent_destination(w)        — receives rent when vote_record closes (must match creator)
///   4..4+2N. [asset_token(w), vote_record(w)] pairs
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    _data: &[u8],
) -> ProgramResult {
    if accounts.len() < 6 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let registrar_account = &accounts[0];
    let governance_program = &accounts[1];
    let proposal = &accounts[2];
    let rent_destination = &accounts[3];

    // Validate registrar
    require_owner(registrar_account, program_id, "registrar_account")?;
    let reg_ref = registrar_account.try_borrow()?;
    validate_account_key(&reg_ref, AccountKey::Registrar)?;
    let reg = unsafe { Registrar::load(&reg_ref) };

    let governance_program_id = reg.governance_program_id;
    let realm = reg.realm;
    let governing_token_mint = reg.governing_token_mint;
    let registrar_asset = reg.asset;
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

    // Read and validate proposal is terminal
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

    // Validate rent_destination
    require_writable(rent_destination, "rent_destination")?;

    // Parse pairs
    let num_remaining = accounts.len() - 4;
    if num_remaining == 0 || num_remaining % 2 != 0 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let num_pairs = num_remaining / 2;
    if num_pairs > 8 {
        return Err(ProgramError::InvalidInstructionData);
    }

    // Reject duplicate asset token accounts (stride of 2)
    for i in 0..num_pairs {
        for j in (i + 1)..num_pairs {
            if accounts[4 + 2 * i].address() == accounts[4 + 2 * j].address() {
                return Err(TokenizerError::DuplicateAssetToken.into());
            }
        }
    }

    let proposal_key: [u8; 32] = proposal.address().to_bytes();

    for i in 0..num_pairs {
        let at_account = &accounts[4 + 2 * i];
        let vote_record_account = &accounts[4 + 2 * i + 1];

        // Validate asset token
        require_owner(at_account, program_id, "at_account")?;
        require_writable(at_account, "at_account")?;

        let at_ref = at_account.try_borrow()?;
        validate_account_key(&at_ref, AccountKey::AssetToken)?;
        let at = unsafe { AssetToken::load(&at_ref) };

        if &at.asset != &registrar_asset {
            return Err(TokenizerError::TokenAssetRegistrarMismatch.into());
        }
        drop(at_ref);

        // Validate vote_record
        require_owner(vote_record_account, program_id, "vote_record")?;
        require_writable(vote_record_account, "vote_record")?;

        let vr_ref = vote_record_account.try_borrow()?;
        if vr_ref.len() < VoteRecordHeader::LEN || vr_ref[0] != AccountKey::VoteRecord as u8 {
            drop(vr_ref);
            return Err(TokenizerError::InvalidAccountKey.into());
        }
        let stored_bump = vr_ref[1];
        drop(vr_ref);

        require_pda_with_bump(
            vote_record_account,
            &[VOTE_RECORD_SEED, at_account.address().as_ref(), &[stored_bump]],
            program_id,
            "vote_record",
        )?;

        // Remove proposal from vote_record
        let mut vr_data = vote_record_account.try_borrow_mut()?;
        if !vote_record::remove_proposal(&mut vr_data, &proposal_key) {
            drop(vr_data);
            return Err(TokenizerError::NotVotedOnProposal.into());
        }
        let remaining_count = vr_data[34];
        let creator: [u8; 32] = vr_data[2..34].try_into().unwrap();
        drop(vr_data);

        // Decrement active_votes
        let mut at_mut = at_account.try_borrow_mut()?;
        let at = unsafe { AssetToken::load_mut(&mut at_mut) };
        at.active_votes = at.active_votes
            .checked_sub(1)
            .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;
        drop(at_mut);

        // Close vote_record if no more proposals
        if remaining_count == 0 {
            if rent_destination.address().as_array() != &creator {
                return Err(TokenizerError::VoteRecordCreatorMismatch.into());
            }
            close_account(vote_record_account, rent_destination)?;
        }
    }

    Ok(())
}
