use pinocchio::{
    cpi::{Seed, Signer},
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    AccountView,
    Address,
    ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;

use p_core::instructions::CreateCollectionV1;
use p_core::state::MAX_URI_LEN;

use crate::{
    error::TokenizerError,
    state::{
        asset::Asset,
        organization::Organization,
        protocol_config::ProtocolConfig,
        validate_account_key, AccountKey, AssetStatus, OracleSource,
        ASSET_SEED, COLLECTION_AUTHORITY_SEED, ORGANIZATION_SEED, PROTOCOL_CONFIG_SEED,
        PYTH_PROGRAM_ID, SWITCHBOARD_PROGRAM_ID,
    },
    validation::{
        require_mpl_core_program, require_owner, require_pda, require_pda_with_bump,
        require_signer, require_system_program, require_writable,
    },
};
use crate::utils::{read_u8, read_u16, read_u32, read_u64, read_i64, read_bytes32, read_len_prefixed, Pk};

const MAX_ASSET_NAME_LEN: usize = 32;

/// Initialize a new asset: creates Metaplex Core collection + Asset state account.
///
/// Instruction data layout:
/// [0..8]    total_shares: u64
/// [8..16]   price_per_share: u64
/// [16..48]  accepted_mint: Pubkey
/// [48..56]  maturity_date: i64
/// [56..64]  maturity_grace_period: i64
/// [64..72]  transfer_cooldown: i64
/// [72..76]  max_holders: u32
/// [76]      transfer_policy: u8
/// [77]      oracle_source: u8 (0=None, 1=Pyth, 2=Switchboard)
/// [78..82]  oracle_max_staleness: u32
/// [82..84]  oracle_max_confidence_bps: u16
/// [84]      accepted_mint_decimals: u8
/// [85..93]  shares_per_unit: u64
/// [93..125] oracle_feed: [u8; 32]
/// [125]     name_len: u8
/// [126..126+name_len] name bytes
/// then:     uri_len: u8
/// then:     uri bytes
///
/// Accounts:
///   0. config (ro)
///   1. org (wr)
///   2. asset (wr)
///   3. collection (signer, wr)
///   4. collection_authority (ro)
///   5. authority (signer)
///   6. payer (signer, wr)
///   7. system_program
///   8. mpl_core_program
///   9. oracle_feed (ro, optional) — required when oracle_source != 0
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 9 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let config = &accounts[0];
    let org_account = &accounts[1];
    let asset_account = &accounts[2];
    let collection = &accounts[3];
    let collection_authority = &accounts[4];
    let authority = &accounts[5];
    let payer = &accounts[6];
    let system_program = &accounts[7];
    let mpl_core_program = &accounts[8];
    let oracle_feed_account = accounts.get(9);

    // Validate protocol
    require_owner(config, program_id, "config")?;
    let config_ref = config.try_borrow()?;
    validate_account_key(&config_ref, AccountKey::ProtocolConfig)?;
    let config_data = unsafe { ProtocolConfig::load(&config_ref) };
    require_pda_with_bump(config, &[PROTOCOL_CONFIG_SEED, &[config_data.bump]], program_id, "config")?;
    config_data.require_not_paused()?;
    drop(config_ref);

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

    // Verify authority matches org authority
    require_signer(authority, "authority")?;
    if authority.address().as_array() != &org.authority {
        pinocchio_log::log!("org.authority: expected {}, got {}", Pk(&org.authority), Pk(authority.address().as_array()));
        return Err(TokenizerError::InvalidAuthority.into());
    }

    // Verify org PDA
    let org_id = org.id;
    require_pda_with_bump(
        org_account,
        &[ORGANIZATION_SEED, &org_id.to_le_bytes(), &[org.bump]],
        program_id,
        "org_account",
    )?;

    let asset_id = org.asset_count;
    drop(org_ref);

    // Validate other accounts
    require_signer(payer, "payer")?;
    require_signer(collection, "collection")?;
    require_writable(collection, "collection")?;
    require_writable(asset_account, "asset_account")?;
    require_system_program(system_program)?;
    require_mpl_core_program(mpl_core_program)?;

    // Validate collection authority PDA
    let ca_bump = require_pda(
        collection_authority,
        &[COLLECTION_AUTHORITY_SEED, collection.address().as_ref()],
        program_id,
        "collection_authority",
    )?;

    // Validate asset PDA
    let asset_bump = require_pda(
        asset_account,
        &[ASSET_SEED, org_account.address().as_ref(), &asset_id.to_le_bytes()],
        program_id,
        "asset_account",
    )?;

    // Parse instruction data: total_shares(8) + price_per_share(8) + accepted_mint(32) +
    //   maturity_date(8) + maturity_grace_period(8) + transfer_cooldown(8) + max_holders(4) + transfer_policy(1) + name_len(1)
    let total_shares = read_u64(data, 0, "total_shares")?;
    if total_shares == 0 {
        return Err(TokenizerError::InvalidShareCount.into());
    }

    let price_per_share = read_u64(data, 8, "price_per_share")?;
    let accepted_mint = read_bytes32(data, 16, "accepted_mint")?;
    let maturity_date = read_i64(data, 48, "maturity_date")?;
    let maturity_grace_period = read_i64(data, 56, "maturity_grace_period")?;
    let transfer_cooldown = read_i64(data, 64, "transfer_cooldown")?;
    let max_holders = read_u32(data, 72, "max_holders")?;
    let transfer_policy = read_u8(data, 76, "transfer_policy")?;

    // Oracle config (oracle_source = 0 means manual pricing, no oracle)
    let oracle_source = read_u8(data, 77, "oracle_source")?;
    let oracle_max_staleness = read_u32(data, 78, "oracle_max_staleness")?;
    let oracle_max_confidence_bps = read_u16(data, 82, "oracle_max_confidence_bps")?;
    let accepted_mint_decimals = read_u8(data, 84, "accepted_mint_decimals")?;
    let shares_per_unit = read_u64(data, 85, "shares_per_unit")?;
    let oracle_feed = read_bytes32(data, 93, "oracle_feed")?;

    let source = OracleSource::try_from(oracle_source)?;
    let zero_key = [0u8; 32];

    if source != OracleSource::None {
        if oracle_feed == zero_key {
            return Err(TokenizerError::OracleNotConfigured.into());
        }
        if shares_per_unit == 0 {
            return Err(TokenizerError::InvalidShareCount.into());
        }

        // Oracle feed account is required when oracle is configured
        let feed_acc = oracle_feed_account
            .ok_or(ProgramError::NotEnoughAccountKeys)?;

        // Verify passed account matches instruction data
        if feed_acc.address().as_array() != &oracle_feed {
            return Err(TokenizerError::OracleFeedMismatch.into());
        }

        // Validate oracle feed is owned by the correct program
        let feed_owner = unsafe { feed_acc.owner() };
        match source {
            OracleSource::Pyth => {
                if feed_owner.as_array() != &PYTH_PROGRAM_ID {
                    return Err(TokenizerError::InvalidOracleProgram.into());
                }
                let feed_data = feed_acc.try_borrow()?;
                let _ = unsafe { p_pyth::PythPriceAccount::load(&feed_data) }
                    .map_err(|_| -> ProgramError { TokenizerError::OraclePriceInvalid.into() })?;
            }
            OracleSource::Switchboard => {
                if feed_owner.as_array() != &SWITCHBOARD_PROGRAM_ID {
                    return Err(TokenizerError::InvalidOracleProgram.into());
                }
                let feed_data = feed_acc.try_borrow()?;
                p_switchboard::validate_discriminator(&feed_data)
                    .map_err(|_| -> ProgramError { TokenizerError::OraclePriceInvalid.into() })?;
            }
            OracleSource::None => unreachable!(),
        }
    }

    // Verify mint is accepted by organization
    let org_ref2 = org_account.try_borrow()?;
    let org2 = unsafe { Organization::load(&org_ref2) };
    if !org2.is_mint_accepted(&accepted_mint) {
        return Err(TokenizerError::OrgMintNotAccepted.into());
    }
    drop(org_ref2);

    // Parse name
    let (name_bytes, offset) = read_len_prefixed(data, 125, "name")?;
    if name_bytes.is_empty() || name_bytes.len() > MAX_ASSET_NAME_LEN {
        return Err(TokenizerError::InvalidNameLength.into());
    }

    // Parse URI
    let (uri_bytes, _offset) = read_len_prefixed(data, offset, "uri")?;
    if uri_bytes.is_empty() || uri_bytes.len() > MAX_URI_LEN {
        return Err(TokenizerError::InvalidMetadataUri.into());
    }

    // 1. Create Metaplex Core collection
    //    update_authority = collection_authority PDA
    let create_collection = CreateCollectionV1 {
        collection,
        update_authority: collection_authority,
        payer,
        system_program,
        name: name_bytes,
        uri: uri_bytes,
    };
    create_collection.invoke()?;

    // 2. Create Asset state account
    let asset_id_bytes = asset_id.to_le_bytes();
    let asset_bump_bytes = [asset_bump];
    let asset_seeds = [
        Seed::from(ASSET_SEED),
        Seed::from(org_account.address().as_ref()),
        Seed::from(asset_id_bytes.as_ref()),
        Seed::from(&asset_bump_bytes),
    ];
    let asset_signer = Signer::from(&asset_seeds);

    CreateAccount {
        from: payer,
        to: asset_account,
        lamports: pinocchio::sysvars::rent::Rent::get()
            .map(|r| r.try_minimum_balance(Asset::LEN).unwrap_or(0))
            .unwrap_or(0),
        space: Asset::LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[asset_signer])?;

    // 3. Initialize Asset state
    let clock = Clock::get()?;
    let mut asset_data_ref = asset_account.try_borrow_mut()?;
    let asset = unsafe { Asset::load_mut(&mut asset_data_ref) };

    asset.account_key = AccountKey::Asset as u8;
    asset.version = 1;
    asset.id = asset_id;
    asset.organization = org_account.address().to_bytes();
    asset.collection = collection.address().to_bytes();
    asset.total_shares = total_shares;
    asset.minted_shares = 0;
    asset.status = AssetStatus::Draft as u8;
    asset.transfer_policy = transfer_policy;
    asset.price_per_share = price_per_share;
    asset.accepted_mint = accepted_mint;
    asset.dividend_epoch = 0;
    asset.fundraising_round_count = 0;
    asset.created_at = clock.unix_timestamp;
    asset.updated_at = clock.unix_timestamp;
    asset.bump = asset_bump;
    asset.collection_authority_bump = ca_bump;
    asset.native_treasury = [0u8; 32];
    asset.active_buyout = [0u8; 32];
    asset.unminted_succeeded_rounds = 0;
    asset.open_distributions = 0;
    asset.compliance_program = [0u8; 32];
    asset.transfer_cooldown = transfer_cooldown;
    asset.max_holders = max_holders;
    asset.current_holders = 0;
    asset.maturity_date = maturity_date;
    asset.maturity_grace_period = maturity_grace_period;
    // Oracle config (set via instruction data, or use configure_oracle ix 24 later)
    asset.oracle_source = oracle_source;
    asset._oracle_pad = [0u8; 7];
    asset.oracle_feed = oracle_feed;
    asset.shares_per_unit = shares_per_unit;
    asset.last_oracle_update = 0;
    asset.oracle_max_staleness = oracle_max_staleness;
    asset.oracle_max_confidence_bps = oracle_max_confidence_bps;
    asset.accepted_mint_decimals = accepted_mint_decimals;
    asset._oracle_reserved = 0;

    drop(asset_data_ref);

    // 4. Increment org asset_count
    let mut org_mut = org_account.try_borrow_mut()?;
    let org = unsafe { Organization::load_mut(&mut org_mut) };
    org.asset_count = asset_id
        .checked_add(1)
        .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;
    org.updated_at = clock.unix_timestamp;

    Ok(())
}
