use pinocchio::{
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    AccountView, Address, ProgramResult,
};

use crate::{
    error::TokenizerError,
    state::{
        asset::Asset,
        organization::Organization,
        validate_account_key, AccountKey, OracleSource,
        ASSET_SEED, ORGANIZATION_SEED, PYTH_PROGRAM_ID, SWITCHBOARD_PROGRAM_ID,
    },
    utils::{read_u8, read_u16, read_u32, read_u64, read_bytes32, Pk},
    validation::{
        require_owner, require_pda_with_bump, require_signer, require_writable,
    },
};

/// Configure or update oracle pricing on an asset.
///
/// Requires org authority signature (governance-gated).
/// Can also be used to remove oracle (set oracle_source = 0).
///
/// Instruction data layout (79 bytes):
/// [0]      oracle_source: u8 (0=None, 1=Pyth, 2=Switchboard)
/// [1..5]   oracle_max_staleness: u32
/// [5..7]   oracle_max_confidence_bps: u16
/// [7]      accepted_mint_decimals: u8
/// [8..16]  shares_per_unit: u64
/// [16..48] oracle_feed: [u8; 32]
///
/// Accounts:
///   0. org (ro)          - Organization
///   1. asset (wr)        - Asset PDA
///   2. oracle_feed (ro)  - Oracle feed account (validated for owner)
///   3. authority (signer) - Organization authority
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    let [
        org_account,
        asset_account,
        oracle_feed_account,
        authority,
    ] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Parse instruction data
    let oracle_source = read_u8(data, 0, "oracle_source")?;
    let oracle_max_staleness = read_u32(data, 1, "oracle_max_staleness")?;
    let oracle_max_confidence_bps = read_u16(data, 5, "oracle_max_confidence_bps")?;
    let accepted_mint_decimals = read_u8(data, 7, "accepted_mint_decimals")?;
    let shares_per_unit = read_u64(data, 8, "shares_per_unit")?;
    let oracle_feed = read_bytes32(data, 16, "oracle_feed")?;

    let source = OracleSource::try_from(oracle_source)?;

    // Validate organization
    require_owner(org_account, program_id, "org_account")?;
    let org_ref = org_account.try_borrow()?;
    validate_account_key(&org_ref, AccountKey::Organization)?;
    let org = unsafe { Organization::load(&org_ref) };

    if !org.is_active() {
        return Err(TokenizerError::OrganizationNotActive.into());
    }

    // Verify authority matches org authority
    require_signer(authority, "authority")?;
    if authority.address().as_array() != &org.authority {
        pinocchio_log::log!(
            "authority mismatch: expected {}, got {}",
            Pk(&org.authority),
            Pk(authority.address().as_array())
        );
        return Err(TokenizerError::InvalidAuthority.into());
    }

    let org_id = org.id;
    let org_bump = org.bump;
    drop(org_ref);

    require_pda_with_bump(
        org_account,
        &[ORGANIZATION_SEED, &org_id.to_le_bytes(), &[org_bump]],
        program_id,
        "org_account",
    )?;

    // Validate asset
    require_owner(asset_account, program_id, "asset")?;
    require_writable(asset_account, "asset")?;
    let asset_ref = asset_account.try_borrow()?;
    validate_account_key(&asset_ref, AccountKey::Asset)?;
    let asset = unsafe { Asset::load(&asset_ref) };

    // Verify asset belongs to this org
    if &asset.organization != org_account.address().as_array() {
        return Err(TokenizerError::Unauthorized.into());
    }

    let asset_id = asset.id;
    let asset_bump = asset.bump;
    drop(asset_ref);

    require_pda_with_bump(
        asset_account,
        &[ASSET_SEED, org_account.address().as_ref(), &asset_id.to_le_bytes(), &[asset_bump]],
        program_id,
        "asset",
    )?;

    let zero_key = [0u8; 32];

    if source != OracleSource::None {
        // Validate oracle feed account
        if oracle_feed == zero_key {
            return Err(TokenizerError::OracleNotConfigured.into());
        }
        if shares_per_unit == 0 {
            return Err(TokenizerError::InvalidShareCount.into());
        }

        // Verify the passed oracle_feed account matches the pubkey in instruction data
        if oracle_feed_account.address().as_array() != &oracle_feed {
            pinocchio_log::log!(
                "oracle_feed mismatch: data={}, account={}",
                Pk(&oracle_feed),
                Pk(oracle_feed_account.address().as_array())
            );
            return Err(TokenizerError::OracleFeedMismatch.into());
        }

        // Validate oracle feed account is owned by the correct oracle program
        let feed_owner = unsafe { oracle_feed_account.owner() };
        match source {
            OracleSource::Pyth => {
                if feed_owner.as_array() != &PYTH_PROGRAM_ID {
                    pinocchio_log::log!(
                        "oracle feed owner: expected Pyth {}, got {}",
                        Pk(&PYTH_PROGRAM_ID),
                        Pk(feed_owner.as_array())
                    );
                    return Err(TokenizerError::InvalidOracleProgram.into());
                }
                // Validate it's a real Pyth price account (magic, version, type)
                let feed_data = oracle_feed_account.try_borrow()?;
                let _ = unsafe { p_pyth::PythPriceAccount::load(&feed_data) }
                    .map_err(|_| -> ProgramError { TokenizerError::OraclePriceInvalid.into() })?;
            }
            OracleSource::Switchboard => {
                if feed_owner.as_array() != &SWITCHBOARD_PROGRAM_ID {
                    pinocchio_log::log!(
                        "oracle feed owner: expected Switchboard {}, got {}",
                        Pk(&SWITCHBOARD_PROGRAM_ID),
                        Pk(feed_owner.as_array())
                    );
                    return Err(TokenizerError::InvalidOracleProgram.into());
                }
                // Validate discriminator matches PullFeedAccountData
                let feed_data = oracle_feed_account.try_borrow()?;
                p_switchboard::validate_discriminator(&feed_data)
                    .map_err(|_| -> ProgramError { TokenizerError::OraclePriceInvalid.into() })?;
            }
            OracleSource::None => unreachable!(),
        }
    }

    // Apply oracle config to asset
    let clock = Clock::get()?;
    let mut asset_mut = asset_account.try_borrow_mut()?;
    let asset = unsafe { Asset::load_mut(&mut asset_mut) };
    asset.oracle_source = oracle_source;
    asset.oracle_feed = if source != OracleSource::None { oracle_feed } else { zero_key };
    asset.shares_per_unit = shares_per_unit;
    asset.oracle_max_staleness = oracle_max_staleness;
    asset.oracle_max_confidence_bps = oracle_max_confidence_bps;
    asset.accepted_mint_decimals = accepted_mint_decimals;
    asset.last_oracle_update = 0;
    asset.updated_at = clock.unix_timestamp;

    Ok(())
}
