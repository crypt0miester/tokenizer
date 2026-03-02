use pinocchio::{
    cpi::{Seed, Signer},
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    AccountView,
    Address,
    ProgramResult,
};

use p_core::instructions::{PluginUpdateData, TransferV1, UpdatePluginV1};

use crate::{
    error::TokenizerError,
    utils::Pk,
    state::{
        asset::Asset,
        asset_token::AssetToken,
        protocol_config::ProtocolConfig,
        validate_account_key, AccountKey, AssetStatus, TransferPolicy,
        ASSET_SEED, ASSET_TOKEN_SEED, COLLECTION_AUTHORITY_SEED, PROTOCOL_CONFIG_SEED,
    },
    validation::{
        require_mpl_core_program, require_owner, require_pda_with_bump,
        require_signer, require_system_program, require_writable,
    },
};

/// Direct P2P token transfer (no payment).
/// Asset must have transfer_policy = Transferable.
/// Thaw → Transfer → Re-freeze, same as accept_offer full buy path.
///
/// Accounts:
///   0.  config              — ProtocolConfig PDA (read)
///   1.  asset               — Asset PDA (read)
///   2.  asset_token(w)      — AssetToken PDA (writable)
///   3.  nft(w)              — Metaplex Core NFT (writable)
///   4.  collection(w)       — Metaplex Core collection (writable)
///   5.  collection_authority — Collection authority PDA (read)
///   6.  owner(s)            — Current token owner (signer)
///   7.  new_owner           — Recipient (read)
///   8.  payer(s,w)          — Transaction payer (signer, writable)
///   9.  system_program
///   10. mpl_core_program
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    _data: &[u8],
) -> ProgramResult {
    let [
        config,
        asset_account,
        asset_token_account,
        nft,
        collection,
        collection_authority,
        owner,
        new_owner,
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

    // Validate asset
    require_owner(asset_account, program_id, "asset_account")?;
    let asset_ref = asset_account.try_borrow()?;
    validate_account_key(&asset_ref, AccountKey::Asset)?;
    let asset = unsafe { Asset::load(&asset_ref) };

    if asset.status() != AssetStatus::Active {
        pinocchio_log::log!("asset.status: {}", asset.status);
        return Err(TokenizerError::AssetNotActiveForTrading.into());
    }

    // Must be transferable
    if asset.transfer_policy != TransferPolicy::Transferable as u8 {
        pinocchio_log::log!("asset.transfer_policy: {}", asset.transfer_policy);
        return Err(TokenizerError::TokenNotTransferable.into());
    }

    // Block during active buyout
    if asset.active_buyout != [0u8; 32] {
        pinocchio_log::log!("blocked: active buyout exists");
        return Err(TokenizerError::BuyoutActiveBuyoutExists.into());
    }

    let org_key = asset.organization;
    let asset_id = asset.id;
    let ca_bump = asset.collection_authority_bump;
    let asset_bump = asset.bump;
    let cooldown = asset.transfer_cooldown;
    let max_holders = asset.max_holders;
    let current_holders = asset.current_holders;

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

    // Validate asset_token
    require_owner(asset_token_account, program_id, "asset_token_account")?;
    require_writable(asset_token_account, "asset_token_account")?;
    let at_ref = asset_token_account.try_borrow()?;
    validate_account_key(&at_ref, AccountKey::AssetToken)?;
    let at = unsafe { AssetToken::load(&at_ref) };

    if &at.asset != asset_account.address().as_array() {
        pinocchio_log::log!("at.asset: expected {}, got {}", Pk(&at.asset), Pk(asset_account.address().as_array()));
        return Err(TokenizerError::TokenAssetMismatch.into());
    }

    // Verify NFT matches
    if &at.nft != nft.address().as_array() {
        pinocchio_log::log!("at.nft: expected {}, got {}", Pk(&at.nft), Pk(nft.address().as_array()));
        return Err(TokenizerError::NftMismatch.into());
    }

    // Verify owner is signer and matches asset_token owner
    require_signer(owner, "owner")?;
    if &at.owner != owner.address().as_array() {
        pinocchio_log::log!("at.owner: expected {}, got {}", Pk(&at.owner), Pk(owner.address().as_array()));
        return Err(TokenizerError::NotTokenOwner.into());
    }

    // Token must NOT be listed
    if at.is_listed() {
        pinocchio_log::log!("at: listed");
        return Err(TokenizerError::TokenIsListed.into());
    }

    // Must not have active governance votes
    if at.has_active_votes() {
        pinocchio_log::log!("at: has active votes");
        return Err(TokenizerError::GovernanceTokenLocked.into());
    }

    let at_lockup_end = at.lockup_end;
    let at_last_transfer_at = at.last_transfer_at;
    let at_bump = at.bump;
    let token_index = at.token_index;
    drop(at_ref);

    require_pda_with_bump(
        asset_token_account,
        &[ASSET_TOKEN_SEED, asset_account.address().as_ref(), &token_index.to_le_bytes(), &[at_bump]],
        program_id,
        "asset_token_account",
    )?;

    // Check lockup and cooldown
    let clock = Clock::get()?;
    if at_lockup_end != 0 && clock.unix_timestamp < at_lockup_end {
        pinocchio_log::log!("token locked until {}", at_lockup_end);
        return Err(TokenizerError::TokenLocked.into());
    }
    if cooldown != 0 && clock.unix_timestamp - at_last_transfer_at < cooldown {
        pinocchio_log::log!("transfer cooldown active");
        return Err(TokenizerError::TransferCooldownActive.into());
    }

    // Prevent self-transfer
    if owner.address().as_array() == new_owner.address().as_array() {
        pinocchio_log::log!("self-transfer not allowed");
        return Err(TokenizerError::SelfTransferNotAllowed.into());
    }

    // Max holders check (conservative: always check since we can't cheaply verify recipient)
    if max_holders != 0 && current_holders >= max_holders {
        pinocchio_log::log!("max holders reached: {} >= {}", current_holders, max_holders);
        return Err(TokenizerError::MaxHoldersReached.into());
    }

    // Validate remaining accounts
    require_signer(payer, "payer")?;
    require_writable(payer, "payer")?;
    require_writable(nft, "nft")?;
    require_writable(collection, "collection")?;
    require_system_program(system_program)?;
    require_mpl_core_program(mpl_core_program)?;

    require_pda_with_bump(
        collection_authority,
        &[COLLECTION_AUTHORITY_SEED, collection.address().as_ref(), &[ca_bump]],
        program_id,
        "collection_authority",
    )?;

    // ── Thaw → Transfer → Re-freeze ──
    let ca_bump_bytes = [ca_bump];

    // Thaw
    let ca_seeds1 = [
        Seed::from(COLLECTION_AUTHORITY_SEED),
        Seed::from(collection.address().as_ref()),
        Seed::from(&ca_bump_bytes),
    ];
    let ca_signer1 = Signer::from(&ca_seeds1);

    UpdatePluginV1 {
        asset: nft,
        collection,
        payer,
        authority: collection_authority,
        system_program,
        log_wrapper: mpl_core_program,
        update: PluginUpdateData::PermanentFreezeDelegateState { frozen: false },
    }
    .invoke_signed(&[ca_signer1])?;

    // Transfer
    let ca_seeds2 = [
        Seed::from(COLLECTION_AUTHORITY_SEED),
        Seed::from(collection.address().as_ref()),
        Seed::from(&ca_bump_bytes),
    ];
    let ca_signer2 = Signer::from(&ca_seeds2);

    TransferV1 {
        asset: nft,
        collection,
        payer,
        authority: collection_authority,
        new_owner,
        system_program,
        log_wrapper: mpl_core_program,
    }
    .invoke_signed(&[ca_signer2])?;

    // Re-freeze
    let ca_seeds3 = [
        Seed::from(COLLECTION_AUTHORITY_SEED),
        Seed::from(collection.address().as_ref()),
        Seed::from(&ca_bump_bytes),
    ];
    let ca_signer3 = Signer::from(&ca_seeds3);

    UpdatePluginV1 {
        asset: nft,
        collection,
        payer,
        authority: collection_authority,
        system_program,
        log_wrapper: mpl_core_program,
        update: PluginUpdateData::PermanentFreezeDelegateState { frozen: true },
    }
    .invoke_signed(&[ca_signer3])?;

    // Update AssetToken: owner and last_transfer_at (no cost_basis update — not a sale)
    let mut at_data = asset_token_account.try_borrow_mut()?;
    let at = unsafe { AssetToken::load_mut(&mut at_data) };
    at.owner = new_owner.address().to_bytes();
    at.last_transfer_at = clock.unix_timestamp;
    drop(at_data);

    Ok(())
}
