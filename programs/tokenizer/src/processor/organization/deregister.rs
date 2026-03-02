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
        organization::Organization,
        protocol_config::ProtocolConfig,
        validate_account_key, AccountKey, ORGANIZATION_SEED, PROTOCOL_CONFIG_SEED,
    },
    validation::{require_owner, require_pda_with_bump, require_writable},
};

/// Deregister (deactivate) an organization. Operator-only.
///
/// Instruction data layout:
/// [0..4] org_id: u32
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    let [config, org_account, operator] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate protocol config
    require_owner(config, program_id, "config")?;
    let config_ref = config.try_borrow()?;
    validate_account_key(&config_ref, AccountKey::ProtocolConfig)?;
    let config_data = unsafe { ProtocolConfig::load(&config_ref) };
    require_pda_with_bump(config, &[PROTOCOL_CONFIG_SEED, &[config_data.bump]], program_id, "config")?;
    config_data.require_not_paused()?;
    config_data.require_operator(operator)?;
    drop(config_ref);

    // Parse org_id: requires 4 bytes
    if data.len() < 4 {
        return Err(TokenizerError::InstructionDataTooShort.into());
    }
    let org_id = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);

    // Validate org account
    require_writable(org_account, "org_account")?;
    require_owner(org_account, program_id, "org_account")?;

    let mut org_data_ref = org_account.try_borrow_mut()?;
    validate_account_key(&org_data_ref, AccountKey::Organization)?;
    let org = unsafe { Organization::load_mut(&mut org_data_ref) };

    require_pda_with_bump(
        org_account,
        &[ORGANIZATION_SEED, &org_id.to_le_bytes(), &[org.bump]],
        program_id,
        "org_account",
    )?;

    if !org.is_active() {
        pinocchio_log::log!("org: not active");
        return Err(TokenizerError::OrganizationNotActive.into());
    }

    if org.asset_count > 0 {
        pinocchio_log::log!("org: has {} active assets", org.asset_count);
        return Err(TokenizerError::OrgHasActiveAssets.into());
    }

    let clock = Clock::get()?;
    org.is_active = 0;
    org.updated_at = clock.unix_timestamp;

    Ok(())
}
