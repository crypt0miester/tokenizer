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
    utils::{mint_nft_with_plugins, u32_str_len, u32_to_bytes, u64_str_len, u64_to_bytes, Pk},
    state::{
        asset::Asset,
        asset_token::AssetToken,
        protocol_config::ProtocolConfig,
        validate_account_key, AccountKey, AssetStatus,
        ASSET_SEED, ASSET_TOKEN_SEED, COLLECTION_AUTHORITY_SEED,
        PROTOCOL_CONFIG_SEED,
    },
    validation::{
        close_account, require_mpl_core_program, require_owner, require_pda,
        require_pda_with_bump, require_signer, require_system_program, require_writable,
    },
};

/// Consolidate 2–10 tokens of the same asset owned by the same wallet into one.
///
/// Instruction data layout:
/// [0] count: u8 — number of tokens to consolidate
///
/// Accounts:
///   0.  config
///   1.  asset
///   2.  collection(w)
///   3.  collection_authority
///   4.  new_nft(s)
///   5.  new_asset_token(w)
///   6.  owner(s)
///   7.  payer(s,w)
///   8.  system_program
///   9.  mpl_core_program
///   10+ pairs of (asset_token(w), nft(w)) for each token to burn
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 10 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let config = &accounts[0];
    let asset_account = &accounts[1];
    let collection = &accounts[2];
    let collection_authority = &accounts[3];
    let new_nft = &accounts[4];
    let new_asset_token_account = &accounts[5];
    let owner = &accounts[6];
    let payer = &accounts[7];
    let system_program = &accounts[8];
    let mpl_core_program = &accounts[9];

    // Parse instruction data
    if data.is_empty() {
        return Err(TokenizerError::InstructionDataTooShort.into());
    }
    let count = data[0] as usize;
    if count < 2 {
        return Err(TokenizerError::ConsolidateMinTokens.into());
    }
    if count > 10 {
        return Err(TokenizerError::ConsolidateMaxTokens.into());
    }

    // Must have 10 + 2*count accounts
    let expected_accounts = 10 + 2 * count;
    if accounts.len() < expected_accounts {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    // Validate protocol
    require_owner(config, program_id, "config")?;
    let config_ref = config.try_borrow()?;
    validate_account_key(&config_ref, AccountKey::ProtocolConfig)?;
    let config_data = unsafe { ProtocolConfig::load(&config_ref) };
    require_pda_with_bump(config, &[PROTOCOL_CONFIG_SEED, &[config_data.bump]], program_id, "config")?;
    config_data.require_not_paused()?;
    drop(config_ref);

    // Validate asset
    require_owner(asset_account, program_id, "asset_account")?;
    let asset_ref = asset_account.try_borrow()?;
    validate_account_key(&asset_ref, AccountKey::Asset)?;
    let asset = unsafe { Asset::load(&asset_ref) };

    if asset.status() != AssetStatus::Active {
        pinocchio_log::log!("asset.status: {}", asset.status);
        return Err(TokenizerError::AssetNotActiveForTrading.into());
    }

    let org_key = asset.organization;
    let asset_id = asset.id;
    let ca_bump = asset.collection_authority_bump;
    let asset_bump = asset.bump;

    if &asset.collection != collection.address().as_array() {
        pinocchio_log::log!("asset.collection: expected {}, got {}", Pk(&asset.collection), Pk(collection.address().as_array()));
        return Err(TokenizerError::CollectionMismatch.into());
    }
    drop(asset_ref);

    require_pda_with_bump(
        asset_account,
        &[ASSET_SEED, &org_key, &asset_id.to_le_bytes(), &[asset_bump]],
        program_id,
        "asset_account",
    )?;

    // Validate common accounts
    require_signer(owner, "owner")?;
    require_signer(payer, "payer")?;
    require_signer(new_nft, "new_nft")?;
    require_writable(new_nft, "new_nft")?;
    require_writable(collection, "collection")?;
    require_writable(new_asset_token_account, "new_asset_token_account")?;
    require_system_program(system_program)?;
    require_mpl_core_program(mpl_core_program)?;

    require_pda_with_bump(
        collection_authority,
        &[COLLECTION_AUTHORITY_SEED, collection.address().as_ref(), &[ca_bump]],
        program_id,
        "collection_authority",
    )?;

    // Check for duplicate asset token accounts
    for i in 0..count {
        for j in (i + 1)..count {
            if accounts[10 + 2 * i].address() == accounts[10 + 2 * j].address() {
                return Err(TokenizerError::DuplicateAssetToken.into());
            }
        }
    }

    // Validate all token pairs and sum shares
    let mut total_shares: u64 = 0;
    let mut max_last_claimed: u32 = 0;
    let mut max_lockup_end: i64 = 0;
    let mut total_cost: u128 = 0;
    let ca_bump_bytes = [ca_bump];

    for i in 0..count {
        let at_account = &accounts[10 + 2 * i];
        let nft_account = &accounts[10 + 2 * i + 1];

        require_owner(at_account, program_id, "at_account")?;
        require_writable(at_account, "at_account")?;
        require_writable(nft_account, "nft_account")?;

        let at_ref = at_account.try_borrow()?;
        validate_account_key(&at_ref, AccountKey::AssetToken)?;
        let at = unsafe { AssetToken::load(&at_ref) };

        // Must belong to same asset
        if &at.asset != asset_account.address().as_array() {
            pinocchio_log::log!("at.asset: expected {}, got {}", Pk(&at.asset), Pk(asset_account.address().as_array()));
            return Err(TokenizerError::ConsolidateAssetMismatch.into());
        }

        // Must be owned by caller
        if &at.owner != owner.address().as_array() {
            pinocchio_log::log!("at.owner: expected {}, got {}", Pk(&at.owner), Pk(owner.address().as_array()));
            return Err(TokenizerError::ConsolidateOwnerMismatch.into());
        }

        // Must not be listed
        if at.is_listed() {
            pinocchio_log::log!("token[{}]: listed", i);
            return Err(TokenizerError::TokenIsListed.into());
        }

        // Must not have active governance votes
        if at.has_active_votes() {
            pinocchio_log::log!("token[{}]: has active votes", i);
            return Err(TokenizerError::GovernanceTokenLocked.into());
        }

        // Verify NFT matches
        if &at.nft != nft_account.address().as_array() {
            pinocchio_log::log!("at.nft: expected {}, got {}", Pk(&at.nft), Pk(nft_account.address().as_array()));
            return Err(TokenizerError::NftMismatch.into());
        }

        let shares = at.shares;
        let token_index = at.token_index;
        let claimed = at.last_claimed_epoch;
        let at_bump_val = at.bump;
        let at_lockup = at.lockup_end;
        let at_cost = at.cost_basis_per_share;
        drop(at_ref);

        // Track max last_claimed_epoch to prevent double-claims
        if claimed > max_last_claimed {
            max_last_claimed = claimed;
        }

        // Track max lockup_end and accumulated cost basis
        if at_lockup > max_lockup_end {
            max_lockup_end = at_lockup;
        }
        total_cost = total_cost
            .checked_add((shares as u128).checked_mul(at_cost as u128)
                .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?)
            .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;

        // Validate PDA
        require_pda_with_bump(
            at_account,
            &[ASSET_TOKEN_SEED, asset_account.address().as_ref(), &token_index.to_le_bytes(), &[at_bump_val]],
            program_id,
            "at_account",
        )?;

        total_shares = total_shares
            .checked_add(shares)
            .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;

        // Thaw NFT before burn (PermanentFreezeDelegate rejects burn while frozen)
        let ca_seeds_thaw = [
            Seed::from(COLLECTION_AUTHORITY_SEED),
            Seed::from(collection.address().as_ref()),
            Seed::from(&ca_bump_bytes),
        ];
        let ca_signer_thaw = Signer::from(&ca_seeds_thaw);

        UpdatePluginV1 {
            asset: nft_account,
            collection,
            payer,
            authority: collection_authority,
            system_program,
            log_wrapper: mpl_core_program,
            update: PluginUpdateData::PermanentFreezeDelegateState { frozen: false },
        }
        .invoke_signed(&[ca_signer_thaw])?;

        // Burn NFT
        let ca_seeds = [
            Seed::from(COLLECTION_AUTHORITY_SEED),
            Seed::from(collection.address().as_ref()),
            Seed::from(&ca_bump_bytes),
        ];
        let ca_signer = Signer::from(&ca_seeds);

        BurnV1 {
            asset: nft_account,
            collection,
            payer,
            authority: collection_authority,
            system_program,
            log_wrapper: mpl_core_program,
        }
        .invoke_signed(&[ca_signer])?;
    }

    // Read collection for name/URI and token_index
    let collection_ref = collection.try_borrow()?;
    let coll = CollectionV1::from_borsh(&collection_ref);
    let new_token_index = coll.num_minted;

    let coll_name = coll.get_name();
    let coll_uri = coll.get_uri();

    // Build NFT name
    let mut nft_name_buf = [0u8; 64];
    let name_base_len = coll_name.len();
    nft_name_buf[..name_base_len].copy_from_slice(coll_name);
    nft_name_buf[name_base_len] = b' ';
    nft_name_buf[name_base_len + 1] = b'#';
    let index_num = new_token_index.saturating_add(1);
    let index_str_buf = u32_to_bytes(index_num);
    let index_len = u32_str_len(index_num);
    let nft_name_len = name_base_len + 2 + index_len;
    nft_name_buf[name_base_len + 2..nft_name_len].copy_from_slice(&index_str_buf[..index_len]);

    let mut uri_buf = [0u8; 200];
    let uri_len = coll_uri.len();
    uri_buf[..uri_len].copy_from_slice(coll_uri);
    drop(collection_ref);

    // Validate new AssetToken PDA
    let new_at_bump = require_pda(
        new_asset_token_account,
        &[ASSET_TOKEN_SEED, asset_account.address().as_ref(), &new_token_index.to_le_bytes()],
        program_id,
        "new_asset_token_account",
    )?;

    // Attribute strings
    let shares_str_buf = u64_to_bytes(total_shares);
    let shares_str = &shares_str_buf[..u64_str_len(total_shares)];
    let asset_id_str_buf = u32_to_bytes(asset_id);
    let asset_id_str = &asset_id_str_buf[..u32_str_len(asset_id)];

    // Mint new consolidated NFT (5 CPIs)
    mint_nft_with_plugins(
        new_nft, collection, collection_authority, payer, owner, system_program, mpl_core_program,
        &nft_name_buf[..nft_name_len], &uri_buf[..uri_len],
        shares_str, asset_id_str, &ca_bump_bytes,
    )?;

    // Create new AssetToken PDA
    let new_at_bump_bytes = [new_at_bump];
    let new_token_index_bytes = new_token_index.to_le_bytes();
    let new_at_seeds = [
        Seed::from(ASSET_TOKEN_SEED),
        Seed::from(asset_account.address().as_ref()),
        Seed::from(new_token_index_bytes.as_ref()),
        Seed::from(&new_at_bump_bytes),
    ];
    let new_at_signer = Signer::from(&new_at_seeds);

    CreateAccount {
        from: payer,
        to: new_asset_token_account,
        lamports: pinocchio::sysvars::rent::Rent::get()
            .map(|r| r.try_minimum_balance(AssetToken::LEN).unwrap_or(0))
            .unwrap_or(0),
        space: AssetToken::LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[new_at_signer])?;

    // Initialize new AssetToken
    let clock = Clock::get()?;
    let mut new_at_data = new_asset_token_account.try_borrow_mut()?;
    let new_at = unsafe { AssetToken::load_mut(&mut new_at_data) };
    new_at.account_key = AccountKey::AssetToken as u8;
    new_at.version = 1;
    new_at.asset = asset_account.address().to_bytes();
    new_at.nft = new_nft.address().to_bytes();
    new_at.owner = owner.address().to_bytes();
    new_at.shares = total_shares;
    new_at.is_listed = 0;
    new_at.active_votes = 0;
    new_at.parent_token = [0u8; 32]; // consolidated, no single parent
    new_at.last_claimed_epoch = max_last_claimed;
    new_at.token_index = new_token_index;
    new_at.created_at = clock.unix_timestamp;
    new_at.bump = new_at_bump;
    new_at.lockup_end = max_lockup_end;
    new_at.last_transfer_at = clock.unix_timestamp;
    new_at.cost_basis_per_share = if total_shares > 0 {
        (total_cost / total_shares as u128) as u64
    } else {
        0
    };
    drop(new_at_data);

    // Close spent AssetTokens — must happen after all CPIs
    for i in 0..count {
        let at_account = &accounts[10 + 2 * i];
        close_account(at_account, payer)?;
    }

    Ok(())
}
