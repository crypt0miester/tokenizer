use pinocchio::{
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    AccountView, Address, ProgramResult,
};

use crate::{
    error::TokenizerError,
    state::{
        asset::Asset,
        validate_account_key, AccountKey, OracleSource,
        ASSET_SEED, PYTH_PROGRAM_ID, SWITCHBOARD_PROGRAM_ID,
    },
    validation::{require_owner, require_pda_with_bump, require_writable},
};

/// Refresh the asset's price_per_share from an oracle feed.
///
/// This instruction is permissionless — anyone can crank it.
///
/// Accounts:
///   0. asset (wr)         - Asset with oracle configured
///   1. oracle_feed (ro)   - Pyth price account or Switchboard pull feed
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    _data: &[u8],
) -> ProgramResult {
    let [asset_account, oracle_feed_account] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate asset
    require_owner(asset_account, program_id, "asset")?;
    require_writable(asset_account, "asset")?;
    let asset_ref = asset_account.try_borrow()?;
    validate_account_key(&asset_ref, AccountKey::Asset)?;
    let asset = unsafe { Asset::load(&asset_ref) };

    let oracle_source = OracleSource::try_from(asset.oracle_source)?;
    if oracle_source == OracleSource::None {
        return Err(TokenizerError::OracleNotConfigured.into());
    }

    // Verify the oracle feed account matches what's stored on the asset
    if oracle_feed_account.address().as_array() != &asset.oracle_feed {
        return Err(TokenizerError::OracleFeedMismatch.into());
    }

    let max_staleness = asset.oracle_max_staleness;
    let max_confidence_bps = asset.oracle_max_confidence_bps;
    let shares_per_unit = asset.shares_per_unit;
    let mint_decimals = asset.accepted_mint_decimals;
    let asset_bump = asset.bump;
    let asset_id = asset.id;
    let org = asset.organization;
    drop(asset_ref);

    // Verify asset PDA
    require_pda_with_bump(
        asset_account,
        &[ASSET_SEED, &org, &asset_id.to_le_bytes(), &[asset_bump]],
        program_id,
        "asset",
    )?;

    let clock = Clock::get()?;
    let current_slot = clock.slot;

    // Read oracle price based on source
    let new_price_per_share: u64 = match oracle_source {
        OracleSource::Pyth => {
            // Validate owner is Pyth program
            let feed_owner = unsafe { oracle_feed_account.owner() };
            if feed_owner.as_array() != &PYTH_PROGRAM_ID {
                return Err(TokenizerError::InvalidOracleProgram.into());
            }

            let feed_data = oracle_feed_account.try_borrow()?;
            let oracle_price = if max_confidence_bps > 0 {
                p_pyth::load_pyth_price_with_confidence(
                    &feed_data,
                    current_slot,
                    max_staleness as u64,
                    max_confidence_bps,
                )
            } else {
                p_pyth::load_pyth_price(&feed_data, current_slot, max_staleness as u64)
            };

            let price = oracle_price.map_err(|_| -> ProgramError {
                TokenizerError::OraclePriceStale.into()
            })?;

            // Convert: oracle price (with exponent) → stablecoin units per unit of underlying
            // Then divide by shares_per_unit to get price_per_share
            let target_expo = -(mint_decimals as i32);
            let unit_price = price
                .get_price_in_target_expo(target_expo)
                .ok_or::<ProgramError>(TokenizerError::OracleConversionOverflow.into())?;

            unit_price
                .checked_div(shares_per_unit)
                .ok_or::<ProgramError>(TokenizerError::OracleConversionOverflow.into())?
        }

        OracleSource::Switchboard => {
            // Validate owner is Switchboard on-demand program
            let feed_owner = unsafe { oracle_feed_account.owner() };
            if feed_owner.as_array() != &SWITCHBOARD_PROGRAM_ID {
                return Err(TokenizerError::InvalidOracleProgram.into());
            }

            let feed_data = oracle_feed_account.try_borrow()?;
            let sb_price = if max_confidence_bps > 0 {
                p_switchboard::load_switchboard_price_with_confidence(
                    &feed_data,
                    current_slot,
                    max_staleness as u64,
                    max_confidence_bps,
                )
            } else {
                p_switchboard::load_switchboard_price(
                    &feed_data,
                    current_slot,
                    max_staleness as u64,
                )
            };

            let price = sb_price.map_err(|_| -> ProgramError {
                TokenizerError::OraclePriceStale.into()
            })?;

            // Switchboard values are i128 scaled by 10^18.
            // Convert to stablecoin decimals, then divide by shares_per_unit.
            let unit_price = price
                .get_price_in_decimals(mint_decimals as u32)
                .ok_or::<ProgramError>(TokenizerError::OracleConversionOverflow.into())?;

            unit_price
                .checked_div(shares_per_unit)
                .ok_or::<ProgramError>(TokenizerError::OracleConversionOverflow.into())?
        }

        OracleSource::None => unreachable!(),
    };

    if new_price_per_share == 0 {
        return Err(TokenizerError::OraclePriceInvalid.into());
    }

    // Update asset
    let mut asset_mut = asset_account.try_borrow_mut()?;
    let asset = unsafe { Asset::load_mut(&mut asset_mut) };
    asset.price_per_share = new_price_per_share;
    asset.last_oracle_update = clock.unix_timestamp;
    asset.updated_at = clock.unix_timestamp;

    Ok(())
}
