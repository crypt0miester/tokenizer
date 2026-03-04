use pinocchio::{
    cpi::{Seed, Signer},
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    AccountView,
    Address,
    ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;

use p_core::instructions::{BurnV1, PluginUpdateData, UpdatePluginV1};
use p_core::state::CollectionV1;

use crate::{
    error::TokenizerError,
    utils::{read_u64, mint_nft_with_plugins, u32_str_len, u32_to_bytes, u64_str_len, u64_to_bytes, Pk},
    state::{
        asset::Asset,
        asset_token::AssetToken,
        emergency_record::EmergencyRecord,
        organization::Organization,
        validate_account_key, AccountKey,
        ASSET_SEED, ASSET_TOKEN_SEED, COLLECTION_AUTHORITY_SEED,
        EMERGENCY_RECORD_SEED, ORGANIZATION_SEED,
    },
    validation::{
        require_mpl_core_program, require_owner, require_pda, require_pda_with_bump,
        require_signer, require_system_program, require_writable,
    },
};

/// Emergency 1-to-many token redistribution.
/// Burns old NFT from lost wallet, mints 2-10 new ones to specified recipients.
/// Authorized by org_authority only (expected to be a multisig).
///
/// Fixed accounts (11):
///   0.  org_account
///   1.  asset
///   2.  old_asset_token(w)
///   3.  old_nft(w)
///   4.  collection(w)
///   5.  collection_authority
///   6.  emergency_record(w)     — PDA to create
///   7.  org_authority(s)
///   8.  payer(s,w)
///   9.  system_program
///   10. mpl_core_program
///
/// Per recipient (3 accounts each, starting at index 11):
///   11 + i*3 + 0. new_nft(s,w)
///   11 + i*3 + 1. new_asset_token(w)   — PDA to create
///   11 + i*3 + 2. recipient            — wallet
///
/// Data:
///   [0]     recipient_count: u8 (2-10)
///   [1..9]  shares[0]: u64
///   [9..17] shares[1]: u64
///   ...     (recipient_count × 8 bytes)
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 11 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let org_account = &accounts[0];
    let asset_account = &accounts[1];
    let old_asset_token_account = &accounts[2];
    let old_nft = &accounts[3];
    let collection = &accounts[4];
    let collection_authority = &accounts[5];
    let emergency_record_account = &accounts[6];
    let org_authority = &accounts[7];
    let payer = &accounts[8];
    let system_program = &accounts[9];
    let mpl_core_program = &accounts[10];

    // Parse recipient_count + shares array
    if data.is_empty() {
        return Err(TokenizerError::InstructionDataTooShort.into());
    }
    let recipient_count = data[0] as usize;
    if recipient_count < 2 || recipient_count > 10 {
        return Err(TokenizerError::InvalidRecipientCount.into());
    }

    let expected_data_len = 1 + recipient_count * 8;
    if data.len() < expected_data_len {
        return Err(TokenizerError::InstructionDataTooShort.into());
    }

    // Parse shares array
    let mut shares = [0u64; 10];
    for i in 0..recipient_count {
        let offset = 1 + i * 8;
        shares[i] = read_u64(data, offset, "shares")?;
        if shares[i] == 0 {
            return Err(TokenizerError::InvalidShareCount.into());
        }
    }

    // Validate we have enough accounts: 11 fixed + 3 per recipient
    let expected_accounts = 11 + recipient_count * 3;
    if accounts.len() < expected_accounts {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    // 1. Validate org active, org_authority matches and signs
    require_owner(org_account, program_id, "org_account")?;
    let org_ref = org_account.try_borrow()?;
    validate_account_key(&org_ref, AccountKey::Organization)?;
    let org = unsafe { Organization::load(&org_ref) };
    if !org.is_active() {
        pinocchio_log::log!("org: not active");
        return Err(TokenizerError::OrganizationNotActive.into());
    }
    if &org.authority != org_authority.address().as_array() {
        pinocchio_log::log!("org.authority: expected {}, got {}", Pk(&org.authority), Pk(org_authority.address().as_array()));
        return Err(TokenizerError::InvalidAuthority.into());
    }
    let org_id = org.id;
    let org_bump = org.bump;
    drop(org_ref);

    require_signer(org_authority, "org_authority")?;

    require_pda_with_bump(
        org_account,
        &[ORGANIZATION_SEED, &org_id.to_le_bytes(), &[org_bump]],
        program_id,
        "org_account",
    )?;

    // 2. Validate asset
    require_owner(asset_account, program_id, "asset_account")?;
    let asset_ref = asset_account.try_borrow()?;
    validate_account_key(&asset_ref, AccountKey::Asset)?;
    let asset = unsafe { Asset::load(&asset_ref) };

    if &asset.organization != org_account.address().as_array() {
        pinocchio_log::log!("asset.organization: expected {}, got {}", Pk(&asset.organization), Pk(org_account.address().as_array()));
        return Err(TokenizerError::TokenAssetMismatch.into());
    }

    let asset_id = asset.id;
    let asset_bump = asset.bump;
    let ca_bump = asset.collection_authority_bump;

    if &asset.collection != collection.address().as_array() {
        pinocchio_log::log!("asset.collection: expected {}, got {}", Pk(&asset.collection), Pk(collection.address().as_array()));
        return Err(TokenizerError::CollectionMismatch.into());
    }
    drop(asset_ref);

    require_pda_with_bump(
        asset_account,
        &[ASSET_SEED, org_account.address().as_ref(), &asset_id.to_le_bytes(), &[asset_bump]],
        program_id,
        "asset_account",
    )?;

    // 3. Validate old_asset_token
    require_owner(old_asset_token_account, program_id, "old_asset_token_account")?;
    require_writable(old_asset_token_account, "old_asset_token_account")?;
    let old_at_ref = old_asset_token_account.try_borrow()?;
    validate_account_key(&old_at_ref, AccountKey::AssetToken)?;
    let old_at = unsafe { AssetToken::load(&old_at_ref) };

    if &old_at.asset != asset_account.address().as_array() {
        pinocchio_log::log!("old_at.asset: expected {}, got {}", Pk(&old_at.asset), Pk(asset_account.address().as_array()));
        return Err(TokenizerError::TokenAssetMismatch.into());
    }
    if old_at.shares == 0 {
        pinocchio_log::log!("old_at.shares: 0");
        return Err(TokenizerError::TokenAlreadyRecovered.into());
    }
    if old_at.is_listed() {
        pinocchio_log::log!("old_at: listed");
        return Err(TokenizerError::TokenIsListed.into());
    }
    if old_at.has_active_votes() {
        pinocchio_log::log!("old_at: has active votes");
        return Err(TokenizerError::GovernanceTokenLocked.into());
    }
    if &old_at.nft != old_nft.address().as_array() {
        pinocchio_log::log!("old_at.nft: expected {}, got {}", Pk(&old_at.nft), Pk(old_nft.address().as_array()));
        return Err(TokenizerError::NftMismatch.into());
    }

    let old_shares = old_at.shares;
    let old_owner_key = old_at.owner;
    let old_token_index = old_at.token_index;
    let old_last_claimed = old_at.last_claimed_epoch;
    let old_at_bump = old_at.bump;
    drop(old_at_ref);

    // Validate shares sum == old token shares exactly
    let mut shares_sum: u64 = 0;
    for i in 0..recipient_count {
        shares_sum = shares_sum
            .checked_add(shares[i])
            .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;
    }
    if shares_sum != old_shares {
        return Err(TokenizerError::SharesSumMismatch.into());
    }

    require_pda_with_bump(
        old_asset_token_account,
        &[ASSET_TOKEN_SEED, asset_account.address().as_ref(), &old_token_index.to_le_bytes(), &[old_at_bump]],
        program_id,
        "old_asset_token_account",
    )?;

    // 4. Validate emergency_record PDA, must not exist
    require_writable(emergency_record_account, "emergency_record_account")?;
    let er_bump = require_pda(
        emergency_record_account,
        &[EMERGENCY_RECORD_SEED, old_asset_token_account.address().as_ref()],
        program_id,
        "emergency_record_account",
    )?;
    if emergency_record_account.data_len() != 0 {
        return Err(TokenizerError::EmergencyRecordAlreadyExists.into());
    }

    // Validate common writable/signer accounts
    require_writable(old_nft, "old_nft")?;
    require_writable(collection, "collection")?;
    require_signer(payer, "payer")?;
    require_writable(payer, "payer")?;
    require_system_program(system_program)?;
    require_mpl_core_program(mpl_core_program)?;

    require_pda_with_bump(
        collection_authority,
        &[COLLECTION_AUTHORITY_SEED, collection.address().as_ref(), &[ca_bump]],
        program_id,
        "collection_authority",
    )?;

    // 5. Thaw + Burn old NFT
    let ca_bump_bytes = [ca_bump];
    let ca_seeds_thaw = [
        Seed::from(COLLECTION_AUTHORITY_SEED),
        Seed::from(collection.address().as_ref()),
        Seed::from(&ca_bump_bytes),
    ];
    let ca_signer_thaw = Signer::from(&ca_seeds_thaw);

    UpdatePluginV1 {
        asset: old_nft,
        collection,
        payer,
        authority: collection_authority,
        system_program,
        log_wrapper: mpl_core_program,
        update: PluginUpdateData::PermanentFreezeDelegateState { frozen: false },
    }
    .invoke_signed(&[ca_signer_thaw])?;

    let ca_seeds_burn = [
        Seed::from(COLLECTION_AUTHORITY_SEED),
        Seed::from(collection.address().as_ref()),
        Seed::from(&ca_bump_bytes),
    ];
    let ca_signer_burn = Signer::from(&ca_seeds_burn);

    BurnV1 {
        asset: old_nft,
        collection,
        payer,
        authority: collection_authority,
        system_program,
        log_wrapper: mpl_core_program,
    }
    .invoke_signed(&[ca_signer_burn])?;

    // 6. Read collection.num_minted → starting_index
    let collection_ref = collection.try_borrow()?;
    let coll = CollectionV1::from_borsh(&collection_ref);
    let starting_index = coll.num_minted;

    let coll_name = coll.get_name();
    let coll_uri = coll.get_uri();

    let mut name_base_buf = [0u8; 64];
    let name_base_len = coll_name.len();
    name_base_buf[..name_base_len].copy_from_slice(coll_name);
    name_base_buf[name_base_len] = b' ';
    name_base_buf[name_base_len + 1] = b'#';

    let mut uri_buf = [0u8; 200];
    let uri_len = coll_uri.len();
    uri_buf[..uri_len].copy_from_slice(coll_uri);
    drop(collection_ref);

    let asset_id_buf = u32_to_bytes(asset_id);
    let asset_id_str = &asset_id_buf[..u32_str_len(asset_id)];

    let clock = Clock::get()?;

    // 7. For each recipient: mint NFT + create AssetToken PDA
    for i in 0..recipient_count {
        let base = 11 + i * 3;
        let new_nft = &accounts[base];
        let new_asset_token_account = &accounts[base + 1];
        let recipient = &accounts[base + 2];

        require_signer(new_nft, "new_nft")?;
        require_writable(new_nft, "new_nft")?;
        require_writable(new_asset_token_account, "new_asset_token_account")?;

        let token_index = starting_index.checked_add(i as u32)
            .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;
        let display_index = token_index.saturating_add(1);

        // Build NFT name: "Name #N"
        let idx_buf = u32_to_bytes(display_index);
        let idx_len = u32_str_len(display_index);
        let name_len = name_base_len + 2 + idx_len;
        let mut name_buf = [0u8; 64];
        name_buf[..name_base_len + 2].copy_from_slice(&name_base_buf[..name_base_len + 2]);
        name_buf[name_base_len + 2..name_len].copy_from_slice(&idx_buf[..idx_len]);

        // Shares string for attributes
        let shares_buf = u64_to_bytes(shares[i]);
        let shares_str = &shares_buf[..u64_str_len(shares[i])];

        // Mint NFT
        mint_nft_with_plugins(
            new_nft,
            collection,
            collection_authority,
            payer,
            recipient,
            system_program,
            mpl_core_program,
            &name_buf[..name_len],
            &uri_buf[..uri_len],
            shares_str,
            asset_id_str,
            &ca_bump_bytes,
        )?;

        // Create AssetToken PDA
        let at_bump = require_pda(
            new_asset_token_account,
            &[ASSET_TOKEN_SEED, asset_account.address().as_ref(), &token_index.to_le_bytes()],
            program_id,
            "new_asset_token_account",
        )?;

        let at_bump_bytes = [at_bump];
        let at_index_bytes = token_index.to_le_bytes();
        let at_seeds = [
            Seed::from(ASSET_TOKEN_SEED),
            Seed::from(asset_account.address().as_ref()),
            Seed::from(at_index_bytes.as_ref()),
            Seed::from(&at_bump_bytes),
        ];
        let at_signer = Signer::from(&at_seeds);

        CreateAccount {
            from: payer,
            to: new_asset_token_account,
            lamports: pinocchio::sysvars::rent::Rent::get()
                .map(|r| r.try_minimum_balance(AssetToken::LEN).unwrap_or(0))
                .unwrap_or(0),
            space: AssetToken::LEN as u64,
            owner: program_id,
        }
        .invoke_signed(&[at_signer])?;

        let mut at_data = new_asset_token_account.try_borrow_mut()?;
        let at = unsafe { AssetToken::load_mut(&mut at_data) };
        at.account_key = AccountKey::AssetToken as u8;
        at.version = 1;
        at.asset = asset_account.address().to_bytes();
        at.nft = new_nft.address().to_bytes();
        at.owner = recipient.address().to_bytes();
        at.shares = shares[i];
        at.is_listed = 0;
        at.active_votes = 0;
        at.parent_token = old_asset_token_account.address().to_bytes();
        at.last_claimed_epoch = old_last_claimed;
        at.token_index = token_index;
        at.created_at = clock.unix_timestamp;
        at.bump = at_bump;
        at.lockup_end = 0;
        at.last_transfer_at = clock.unix_timestamp;
        at.cost_basis_per_share = 0;
        drop(at_data);
    }

    // 8. Create + init EmergencyRecord
    let er_bump_bytes = [er_bump];
    let er_seeds = [
        Seed::from(EMERGENCY_RECORD_SEED),
        Seed::from(old_asset_token_account.address().as_ref()),
        Seed::from(&er_bump_bytes),
    ];
    let er_signer = Signer::from(&er_seeds);

    CreateAccount {
        from: payer,
        to: emergency_record_account,
        lamports: pinocchio::sysvars::rent::Rent::get()
            .map(|r| r.try_minimum_balance(EmergencyRecord::LEN).unwrap_or(0))
            .unwrap_or(0),
        space: EmergencyRecord::LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[er_signer])?;

    let mut er_data = emergency_record_account.try_borrow_mut()?;
    let er = unsafe { EmergencyRecord::load_mut(&mut er_data) };
    er.account_key = AccountKey::EmergencyRecord as u8;
    er.version = 1;
    er.asset = asset_account.address().to_bytes();
    er.old_asset_token = old_asset_token_account.address().to_bytes();
    er.old_owner = old_owner_key;
    er.recovery_type = 1; // split_and_remint
    er.created_at = clock.unix_timestamp;
    er.bump = er_bump;
    drop(er_data);

    // 9. Zero out old AssetToken shares
    let mut old_at_data = old_asset_token_account.try_borrow_mut()?;
    let old_at = unsafe { AssetToken::load_mut(&mut old_at_data) };
    old_at.shares = 0;
    drop(old_at_data);

    Ok(())
}
