use pinocchio::{
    cpi::{Seed, Signer},
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    AccountView,
    Address,
    ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;

use p_core::state::CollectionV1;

use crate::{
    error::TokenizerError,
    utils::{read_u64, read_bytes32, mint_nft_with_plugins, u32_str_len, u32_to_bytes, u64_str_len, u64_to_bytes},
    state::{
        asset::Asset,
        asset_token::AssetToken,
        organization::Organization,
        protocol_config::ProtocolConfig,
        validate_account_key, AccountKey, AssetStatus,
        ASSET_SEED, ASSET_TOKEN_SEED, COLLECTION_AUTHORITY_SEED, ORGANIZATION_SEED,
        PROTOCOL_CONFIG_SEED,
    },
    validation::{
        require_mpl_core_program, require_owner, require_pda, require_pda_with_bump,
        require_signer, require_system_program, require_writable,
    },
};

/// Mint a token (NFT) representing shares to an owner.
///
/// Instruction data layout:
/// [0..8]   shares: u64
/// [8..40]  recipient: Pubkey
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    let [
        config,
        org_account,
        asset_account,
        asset_token_account,     // PDA to create
        collection,              // Metaplex Core collection
        collection_authority,    // PDA: ["collection_authority", collection.key()]
        nft,                     // New keypair, signer — the Metaplex Core asset
        recipient,               // Owner of the new token
        authority,               // Org authority only, signer
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
    let org_ref = org_account.try_borrow()?;
    validate_account_key(&org_ref, AccountKey::Organization)?;
    let org = unsafe { Organization::load(&org_ref) };
    if !org.is_active() {
        return Err(TokenizerError::OrganizationNotActive.into());
    }
    let org_id = org.id;
    require_pda_with_bump(
        org_account,
        &[ORGANIZATION_SEED, &org_id.to_le_bytes(), &[org.bump]],
        program_id,
        "org_account",
    )?;

    // Authority check: must be org authority, signer
    require_signer(authority, "authority")?;
    if authority.address().as_array() != &org.authority {
        return Err(TokenizerError::Unauthorized.into());
    }
    drop(org_ref);

    // Validate asset
    require_owner(asset_account, program_id, "asset_account")?;
    require_writable(asset_account, "asset_account")?;

    let asset_ref = asset_account.try_borrow()?;
    validate_account_key(&asset_ref, AccountKey::Asset)?;
    let asset = unsafe { Asset::load(&asset_ref) };

    let asset_id = asset.id;
    require_pda_with_bump(
        asset_account,
        &[ASSET_SEED, org_account.address().as_ref(), &asset_id.to_le_bytes(), &[asset.bump]],
        program_id,
        "asset_account",
    )?;

    // Asset must be in a mintable state
    let status = asset.status();
    if status != AssetStatus::Active && status != AssetStatus::Fundraising {
        return Err(TokenizerError::InvalidAssetStatus.into());
    }

    // Block during active buyout
    if asset.active_buyout != [0u8; 32] {
        pinocchio_log::log!("blocked: active buyout exists");
        return Err(TokenizerError::BuyoutActiveBuyoutExists.into());
    }

    // Verify collection matches
    if &asset.collection != collection.address().as_array() {
        return Err(TokenizerError::CollectionMismatch.into());
    }

    let ca_bump = asset.collection_authority_bump;
    let total_shares = asset.total_shares;
    let minted_shares = asset.minted_shares;
    let dividend_epoch = asset.dividend_epoch;
    drop(asset_ref);

    // Read collection data: token index (num_minted), name, and URI
    let collection_ref = collection.try_borrow()?;
    let coll = CollectionV1::from_borsh(&collection_ref);
    let token_index = coll.num_minted;

    // Copy name and build "Name #N"
    let coll_name = coll.get_name();
    let coll_uri = coll.get_uri();
    let mut nft_name_buf = [0u8; 64];
    let name_len = coll_name.len();
    nft_name_buf[..name_len].copy_from_slice(coll_name);
    nft_name_buf[name_len] = b' ';
    nft_name_buf[name_len + 1] = b'#';
    let index_num = token_index.saturating_add(1); // 1-indexed
    let index_str_buf = u32_to_bytes(index_num);
    let index_len = u32_str_len(index_num);
    let nft_name_len = name_len + 2 + index_len;
    nft_name_buf[name_len + 2..nft_name_len].copy_from_slice(&index_str_buf[..index_len]);

    // Copy URI
    let uri_len = coll_uri.len();
    let mut uri_buf = [0u8; 200];
    uri_buf[..uri_len].copy_from_slice(coll_uri);
    drop(collection_ref);

    // Parse instruction data: shares(8) + recipient(32)
    let shares = read_u64(data, 0, "shares")?;
    if shares == 0 {
        return Err(TokenizerError::InvalidShareCount.into());
    }

    let new_minted = minted_shares
        .checked_add(shares)
        .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;
    if new_minted > total_shares {
        return Err(TokenizerError::SharesExceedTotal.into());
    }

    let recipient_key_arr = read_bytes32(data, 8, "recipient")?;
    let recipient_key = &recipient_key_arr;
    if recipient.address().as_array() != recipient_key {
        return Err(TokenizerError::InvalidTokenOwner.into());
    }

    // Validate remaining accounts
    require_signer(payer, "payer")?;
    require_signer(nft, "nft")?;
    require_writable(nft, "nft")?;
    require_writable(collection, "collection")?;
    require_writable(asset_token_account, "asset_token_account")?;
    require_system_program(system_program)?;
    require_mpl_core_program(mpl_core_program)?;

    // Validate collection authority PDA
    require_pda_with_bump(
        collection_authority,
        &[COLLECTION_AUTHORITY_SEED, collection.address().as_ref(), &[ca_bump]],
        program_id,
        "collection_authority",
    )?;

    // Validate asset_token PDA
    let at_bump = require_pda(
        asset_token_account,
        &[ASSET_TOKEN_SEED, asset_account.address().as_ref(), &token_index.to_le_bytes()],
        program_id,
        "asset_token_account",
    )?;

    // Mint NFT with standard plugins (CreateV1 + Freeze/Transfer/Burn/Attributes)
    let ca_bump_bytes = [ca_bump];
    let shares_str_buf = u64_to_bytes(shares);
    let shares_str = &shares_str_buf[..u64_str_len(shares)];
    let asset_id_str_buf = u32_to_bytes(asset_id);
    let asset_id_str = &asset_id_str_buf[..u32_str_len(asset_id)];

    mint_nft_with_plugins(
        nft, collection, collection_authority, payer, recipient, system_program, mpl_core_program,
        &nft_name_buf[..nft_name_len], &uri_buf[..uri_len],
        shares_str, asset_id_str, &ca_bump_bytes,
    )?;

    // 6. Create AssetToken state account
    let token_index_bytes = token_index.to_le_bytes();
    let at_bump_bytes = [at_bump];
    let at_seeds = [
        Seed::from(ASSET_TOKEN_SEED),
        Seed::from(asset_account.address().as_ref()),
        Seed::from(token_index_bytes.as_ref()),
        Seed::from(&at_bump_bytes),
    ];
    let at_signer = Signer::from(&at_seeds);

    CreateAccount {
        from: payer,
        to: asset_token_account,
        lamports: pinocchio::sysvars::rent::Rent::get()
            .map(|r| r.try_minimum_balance(AssetToken::LEN).unwrap_or(0))
            .unwrap_or(0),
        space: AssetToken::LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[at_signer])?;

    // 7. Initialize AssetToken state
    let clock = Clock::get()?;
    let mut at_data = asset_token_account.try_borrow_mut()?;
    let token = unsafe { AssetToken::load_mut(&mut at_data) };

    token.account_key = AccountKey::AssetToken as u8;
    token.version = 1;
    token.asset = asset_account.address().to_bytes();
    token.nft = nft.address().to_bytes();
    token.owner = recipient.address().to_bytes();
    token.shares = shares;
    token.is_listed = 0;
    token.active_votes = 0;
    token.parent_token = [0u8; 32];
    token.last_claimed_epoch = dividend_epoch;
    token.token_index = token_index;
    token.created_at = clock.unix_timestamp;
    token.bump = at_bump;

    drop(at_data);

    // 8. Update Asset minted_shares
    let mut asset_mut = asset_account.try_borrow_mut()?;
    let asset = unsafe { Asset::load_mut(&mut asset_mut) };
    asset.minted_shares = new_minted;
    asset.updated_at = clock.unix_timestamp;

    Ok(())
}
