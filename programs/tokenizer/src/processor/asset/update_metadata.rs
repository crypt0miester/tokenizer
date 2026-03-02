use pinocchio::{
    cpi::{Seed, Signer},
    error::ProgramError,
    AccountView,
    Address,
    ProgramResult,
};

use p_core::instructions::UpdateCollectionV1;
use p_core::state::MAX_URI_LEN;

use crate::{
    error::TokenizerError,
    state::{
        asset::Asset,
        organization::Organization,
        protocol_config::ProtocolConfig,
        validate_account_key, AccountKey,
        ASSET_SEED, COLLECTION_AUTHORITY_SEED, ORGANIZATION_SEED, PROTOCOL_CONFIG_SEED,
    },
    validation::{
        require_mpl_core_program, require_owner, require_pda_with_bump, require_signer,
        require_system_program, require_writable,
    },
};
/// Update collection metadata (name and/or URI) via Metaplex Core.
///
/// Instruction data layout:
/// [0..4]   org_id: u32
/// [4..8]   asset_id: u32
/// [8]      new_name_len: u8 (0 = no change)
/// [9..9+name_len] new_name bytes
/// then:    new_uri_len: u8 (0 = no change)
/// then:    new_uri bytes
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

    // Validate protocol
    require_owner(config, program_id, "config")?;
    let config_ref = config.try_borrow()?;
    validate_account_key(&config_ref, AccountKey::ProtocolConfig)?;
    let config_data = unsafe { ProtocolConfig::load(&config_ref) };
    require_pda_with_bump(config, &[PROTOCOL_CONFIG_SEED, &[config_data.bump]], program_id, "config")?;
    config_data.require_not_paused()?;
    drop(config_ref);

    // Parse instruction data: org_id(4) + asset_id(4) + new_name_len(1)
    if data.len() < 9 {
        return Err(TokenizerError::InstructionDataTooShort.into());
    }

    let org_id = u32::from_le_bytes(data[0..4].try_into().unwrap());
    let asset_id = u32::from_le_bytes(data[4..8].try_into().unwrap());

    let new_name_len = data[8] as usize;
    let mut offset = 9;
    if data.len() < offset + new_name_len + 1 {
        return Err(TokenizerError::InstructionDataTooShort.into());
    }
    let new_name = &data[offset..offset + new_name_len];
    offset += new_name_len;

    let new_uri_len = data[offset] as usize;
    offset += 1;
    if new_uri_len > MAX_URI_LEN || data.len() < offset + new_uri_len {
        return Err(TokenizerError::InvalidMetadataUri.into());
    }
    let new_uri = &data[offset..offset + new_uri_len];

    // Must update at least one field
    if new_name_len == 0 && new_uri_len == 0 {
        return Err(TokenizerError::NoFieldsToUpdate.into());
    }

    // Validate organization
    require_owner(org_account, program_id, "org_account")?;
    let org_ref = org_account.try_borrow()?;
    validate_account_key(&org_ref, AccountKey::Organization)?;
    let org = unsafe { Organization::load(&org_ref) };
    require_pda_with_bump(
        org_account,
        &[ORGANIZATION_SEED, &org_id.to_le_bytes(), &[org.bump]],
        program_id,
        "org_account",
    )?;
    if !org.is_active() {
        return Err(TokenizerError::OrganizationNotActive.into());
    }

    require_signer(authority, "authority")?;
    if authority.address().as_array() != &org.authority {
        return Err(TokenizerError::InvalidAuthority.into());
    }
    drop(org_ref);

    // Validate asset
    require_owner(asset_account, program_id, "asset_account")?;
    let asset_ref = asset_account.try_borrow()?;
    validate_account_key(&asset_ref, AccountKey::Asset)?;
    let asset = unsafe { Asset::load(&asset_ref) };
    require_pda_with_bump(
        asset_account,
        &[ASSET_SEED, org_account.address().as_ref(), &asset_id.to_le_bytes(), &[asset.bump]],
        program_id,
        "asset_account",
    )?;

    if &asset.collection != collection.address().as_array() {
        return Err(TokenizerError::CollectionMismatch.into());
    }

    let ca_bump = asset.collection_authority_bump;
    drop(asset_ref);

    // Validate collection authority PDA
    require_writable(collection, "collection")?;
    require_pda_with_bump(
        collection_authority,
        &[COLLECTION_AUTHORITY_SEED, collection.address().as_ref(), &[ca_bump]],
        program_id,
        "collection_authority",
    )?;

    require_signer(payer, "payer")?;
    require_system_program(system_program)?;
    require_mpl_core_program(mpl_core_program)?;

    // Update Metaplex Core collection metadata
    let ca_bump_bytes = [ca_bump];
    let ca_seeds = [
        Seed::from(COLLECTION_AUTHORITY_SEED),
        Seed::from(collection.address().as_ref()),
        Seed::from(&ca_bump_bytes),
    ];
    let ca_signer = Signer::from(&ca_seeds);

    UpdateCollectionV1 {
        collection,
        payer,
        authority: collection_authority,
        system_program,
        log_wrapper: mpl_core_program,
        new_name,
        new_uri,
    }
    .invoke_signed(&[ca_signer])?;

    Ok(())
}
