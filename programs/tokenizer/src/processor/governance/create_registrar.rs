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
        validate_account_key, AccountKey,
        REGISTRAR_SEED,
    },
    utils::read_bytes32,
    validation::{
        require_owner, require_pda, require_signer, require_system_program, require_writable,
    },
};

/// Create a voter weight plugin registrar for a realm + governing_token_mint.
///
/// Accounts (7):
///   0. realm                    — spl-gov realm account (read, verify exists)
///   1. governing_token_mint     — SPL mint
///   2. asset                    — Asset account (verify owned by program)
///   3. registrar(w)             — PDA to create
///   4. realm_authority(s)       — must sign
///   5. payer(s,w)
///   6. system_program
///
/// Data: [0..32] governance_program_id
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    let [
        realm,
        governing_token_mint,
        asset_account,
        registrar_account,
        realm_authority,
        payer,
        system_program,
    ] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Parse governance_program_id from instruction data
    let governance_program_id = read_bytes32(data, 0, "governance_program_id")?;

    // Validate realm is owned by governance_program_id
    let realm_owner = unsafe { realm.owner() };
    if realm_owner.as_ref() != &governance_program_id {
        return Err(TokenizerError::InvalidGovernanceProgram.into());
    }

    // Validate realm account discriminator and authority
    let realm_ref = realm.try_borrow()?;
    if !p_gov::state::realm::RealmV2::check_account_type(&realm_ref) {
        return Err(ProgramError::InvalidAccountData);
    }
    let realm_auth = p_gov::state::realm::RealmV2::authority(&realm_ref)
        .ok_or::<ProgramError>(TokenizerError::InvalidRealmAuthority.into())?;
    if realm_authority.address().as_array() != realm_auth {
        return Err(TokenizerError::InvalidRealmAuthority.into());
    }

    // Validate governing_token_mint is the realm's council mint
    let mint_ref = governing_token_mint.address().as_ref();
    let is_council = p_gov::state::realm::RealmV2::council_mint(&realm_ref)
        .map_or(false, |cm| cm == mint_ref);
    if !is_council {
        pinocchio_log::log!("governing_token_mint does not match realm council mint");
        return Err(TokenizerError::InvalidGoverningTokenMint.into());
    }
    drop(realm_ref);

    // Validate asset is owned by tokenizer program
    require_owner(asset_account, program_id, "asset_account")?;
    let asset_ref = asset_account.try_borrow()?;
    validate_account_key(&asset_ref, AccountKey::Asset)?;
    drop(asset_ref);

    // Validate signers
    require_signer(realm_authority, "realm_authority")?;
    require_signer(payer, "payer")?;
    require_writable(payer, "payer")?;
    require_writable(registrar_account, "registrar_account")?;
    require_system_program(system_program)?;

    // Derive and validate registrar PDA
    let registrar_bump = require_pda(
        registrar_account,
        &[REGISTRAR_SEED, realm.address().as_ref(), governing_token_mint.address().as_ref()],
        program_id,
        "registrar_account",
    )?;

    // Create Registrar PDA account
    let registrar_bump_bytes = [registrar_bump];
    let registrar_seeds = [
        Seed::from(REGISTRAR_SEED),
        Seed::from(realm.address().as_ref()),
        Seed::from(governing_token_mint.address().as_ref()),
        Seed::from(&registrar_bump_bytes),
    ];
    let registrar_signer = Signer::from(&registrar_seeds);

    CreateAccount {
        from: payer,
        to: registrar_account,
        lamports: pinocchio::sysvars::rent::Rent::get()
            .map(|r| r.try_minimum_balance(Registrar::LEN).unwrap_or(0))
            .unwrap_or(0),
        space: Registrar::LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[registrar_signer])?;

    // Initialize Registrar state
    let mut reg_data = registrar_account.try_borrow_mut()?;
    let reg = unsafe { Registrar::load_mut(&mut reg_data) };
    reg.account_key = AccountKey::Registrar as u8;
    reg.version = 1;
    reg.governance_program_id = governance_program_id;
    reg.realm = realm.address().to_bytes();
    reg.governing_token_mint = governing_token_mint.address().to_bytes();
    reg.asset = asset_account.address().to_bytes();
    reg.bump = registrar_bump;

    Ok(())
}
