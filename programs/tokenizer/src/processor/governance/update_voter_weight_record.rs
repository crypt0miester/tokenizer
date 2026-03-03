use pinocchio::{
    cpi::{Seed, Signer},
    error::ProgramError,
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    AccountView,
    Address,
    ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;

use crate::{
    error::TokenizerError,
    state::{
        asset_token::AssetToken,
        registrar::Registrar,
        vote_record::{self, VoteRecordHeader},
        voter_weight_record::VoterWeightRecord,
        validate_account_key, AccountKey,
        REGISTRAR_SEED, VOTE_RECORD_SEED,
    },
    validation::{
        require_owner, require_pda, require_pda_with_bump, require_signer,
        require_system_program, require_writable,
    },
};

/// Update a voter weight record by summing shares across provided asset tokens.
///
/// Resolves governing_token_owner from the spl-gov TokenOwnerRecord and
/// asserts the voter_authority is the token owner or its delegate.
///
/// Accounts — CastVote (action=0):
///   0. registrar
///   1. voter_weight_record(w)
///   2. voter_token_owner_record   — spl-gov TokenOwnerRecord (read, owned by governance program)
///   3. voter_authority(s)         — token owner or delegate (signer)
///   4. proposal                   — spl-gov ProposalV2 (read, must match action_target)
///   5. payer(s,w)                 — pays for vote_record creation/expansion
///   6. system_program
///   7..7+2N. [asset_token(w), vote_record(w)] pairs
///
/// Accounts — Other actions:
///   0. registrar
///   1. voter_weight_record(w)
///   2. voter_token_owner_record
///   3. voter_authority(s)
///   4..4+N. asset_token accounts (read-only)
///
/// Data: [0] action: u8, [1..33] action_target: Pubkey
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 5 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    // Parse instruction data: action(1) + action_target(32)
    if data.len() < 33 {
        return Err(TokenizerError::InstructionDataTooShort.into());
    }

    let action = data[0];
    if action > 4 {
        return Err(TokenizerError::InvalidVoterWeightAction.into());
    }
    let action_target: [u8; 32] = data[1..33].try_into().unwrap();

    let registrar_account = &accounts[0];
    let voter_weight_record_account = &accounts[1];
    let voter_token_owner_record = &accounts[2];
    let voter_authority = &accounts[3];

    require_signer(voter_authority, "voter_authority")?;

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

    // ── Resolve governing_token_owner from TokenOwnerRecord ──
    {
        let tor_owner = unsafe { voter_token_owner_record.owner() };
        if tor_owner.as_ref() != &governance_program_id {
            pinocchio_log::log!("voter_token_owner_record not owned by governance program");
            return Err(TokenizerError::InvalidTokenOwnerRecord.into());
        }

        let tor_ref = voter_token_owner_record.try_borrow()?;
        if !p_gov::state::token_owner_record::TokenOwnerRecordV2::check_account_type(&tor_ref) {
            pinocchio_log::log!("voter_token_owner_record: invalid account type");
            return Err(TokenizerError::InvalidTokenOwnerRecord.into());
        }

        if p_gov::state::token_owner_record::TokenOwnerRecordV2::realm(&tor_ref) != &realm {
            pinocchio_log::log!("voter_token_owner_record: realm mismatch");
            return Err(TokenizerError::InvalidTokenOwnerRecord.into());
        }

        if p_gov::state::token_owner_record::TokenOwnerRecordV2::governing_token_mint(&tor_ref) != &governing_token_mint {
            pinocchio_log::log!("voter_token_owner_record: governing_token_mint mismatch");
            return Err(TokenizerError::InvalidTokenOwnerRecord.into());
        }

        let tor_owner_key = p_gov::state::token_owner_record::TokenOwnerRecordV2::governing_token_owner(&tor_ref);
        let authority_key = voter_authority.address().as_ref();

        let is_owner = authority_key == tor_owner_key;
        let is_delegate = p_gov::state::token_owner_record::TokenOwnerRecordV2::governance_delegate(&tor_ref)
            .map_or(false, |d| authority_key == d);

        if !is_owner && !is_delegate {
            pinocchio_log::log!("voter_authority is neither token owner nor delegate");
            return Err(TokenizerError::InvalidAuthority.into());
        }

        drop(tor_ref);
    }

    let tor_ref2 = voter_token_owner_record.try_borrow()?;
    let governing_token_owner_key: [u8; 32] =
        p_gov::state::token_owner_record::TokenOwnerRecordV2::governing_token_owner(&tor_ref2)
            .try_into().unwrap();
    drop(tor_ref2);

    // Validate voter_weight_record
    require_owner(voter_weight_record_account, program_id, "voter_weight_record_account")?;
    require_writable(voter_weight_record_account, "voter_weight_record_account")?;

    let vwr_ref = voter_weight_record_account.try_borrow()?;
    if vwr_ref.len() < VoterWeightRecord::LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    drop(vwr_ref);

    let (expected_vwr, _) = VoterWeightRecord::derive_pda(
        &realm,
        &governing_token_mint,
        &governing_token_owner_key,
        program_id,
    );
    if *voter_weight_record_account.address() != expected_vwr {
        return Err(TokenizerError::InvalidPDA.into());
    }

    let is_cast_vote = action == 0;
    let clock = Clock::get()?;

    let mut total_weight: u64 = 0;

    if is_cast_vote {
        // ── CastVote path: accounts[4]=proposal, [5]=payer, [6]=system, [7..]=pairs ──
        if accounts.len() < 9 {
            return Err(ProgramError::NotEnoughAccountKeys);
        }
        let proposal_account = &accounts[4];
        let payer_account = &accounts[5];
        let system_program = &accounts[6];

        // Validate proposal
        if proposal_account.address().as_array() != &action_target {
            pinocchio_log::log!("proposal account does not match action_target");
            return Err(TokenizerError::InvalidActionTarget.into());
        }
        let proposal_owner = unsafe { proposal_account.owner() };
        if proposal_owner.as_ref() != &governance_program_id {
            pinocchio_log::log!("proposal not owned by governance program");
            return Err(TokenizerError::InvalidActionTarget.into());
        }
        let proposal_ref = proposal_account.try_borrow()?;
        if !p_gov::state::proposal::ProposalV2::check_account_type(&proposal_ref) {
            pinocchio_log::log!("proposal account is not a valid ProposalV2");
            drop(proposal_ref);
            return Err(TokenizerError::InvalidActionTarget.into());
        }
        drop(proposal_ref);

        // Validate payer and system program
        require_signer(payer_account, "payer")?;
        require_writable(payer_account, "payer")?;
        require_system_program(system_program)?;

        let token_start: usize = 7;
        let num_remaining = accounts.len() - token_start;
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
                if accounts[token_start + 2 * i].address() == accounts[token_start + 2 * j].address() {
                    return Err(TokenizerError::DuplicateAssetToken.into());
                }
            }
        }

        for i in 0..num_pairs {
            let at_account = &accounts[token_start + 2 * i];
            let vote_record_account = &accounts[token_start + 2 * i + 1];

            // Validate asset token
            require_owner(at_account, program_id, "at_account")?;
            require_writable(at_account, "at_account")?;

            let at_ref = at_account.try_borrow()?;
            validate_account_key(&at_ref, AccountKey::AssetToken)?;
            let at = unsafe { AssetToken::load(&at_ref) };

            if &at.asset != &registrar_asset {
                return Err(TokenizerError::TokenAssetRegistrarMismatch.into());
            }
            if at.owner != governing_token_owner_key {
                return Err(TokenizerError::InvalidTokenOwner.into());
            }
            if at.is_listed() {
                return Err(TokenizerError::GovernanceTokenLocked.into());
            }
            if at.shares == 0 {
                return Err(TokenizerError::NoSharesToClaim.into());
            }

            total_weight = total_weight
                .checked_add(at.shares)
                .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;
            drop(at_ref);

            // ── Handle vote_record ──
            require_writable(vote_record_account, "vote_record")?;

            if vote_record_account.data_len() == 0 {
                // First vote for this token — create vote_record PDA
                let vr_bump = require_pda(
                    vote_record_account,
                    &[VOTE_RECORD_SEED, at_account.address().as_ref()],
                    program_id,
                    "vote_record",
                )?;

                let space = VoteRecordHeader::LEN + 32;
                let lamports = Rent::get()
                    .map(|r| r.try_minimum_balance(space).unwrap_or(0))
                    .unwrap_or(0);

                let vr_bump_bytes = [vr_bump];
                let vr_seeds = [
                    Seed::from(VOTE_RECORD_SEED),
                    Seed::from(at_account.address().as_ref()),
                    Seed::from(&vr_bump_bytes),
                ];
                let vr_signer = Signer::from(&vr_seeds);

                CreateAccount {
                    from: payer_account,
                    to: vote_record_account,
                    lamports,
                    space: space as u64,
                    owner: program_id,
                }
                .invoke_signed(&[vr_signer])?;

                // Initialize header + append proposal
                let mut vr_data = vote_record_account.try_borrow_mut()?;
                vr_data[0] = AccountKey::VoteRecord as u8;
                vr_data[1] = vr_bump;
                vr_data[2..34].copy_from_slice(payer_account.address().as_ref());
                vr_data[34] = 0;
                vote_record::add_proposal(&mut vr_data, &action_target);
                drop(vr_data);
            } else {
                // Already exists — validate, check for duplicate, then grow
                require_owner(vote_record_account, program_id, "vote_record")?;

                let vr_ref = vote_record_account.try_borrow()?;
                if vr_ref[0] != AccountKey::VoteRecord as u8 {
                    drop(vr_ref);
                    return Err(TokenizerError::InvalidAccountKey.into());
                }
                let stored_bump = vr_ref[1];

                if vote_record::contains_proposal(&vr_ref, &action_target) {
                    drop(vr_ref);
                    return Err(TokenizerError::AlreadyVotedOnProposal.into());
                }
                drop(vr_ref);

                require_pda_with_bump(
                    vote_record_account,
                    &[VOTE_RECORD_SEED, at_account.address().as_ref(), &[stored_bump]],
                    program_id,
                    "vote_record",
                )?;

                // Grow the account by 32 bytes
                let current_len = vote_record_account.data_len();
                let new_len = current_len + 32;
                let new_min = Rent::get()
                    .map(|r| r.try_minimum_balance(new_len).unwrap_or(0))
                    .unwrap_or(0);
                let current_lamports = vote_record_account.lamports();

                if new_min > current_lamports {
                    let delta = new_min - current_lamports;
                    pinocchio_system::instructions::Transfer {
                        from: payer_account,
                        to: vote_record_account,
                        lamports: delta,
                    }
                    .invoke()?;
                }

                vote_record_account.resize(new_len)?;

                let mut vr_data = vote_record_account.try_borrow_mut()?;
                vote_record::add_proposal(&mut vr_data, &action_target);
                drop(vr_data);
            }

            // Increment active_votes on AssetToken
            let mut at_mut = at_account.try_borrow_mut()?;
            let at = unsafe { AssetToken::load_mut(&mut at_mut) };
            at.active_votes = at.active_votes
                .checked_add(1)
                .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;
            drop(at_mut);
        }
    } else {
        // ── Non-CastVote path (unchanged layout) ──
        if accounts.len() < 5 {
            return Err(ProgramError::NotEnoughAccountKeys);
        }
        let token_start: usize = 4;
        let num_tokens = accounts.len() - token_start;
        if num_tokens == 0 || num_tokens > 8 {
            return Err(ProgramError::InvalidInstructionData);
        }

        for i in 0..num_tokens {
            for j in (i + 1)..num_tokens {
                if accounts[token_start + i].address() == accounts[token_start + j].address() {
                    return Err(TokenizerError::DuplicateAssetToken.into());
                }
            }
        }

        for i in 0..num_tokens {
            let at_account = &accounts[token_start + i];

            require_owner(at_account, program_id, "at_account")?;

            let at_ref = at_account.try_borrow()?;
            validate_account_key(&at_ref, AccountKey::AssetToken)?;
            let at = unsafe { AssetToken::load(&at_ref) };

            if &at.asset != &registrar_asset {
                return Err(TokenizerError::TokenAssetRegistrarMismatch.into());
            }
            if at.owner != governing_token_owner_key {
                return Err(TokenizerError::InvalidTokenOwner.into());
            }
            if at.is_listed() {
                return Err(TokenizerError::GovernanceTokenLocked.into());
            }
            if at.shares == 0 {
                return Err(TokenizerError::NoSharesToClaim.into());
            }

            total_weight = total_weight
                .checked_add(at.shares)
                .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;
            drop(at_ref);
        }
    }

    // Write voter_weight_record
    let mut vwr_data = voter_weight_record_account.try_borrow_mut()?;
    VoterWeightRecord::store(
        &mut vwr_data,
        &realm,
        &governing_token_mint,
        &governing_token_owner_key,
        total_weight,
        clock.slot,
        action,
        &action_target,
    );

    Ok(())
}
