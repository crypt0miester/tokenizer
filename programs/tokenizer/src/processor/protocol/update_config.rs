use pinocchio::{error::ProgramError, AccountView, Address, ProgramResult};

use crate::{
    error::TokenizerError,
    state::{
        protocol_config::ProtocolConfig,
        validate_account_key, AccountKey, PROTOCOL_CONFIG_SEED,
    },
    utils::{read_u16, read_bytes32},
    validation::{require_owner, require_pda_with_bump, require_writable},
};

/// Update fields on the ProtocolConfig.
///
/// Instruction data layout:
/// [0]      field_selector: u8
///   0 = fee_bps                    → [1..3]  u16
///   1 = fee_treasury               → [1..33] Pubkey
///   3 = add_mint                   → [1..33] Pubkey
///   4 = remove_mint                → [1..33] Pubkey
///   5 = set_operator               → [1..33] Pubkey (direct transfer, operator is a multisig)
///   6 = min_proposal_weight_bps    → [1..3]  u16 (0–10000 bps)
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    let [config, operator] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    require_writable(config, "config")?;
    require_owner(config, program_id, "config")?;
    let config_ref = config.try_borrow()?;
    validate_account_key(&config_ref, AccountKey::ProtocolConfig)?;
    let config_data = unsafe { ProtocolConfig::load(&config_ref) };
    require_pda_with_bump(config, &[PROTOCOL_CONFIG_SEED, &[config_data.bump]], program_id, "config")?;
    config_data.require_operator(operator)?;
    drop(config_ref);

    // Need at least the field_selector byte
    if data.is_empty() {
        return Err(TokenizerError::InstructionDataTooShort.into());
    }

    let field_selector = data[0];
    let payload = &data[1..];

    let mut data_ref = config.try_borrow_mut()?;
    let config_data = unsafe { ProtocolConfig::load_mut(&mut data_ref) };

    match field_selector {
        // fee_bps: requires 2 bytes payload
        0 => {
            let fee_bps = read_u16(payload, 0, "fee_bps")?;
            if fee_bps > 1000 {
                return Err(TokenizerError::InvalidFee.into());
            }
            config_data.fee_bps = fee_bps;
        }
        // fee_treasury: requires 32 bytes payload
        1 => {
            let value = read_bytes32(payload, 0, "fee_treasury")?;
            if value == [0u8; 32] {
                return Err(TokenizerError::ZeroAddressNotAllowed.into());
            }
            config_data.fee_treasury = value;
        }
        // add_mint: requires 32 bytes payload
        3 => {
            let mint_arr = read_bytes32(payload, 0, "add_mint")?;
            let mint = &mint_arr;
            if config_data.is_mint_accepted(mint) {
                return Err(TokenizerError::MintAlreadyAccepted.into());
            }
            let count = config_data.accepted_mint_count as usize;
            if count >= crate::state::protocol_config::MAX_ACCEPTED_MINTS {
                return Err(TokenizerError::MaxMintsReached.into());
            }
            config_data.accepted_mints[count] = *mint;
            config_data.accepted_mint_count = config_data.accepted_mint_count
                .checked_add(1)
                .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;
        }
        // remove_mint: requires 32 bytes payload
        4 => {
            let mint_arr = read_bytes32(payload, 0, "remove_mint")?;
            let mint = &mint_arr;
            let count = config_data.accepted_mint_count as usize;
            let mut found = false;
            for i in 0..count {
                if &config_data.accepted_mints[i] == mint {
                    // Swap-remove
                    if i < count - 1 {
                        config_data.accepted_mints[i] =
                            config_data.accepted_mints[count - 1];
                    }
                    config_data.accepted_mints[count - 1] = [0u8; 32];
                    config_data.accepted_mint_count = config_data.accepted_mint_count
                        .checked_sub(1)
                        .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;
                    found = true;
                    break;
                }
            }
            if !found {
                return Err(TokenizerError::MintNotAccepted.into());
            }
        }
        // set_operator: requires 32 bytes payload (direct transfer, operator is a multisig)
        5 => {
            let value = read_bytes32(payload, 0, "operator")?;
            if value == [0u8; 32] {
                return Err(TokenizerError::ZeroAddressNotAllowed.into());
            }
            config_data.operator = value;
        }
        // min_proposal_weight_bps: requires 2 bytes payload (0–10000 bps)
        6 => {
            let bps = read_u16(payload, 0, "min_proposal_weight_bps")?;
            if bps > 10_000 {
                return Err(TokenizerError::InvalidFee.into());
            }
            config_data.min_proposal_weight_bps = bps;
        }
        _ => return Err(TokenizerError::InvalidFieldSelector.into()),
    }

    Ok(())
}
