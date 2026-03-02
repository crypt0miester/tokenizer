use pinocchio::{
    cpi::{Seed, Signer},
    error::ProgramError,
    sysvars::Sysvar,
    AccountView,
    Address,
    ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;

use crate::{
    error::TokenizerError,
    state::{
        registrar::Registrar,
        voter_weight_record::VoterWeightRecord,
        validate_account_key, AccountKey,
        REGISTRAR_SEED, VOTER_WEIGHT_RECORD_SEED,
    },
    validation::{
        require_owner, require_pda_with_bump, require_pda, require_signer,
        require_system_program, require_writable,
    },
};

/// Create a voter weight record for a specific voter.
///
/// Accounts (5):
///   0. registrar
///   1. voter_weight_record(w) — PDA to create
///   2. governing_token_owner  — the voter
///   3. payer(s,w)
///   4. system_program
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    _data: &[u8],
) -> ProgramResult {
    let [
        registrar_account,
        voter_weight_record_account,
        governing_token_owner,
        payer,
        system_program,
    ] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate registrar
    require_owner(registrar_account, program_id, "registrar_account")?;
    let reg_ref = registrar_account.try_borrow()?;
    validate_account_key(&reg_ref, AccountKey::Registrar)?;
    let reg = unsafe { Registrar::load(&reg_ref) };

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

    // Validate signers
    require_signer(payer, "payer")?;
    require_writable(payer, "payer")?;
    require_writable(voter_weight_record_account, "voter_weight_record_account")?;
    require_system_program(system_program)?;

    // Derive and validate VoterWeightRecord PDA
    let vwr_bump = require_pda(
        voter_weight_record_account,
        &[
            VOTER_WEIGHT_RECORD_SEED,
            &realm,
            &governing_token_mint,
            governing_token_owner.address().as_ref(),
        ],
        program_id,
        "voter_weight_record_account",
    )?;

    // Must not already exist
    if voter_weight_record_account.data_len() != 0 {
        return Err(TokenizerError::VoterWeightRecordAlreadyExists.into());
    }

    // Create VoterWeightRecord PDA account
    let vwr_bump_bytes = [vwr_bump];
    let vwr_seeds = [
        Seed::from(VOTER_WEIGHT_RECORD_SEED),
        Seed::from(realm.as_ref()),
        Seed::from(governing_token_mint.as_ref()),
        Seed::from(governing_token_owner.address().as_ref()),
        Seed::from(&vwr_bump_bytes),
    ];
    let vwr_signer = Signer::from(&vwr_seeds);

    CreateAccount {
        from: payer,
        to: voter_weight_record_account,
        lamports: pinocchio::sysvars::rent::Rent::get()
            .map(|r| r.try_minimum_balance(VoterWeightRecord::LEN).unwrap_or(0))
            .unwrap_or(0),
        space: VoterWeightRecord::LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[vwr_signer])?;

    // Initialize VoterWeightRecord: discriminator + realm/mint/owner, weight=0, expiry=0, action=0, target=zero
    let mut vwr_data = voter_weight_record_account.try_borrow_mut()?;
    VoterWeightRecord::store(
        &mut vwr_data,
        &realm,
        &governing_token_mint,
        governing_token_owner.address().as_array(),
        0,              // voter_weight
        0,              // voter_weight_expiry
        0,              // weight_action (CastVote)
        &[0u8; 32],    // weight_action_target
    );

    Ok(())
}
