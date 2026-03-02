use pinocchio::{
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    AccountView,
    Address,
    ProgramResult,
};

use crate::{
    error::TokenizerError,
    state::{
        asset_token::AssetToken,
        registrar::Registrar,
        voter_weight_record::VoterWeightRecord,
        validate_account_key, AccountKey,
        REGISTRAR_SEED,
    },
    validation::{
        require_owner, require_pda_with_bump, require_signer, require_writable,
    },
};

/// Update a voter weight record by summing shares across provided asset tokens.
///
/// Accounts (3 fixed + N asset_tokens, 1-8):
///   0. registrar
///   1. voter_weight_record(w)
///   2. governing_token_owner     — verified via asset_token.owner match
///   3..3+N. asset_token accounts (w if action=CastVote, else read-only)
///
/// Data: [0] action: u8, [1..33] action_target: Pubkey
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 4 {
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
    let governing_token_owner = &accounts[2];

    require_signer(governing_token_owner, "governing_token_owner")?;

    // Validate registrar
    require_owner(registrar_account, program_id, "registrar_account")?;
    let reg_ref = registrar_account.try_borrow()?;
    validate_account_key(&reg_ref, AccountKey::Registrar)?;
    let reg = unsafe { Registrar::load(&reg_ref) };

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

    // Validate voter_weight_record
    require_owner(voter_weight_record_account, program_id, "voter_weight_record_account")?;
    require_writable(voter_weight_record_account, "voter_weight_record_account")?;

    // Validate VoterWeightRecord PDA
    let vwr_ref = voter_weight_record_account.try_borrow()?;
    // Check discriminator
    if vwr_ref.len() < VoterWeightRecord::LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    drop(vwr_ref);

    // Verify PDA derivation
    let (expected_vwr, _) = VoterWeightRecord::derive_pda(
        &realm,
        &governing_token_mint,
        governing_token_owner.address().as_array(),
        program_id,
    );
    if *voter_weight_record_account.address() != expected_vwr {
        return Err(TokenizerError::InvalidPDA.into());
    }

    let num_tokens = accounts.len() - 3;
    if num_tokens == 0 || num_tokens > 8 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let is_cast_vote = action == 0;

    // Reject duplicate asset token accounts (prevents weight inflation)
    for i in 0..num_tokens {
        for j in (i + 1)..num_tokens {
            if accounts[3 + i].address() == accounts[3 + j].address() {
                return Err(TokenizerError::DuplicateAssetToken.into());
            }
        }
    }

    // Sum shares from all provided asset tokens
    let mut total_weight: u64 = 0;

    for i in 0..num_tokens {
        let at_account = &accounts[3 + i];

        require_owner(at_account, program_id, "at_account")?;
        if is_cast_vote {
            require_writable(at_account, "at_account")?;
        }

        let at_ref = at_account.try_borrow()?;
        validate_account_key(&at_ref, AccountKey::AssetToken)?;
        let at = unsafe { AssetToken::load(&at_ref) };

        // Verify token belongs to registrar's asset
        if &at.asset != &registrar_asset {
            return Err(TokenizerError::TokenAssetRegistrarMismatch.into());
        }

        // Verify owner matches governing_token_owner
        if &at.owner != governing_token_owner.address().as_array() {
            return Err(TokenizerError::InvalidTokenOwner.into());
        }

        // Reject if listed — cannot vote with listed tokens
        if at.is_listed() {
            return Err(TokenizerError::GovernanceTokenLocked.into());
        }

        // Reject if shares == 0
        if at.shares == 0 {
            return Err(TokenizerError::NoSharesToClaim.into());
        }

        total_weight = total_weight
            .checked_add(at.shares)
            .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;

        drop(at_ref);

        // If CastVote, increment active_votes on each AssetToken
        if is_cast_vote {
            let mut at_mut = at_account.try_borrow_mut()?;
            let at = unsafe { AssetToken::load_mut(&mut at_mut) };
            at.active_votes = at.active_votes
                .checked_add(1)
                .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;
            drop(at_mut);
        }
    }

    // Write voter_weight_record
    let clock = Clock::get()?;
    let mut vwr_data = voter_weight_record_account.try_borrow_mut()?;
    VoterWeightRecord::store(
        &mut vwr_data,
        &realm,
        &governing_token_mint,
        governing_token_owner.address().as_array(),
        total_weight,
        clock.slot,
        action,
        &action_target,
    );

    Ok(())
}
