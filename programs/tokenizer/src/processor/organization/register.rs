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
        organization::{Organization, MAX_NAME_LEN, MAX_REG_NUMBER_LEN},
        protocol_config::ProtocolConfig,
        validate_account_key, AccountKey, ORGANIZATION_SEED, PROTOCOL_CONFIG_SEED,
    },
    validation::{
        require_owner, require_pda, require_pda_with_bump, require_signer,
        require_system_program, require_writable,
    },
};

/// Register a new organization. Operator-only.
///
/// Instruction data layout:
/// [0..32]  authority: Pubkey (org admin)
/// [32]     name_len: u8
/// [33..33+name_len]  name bytes
/// then:    reg_number_len: u8
/// then:    reg_number bytes
/// then:    country: [u8; 4]
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    let [config, org_account, operator, payer, system_program] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate protocol config
    require_owner(config, program_id, "config")?;
    require_writable(config, "config")?;
    let config_ref = config.try_borrow()?;
    validate_account_key(&config_ref, AccountKey::ProtocolConfig)?;
    let config_data = unsafe { ProtocolConfig::load(&config_ref) };
    require_pda_with_bump(config, &[PROTOCOL_CONFIG_SEED, &[config_data.bump]], program_id, "config")?;
    config_data.require_not_paused()?;
    config_data.require_operator(operator)?;

    let org_id = config_data.total_organizations;
    drop(config_ref);

    // Validate org account
    require_writable(org_account, "org_account")?;
    require_signer(payer, "payer")?;
    require_system_program(system_program)?;

    let org_id_bytes = org_id.to_le_bytes();
    let bump = require_pda(
        org_account,
        &[ORGANIZATION_SEED, &org_id_bytes],
        program_id,
        "org_account",
    )?;

    if org_account.data_len() > 0 {
        return Err(TokenizerError::OrganizationAlreadyActive.into());
    }

    // Parse instruction data: authority(32) + name_len(1) + name + reg_number_len(1) + reg_number + country(4)
    if data.len() < 37 {
        return Err(TokenizerError::InstructionDataTooShort.into());
    }

    let authority: &[u8; 32] = data[0..32].try_into().unwrap();

    let name_len = data[32] as usize;
    if name_len == 0 || name_len > MAX_NAME_LEN {
        return Err(TokenizerError::InvalidNameLength.into());
    }

    let mut offset = 33;
    if data.len() < offset + name_len + 1 {
        return Err(TokenizerError::InstructionDataTooShort.into());
    }
    let name_bytes = &data[offset..offset + name_len];
    offset += name_len;

    let reg_number_len = data[offset] as usize;
    offset += 1;
    if reg_number_len > MAX_REG_NUMBER_LEN {
        return Err(TokenizerError::InvalidRegistrationNumber.into());
    }

    if data.len() < offset + reg_number_len + 4 {
        return Err(TokenizerError::InstructionDataTooShort.into());
    }
    let reg_number_bytes = &data[offset..offset + reg_number_len];
    offset += reg_number_len;

    let country: [u8; 4] = data[offset..offset + 4].try_into().unwrap();

    // Create account
    let bump_bytes = [bump];
    let seeds = [
        Seed::from(ORGANIZATION_SEED),
        Seed::from(org_id_bytes.as_ref()),
        Seed::from(&bump_bytes),
    ];
    let signer = Signer::from(&seeds);

    CreateAccount {
        from: payer,
        to: org_account,
        lamports: pinocchio::sysvars::rent::Rent::get()
            .map(|r| r.try_minimum_balance(Organization::LEN).unwrap_or(0))
            .unwrap_or(0),
        space: Organization::LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[signer])?;

    // Initialize
    let clock = Clock::get()?;
    let mut org_data_ref = org_account.try_borrow_mut()?;
    let org = unsafe { Organization::load_mut(&mut org_data_ref) };

    org.account_key = AccountKey::Organization as u8;
    org.version = 1;
    org.id = org_id;
    org.authority = *authority;

    org.name = [0u8; MAX_NAME_LEN];
    org.name[..name_len].copy_from_slice(name_bytes);
    org.name_len = name_len as u8;

    org.registration_number = [0u8; MAX_REG_NUMBER_LEN];
    if reg_number_len > 0 {
        org.registration_number[..reg_number_len].copy_from_slice(reg_number_bytes);
    }
    org.registration_number_len = reg_number_len as u8;

    org.country = country;
    org.is_active = 1;
    org.asset_count = 0;
    org.realm = [0u8; 32];
    org.accepted_mint_count = 0;
    org.accepted_mints = [[0u8; 32]; 4];
    org.created_at = clock.unix_timestamp;
    org.updated_at = clock.unix_timestamp;
    org.bump = bump;

    drop(org_data_ref);

    // Increment org count on protocol config
    let mut config_mut = config.try_borrow_mut()?;
    let config_data = unsafe { ProtocolConfig::load_mut(&mut config_mut) };
    config_data.total_organizations = org_id
        .checked_add(1)
        .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;

    Ok(())
}
