use pinocchio::{error::ProgramError, AccountView, Address, ProgramResult};

use crate::{
    error::TokenizerError,
    state::{
        protocol_config::ProtocolConfig, validate_account_key, AccountKey,
        PROTOCOL_CONFIG_SEED,
    },
    validation::{require_owner, require_pda_with_bump, require_writable},
};

pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    _data: &[u8],
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

    if !config_data.is_paused() {
        return Err(TokenizerError::ProtocolNotPaused.into());
    }
    drop(config_ref);

    let mut data_ref = config.try_borrow_mut()?;
    let config_data = unsafe { ProtocolConfig::load_mut(&mut data_ref) };
    config_data.paused = 0;

    Ok(())
}
