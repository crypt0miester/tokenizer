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
        protocol_config::{ProtocolConfig, MAX_ACCEPTED_MINTS},
        AccountKey, PROTOCOL_CONFIG_SEED,
    },
    utils::{read_u16, read_bytes32},
    validation::{require_pda, require_signer, require_system_program, require_writable},
};

/// Instruction data layout:
/// [0..2]   fee_bps: u16
/// [2..34]  fee_treasury: Pubkey
/// [34..66] accepted_mint: Pubkey (first accepted stablecoin)
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    let [config, operator, payer, system_program] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate
    require_signer(operator, "operator")?;
    require_signer(payer, "payer")?;
    require_writable(config, "config")?;
    require_writable(payer, "payer")?;
    require_system_program(system_program)?;

    let bump = require_pda(config, &[PROTOCOL_CONFIG_SEED], program_id, "config")?;

    // Config must be uninitialized
    if config.data_len() > 0 {
        return Err(TokenizerError::ProtocolAlreadyInitialized.into());
    }

    // Parse instruction data: fee_bps(2) + fee_treasury(32) + accepted_mint(32)
    let fee_bps = read_u16(data, 0, "fee_bps")?;
    if fee_bps > 1000 {
        // Max 10%
        return Err(TokenizerError::InvalidFee.into());
    }

    let fee_treasury_arr = read_bytes32(data, 2, "fee_treasury")?;
    let fee_treasury = &fee_treasury_arr;
    let accepted_mint_arr = read_bytes32(data, 34, "accepted_mint")?;
    let accepted_mint = &accepted_mint_arr;

    if fee_treasury == &[0u8; 32] {
        return Err(TokenizerError::ZeroAddressNotAllowed.into());
    }
    if accepted_mint == &[0u8; 32] {
        return Err(TokenizerError::ZeroAddressNotAllowed.into());
    }

    // Create the account
    let bump_bytes = [bump];
    let seeds = [
        Seed::from(PROTOCOL_CONFIG_SEED),
        Seed::from(&bump_bytes),
    ];
    let signer = Signer::from(&seeds);

    CreateAccount {
        from: payer,
        to: config,
        lamports: pinocchio::sysvars::rent::Rent::get()
            .map(|r| r.try_minimum_balance(ProtocolConfig::LEN).unwrap_or(0))
            .unwrap_or(0),
        space: ProtocolConfig::LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[signer])?;

    // Initialize state
    let mut data_ref = config.try_borrow_mut()?;
    let config_data = unsafe { ProtocolConfig::load_mut(&mut data_ref) };

    config_data.account_key = AccountKey::ProtocolConfig as u8;
    config_data.version = 1;
    config_data.operator = operator.address().to_bytes();
    config_data.realm = [0u8; 32];
    config_data.governance = [0u8; 32];
    config_data.fee_bps = fee_bps;
    config_data.fee_treasury = *fee_treasury;
    config_data.paused = 0;
    config_data.accepted_mint_count = 1;
    config_data.accepted_mints = [[0u8; 32]; MAX_ACCEPTED_MINTS];
    config_data.accepted_mints[0] = *accepted_mint;
    config_data.total_organizations = 0;
    config_data.bump = bump;

    Ok(())
}
