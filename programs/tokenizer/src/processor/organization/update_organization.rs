use pinocchio::{
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    AccountView,
    Address,
    ProgramResult,
};

use crate::{
    error::TokenizerError,
    utils::Pk,
    state::{
        organization::{Organization, MAX_ORG_ACCEPTED_MINTS},
        protocol_config::ProtocolConfig,
        validate_account_key, AccountKey, ORGANIZATION_SEED, PROTOCOL_CONFIG_SEED,
    },
    validation::{require_owner, require_pda_with_bump, require_signer, require_writable},
};

/// Update organization fields (currently: manage accepted mints).
///
/// Instruction data layout:
/// [0]      field_selector: u8
///   0 = add_mint    → [1..33] Pubkey
///   1 = remove_mint → [1..33] Pubkey
///
/// Authority: org authority OR protocol operator.
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    let [config, org_account, authority, _system_program] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate protocol config
    require_owner(config, program_id, "config")?;
    let config_ref = config.try_borrow()?;
    validate_account_key(&config_ref, AccountKey::ProtocolConfig)?;
    let config_data = unsafe { ProtocolConfig::load(&config_ref) };
    require_pda_with_bump(config, &[PROTOCOL_CONFIG_SEED, &[config_data.bump]], program_id, "config")?;
    config_data.require_not_paused()?;

    // Validate organization
    require_owner(org_account, program_id, "org_account")?;
    require_writable(org_account, "org_account")?;
    let org_ref = org_account.try_borrow()?;
    validate_account_key(&org_ref, AccountKey::Organization)?;
    let org = unsafe { Organization::load(&org_ref) };

    if !org.is_active() {
        pinocchio_log::log!("org: not active");
        return Err(TokenizerError::OrganizationNotActive.into());
    }

    // Authority check: org authority OR protocol operator
    require_signer(authority, "authority")?;
    let is_org_authority = authority.address().as_array() == &org.authority;
    let is_operator = authority.address().as_array() == &config_data.operator;
    if !is_org_authority && !is_operator {
        pinocchio_log::log!("unauthorized: signer {} is neither org_authority nor operator", Pk(authority.address().as_array()));
        return Err(TokenizerError::Unauthorized.into());
    }

    let org_id = org.id;
    let org_bump = org.bump;
    drop(org_ref);
    drop(config_ref);

    require_pda_with_bump(
        org_account,
        &[ORGANIZATION_SEED, &org_id.to_le_bytes(), &[org_bump]],
        program_id,
        "org_account",
    )?;

    // Need at least the field_selector byte
    if data.is_empty() {
        return Err(TokenizerError::InstructionDataTooShort.into());
    }

    let field_selector = data[0];
    let payload = &data[1..];

    match field_selector {
        // add_mint: requires 32 bytes payload
        0 => {
            if payload.len() < 32 {
                return Err(TokenizerError::InstructionDataTooShort.into());
            }
            let mint: &[u8; 32] = payload[..32].try_into().unwrap();

            // Validate mint is in protocol's global whitelist
            let config_ref2 = config.try_borrow()?;
            let config_data2 = unsafe { ProtocolConfig::load(&config_ref2) };
            if !config_data2.is_mint_accepted(mint) {
                return Err(TokenizerError::MintNotAccepted.into());
            }
            drop(config_ref2);

            let mut org_mut = org_account.try_borrow_mut()?;
            let org = unsafe { Organization::load_mut(&mut org_mut) };

            if org.is_mint_accepted(mint) {
                return Err(TokenizerError::OrgMintAlreadyAccepted.into());
            }

            let count = org.accepted_mint_count as usize;
            if count >= MAX_ORG_ACCEPTED_MINTS {
                return Err(TokenizerError::OrgMaxMintsReached.into());
            }

            org.accepted_mints[count] = *mint;
            org.accepted_mint_count = org.accepted_mint_count
                .checked_add(1)
                .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;
            org.updated_at = Clock::get()?.unix_timestamp;
        }
        // remove_mint: requires 32 bytes payload
        1 => {
            if payload.len() < 32 {
                return Err(TokenizerError::InstructionDataTooShort.into());
            }
            let mint: &[u8; 32] = payload[..32].try_into().unwrap();

            let mut org_mut = org_account.try_borrow_mut()?;
            let org = unsafe { Organization::load_mut(&mut org_mut) };

            let count = org.accepted_mint_count as usize;
            let mut found = false;
            for i in 0..count {
                if &org.accepted_mints[i] == mint {
                    // Swap-remove
                    if i < count - 1 {
                        org.accepted_mints[i] = org.accepted_mints[count - 1];
                    }
                    org.accepted_mints[count - 1] = [0u8; 32];
                    org.accepted_mint_count = org.accepted_mint_count
                        .checked_sub(1)
                        .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;
                    found = true;
                    break;
                }
            }
            if !found {
                return Err(TokenizerError::OrgMintNotAccepted.into());
            }
            org.updated_at = Clock::get()?.unix_timestamp;
        }
        _ => return Err(TokenizerError::InvalidFieldSelector.into()),
    }

    Ok(())
}
