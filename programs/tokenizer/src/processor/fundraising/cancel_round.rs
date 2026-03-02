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
        asset::Asset,
        fundraising_round::FundraisingRound,
        organization::Organization,
        protocol_config::ProtocolConfig,
        validate_account_key, AccountKey, AssetStatus, RoundStatus,
        ASSET_SEED, FUNDRAISING_ROUND_SEED, ORGANIZATION_SEED, PROTOCOL_CONFIG_SEED,
    },
    validation::{
        require_owner, require_pda_with_bump, require_signer, require_writable,
    },
};
use crate::utils::Pk;

/// Cancel an active fundraising round. Organization authority only.
/// After cancellation, investors can claim refunds via refund_investment.
///
/// Accounts:
///   0. config         — ProtocolConfig (read)
///   1. org_account    — Organization (read)
///   2. asset_account  — Asset (writable)
///   3. round_account  — FundraisingRound (writable)
///   4. authority      — Org authority, signer
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    _data: &[u8],
) -> ProgramResult {
    let [
        config,
        org_account,
        asset_account,
        round_account,
        authority,
    ] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate protocol
    require_owner(config, program_id, "config")?;
    let config_ref = config.try_borrow()?;
    validate_account_key(&config_ref, AccountKey::ProtocolConfig)?;
    let config_data = unsafe { ProtocolConfig::load(&config_ref) };
    config_data.require_not_paused()?;
    let config_bump = config_data.bump;
    drop(config_ref);
    require_pda_with_bump(config, &[PROTOCOL_CONFIG_SEED, &[config_bump]], program_id, "config")?;

    // Validate organization
    require_owner(org_account, program_id, "org_account")?;
    let org_ref = org_account.try_borrow()?;
    validate_account_key(&org_ref, AccountKey::Organization)?;
    let org = unsafe { Organization::load(&org_ref) };
    let org_id = org.id;
    let org_bump = org.bump;

    // Validate authority
    require_signer(authority, "authority")?;
    if authority.address().as_array() != &org.authority {
        pinocchio_log::log!("org.authority: expected {}, got {}", Pk(&org.authority), Pk(authority.address().as_array()));
        return Err(TokenizerError::InvalidAuthority.into());
    }
    drop(org_ref);

    require_pda_with_bump(
        org_account,
        &[ORGANIZATION_SEED, &org_id.to_le_bytes(), &[org_bump]],
        program_id,
        "org_account",
    )?;

    // Validate asset
    require_owner(asset_account, program_id, "asset_account")?;
    require_writable(asset_account, "asset_account")?;
    let asset_ref = asset_account.try_borrow()?;
    validate_account_key(&asset_ref, AccountKey::Asset)?;
    let asset = unsafe { Asset::load(&asset_ref) };
    let asset_id = asset.id;
    let asset_bump = asset.bump;
    drop(asset_ref);

    require_pda_with_bump(
        asset_account,
        &[ASSET_SEED, org_account.address().as_ref(), &asset_id.to_le_bytes(), &[asset_bump]],
        program_id,
        "asset_account",
    )?;

    // Validate round
    require_owner(round_account, program_id, "round_account")?;
    require_writable(round_account, "round_account")?;
    let round_ref = round_account.try_borrow()?;
    validate_account_key(&round_ref, AccountKey::FundraisingRound)?;
    let round = unsafe { FundraisingRound::load(&round_ref) };

    if round.status() != RoundStatus::Active {
        pinocchio_log::log!("round.status: {}", round.status);
        return Err(TokenizerError::RoundNotActive.into());
    }

    // Verify round belongs to this asset
    if &round.asset != asset_account.address().as_array() {
        pinocchio_log::log!("round.asset: expected {}, got {}", Pk(&round.asset), Pk(asset_account.address().as_array()));
        return Err(TokenizerError::RoundAssetMismatch.into());
    }

    let round_index = round.round_index;
    let round_bump = round.bump;
    drop(round_ref);

    require_pda_with_bump(
        round_account,
        &[FUNDRAISING_ROUND_SEED, asset_account.address().as_ref(), &round_index.to_le_bytes(), &[round_bump]],
        program_id,
        "round_account",
    )?;

    // Update round status to Cancelled
    let clock = Clock::get()?;
    let mut round_mut = round_account.try_borrow_mut()?;
    let round = unsafe { FundraisingRound::load_mut(&mut round_mut) };
    round.status = RoundStatus::Cancelled as u8;
    round.updated_at = clock.unix_timestamp;
    drop(round_mut);

    // Revert asset status to Draft
    let mut asset_mut = asset_account.try_borrow_mut()?;
    let asset = unsafe { Asset::load_mut(&mut asset_mut) };
    asset.status = AssetStatus::Draft as u8;
    asset.updated_at = clock.unix_timestamp;

    Ok(())
}
