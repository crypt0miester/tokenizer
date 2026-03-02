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
        validate_account_key, AccountKey, AssetStatus,
        ASSET_SEED, COLLECTION_AUTHORITY_SEED, ORGANIZATION_SEED, PROTOCOL_CONFIG_SEED,
    },
    validation::{
        require_mpl_core_program, require_owner, require_pda, require_pda_with_bump,
        require_signer, require_system_program, require_writable,
    },
};
use crate::utils::Pk;

const MAX_ASSET_NAME_LEN: usize = 32;

/// Initialize a new asset: creates Metaplex Core collection + Asset state account.
///
/// Instruction data layout:
/// [0..8]   total_shares: u64
/// [8..16]  price_per_share: u64
/// [16..48] accepted_mint: Pubkey
/// [48]     name_len: u8
/// [49..49+name_len] name bytes
/// then:    uri_len: u8
/// then:    uri bytes
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    let [
        config,
        org_account,
        asset_account,
        collection,          // New keypair, signer
        collection_authority, // PDA: ["collection_authority", collection.key()]
        authority,           // Organization authority, signer
        payer,
        system_program,
        mpl_core_program,
    ] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

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
    if data.len() < 78 {
        return Err(TokenizerError::InstructionDataTooShort.into());
    }

    let total_shares = u64::from_le_bytes(data[0..8].try_into().unwrap());
    if total_shares == 0 {
        return Err(TokenizerError::InvalidShareCount.into());
    }

    let price_per_share = u64::from_le_bytes(data[8..16].try_into().unwrap());
    let accepted_mint: [u8; 32] = data[16..48].try_into().unwrap();
    let maturity_date = i64::from_le_bytes(data[48..56].try_into().unwrap());
    let maturity_grace_period = i64::from_le_bytes(data[56..64].try_into().unwrap());
    let transfer_cooldown = i64::from_le_bytes(data[64..72].try_into().unwrap());
    let max_holders = u32::from_le_bytes(data[72..76].try_into().unwrap());
    let transfer_policy = data[76];

    // Verify mint is accepted by organization
    let org_ref2 = org_account.try_borrow()?;
    let org2 = unsafe { Organization::load(&org_ref2) };
    if !org2.is_mint_accepted(&accepted_mint) {
        return Err(TokenizerError::OrgMintNotAccepted.into());
    }
    drop(org_ref2);

    // Parse name
    let name_len = data[77] as usize;
    if name_len == 0 || name_len > MAX_ASSET_NAME_LEN {
        return Err(TokenizerError::InvalidNameLength.into());
    }
    let mut offset = 78;
    if data.len() < offset + name_len + 1 {
        return Err(TokenizerError::InstructionDataTooShort.into());
    }
    let name_bytes = &data[offset..offset + name_len];
    offset += name_len;

    // Parse URI
    let uri_len = data[offset] as usize;
    offset += 1;
    if uri_len == 0 || uri_len > MAX_URI_LEN || data.len() < offset + uri_len {
        return Err(TokenizerError::InvalidMetadataUri.into());
    }
    let uri_bytes = &data[offset..offset + uri_len];

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
