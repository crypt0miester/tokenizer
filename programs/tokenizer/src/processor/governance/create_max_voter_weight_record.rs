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
        asset::Asset,
        registrar::Registrar,
        max_voter_weight_record::MaxVoterWeightRecord,
        validate_account_key, AccountKey,
        REGISTRAR_SEED, MAX_VOTER_WEIGHT_RECORD_SEED,
    },
    validation::{
        require_owner, require_pda_with_bump, require_pda, require_signer,
        require_system_program, require_writable,
    },
};

/// Create (or refresh) a max voter weight record for a realm.
///
/// Accounts (6):
///   0. registrar
///   1. asset                      — read minted_shares for max weight
///   2. max_voter_weight_record(w) — PDA to create or update
///   3. realm
///   4. payer(s,w)
///   5. system_program
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    _data: &[u8],
) -> ProgramResult {
    let [
        registrar_account,
        asset_account,
        max_vwr_account,
        _realm,
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
    let registrar_asset = reg.asset;
    let reg_bump = reg.bump;
    drop(reg_ref);

    require_pda_with_bump(
        registrar_account,
        &[REGISTRAR_SEED, &realm, &governing_token_mint, &[reg_bump]],
        program_id,
        "registrar_account",
    )?;

    // Validate asset
    require_owner(asset_account, program_id, "asset_account")?;
    let asset_ref = asset_account.try_borrow()?;
    validate_account_key(&asset_ref, AccountKey::Asset)?;
    let asset = unsafe { Asset::load(&asset_ref) };

    if asset_account.address().as_array() != &registrar_asset {
        return Err(TokenizerError::AssetRegistrarMismatch.into());
    }

    let minted_shares = asset.minted_shares;
    drop(asset_ref);

    // Validate signers/writable
    require_signer(payer, "payer")?;
    require_writable(payer, "payer")?;
    require_writable(max_vwr_account, "max_vwr_account")?;
    require_system_program(system_program)?;

    // Derive MaxVoterWeightRecord PDA
    let mvwr_bump = require_pda(
        max_vwr_account,
        &[MAX_VOTER_WEIGHT_RECORD_SEED, &realm, &governing_token_mint],
        program_id,
        "max_vwr_account",
    )?;

    let already_exists = max_vwr_account.data_len() != 0;

    if !already_exists {
        // Create MaxVoterWeightRecord PDA account
        let mvwr_bump_bytes = [mvwr_bump];
        let mvwr_seeds = [
            Seed::from(MAX_VOTER_WEIGHT_RECORD_SEED),
            Seed::from(realm.as_ref()),
            Seed::from(governing_token_mint.as_ref()),
            Seed::from(&mvwr_bump_bytes),
        ];
        let mvwr_signer = Signer::from(&mvwr_seeds);

        CreateAccount {
            from: payer,
            to: max_vwr_account,
            lamports: pinocchio::sysvars::rent::Rent::get()
                .map(|r| r.try_minimum_balance(MaxVoterWeightRecord::LEN).unwrap_or(0))
                .unwrap_or(0),
            space: MaxVoterWeightRecord::LEN as u64,
            owner: program_id,
        }
        .invoke_signed(&[mvwr_signer])?;
    }

    // Write (or overwrite) max voter weight record
    let mut mvwr_data = max_vwr_account.try_borrow_mut()?;
    MaxVoterWeightRecord::store(
        &mut mvwr_data,
        &realm,
        &governing_token_mint,
        minted_shares,  // max_voter_weight = all minted shares could vote
        0,              // expiry value (unused when has_expiry=false)
        false,          // no expiry — caller can refresh via this same instruction
    );

    Ok(())
}
