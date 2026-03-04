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
    utils::{read_u8, read_u64, read_bytes32, mint_nft_with_plugins, u32_str_len, u32_to_bytes, u64_str_len, u64_to_bytes, Pk},
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

/// Emergency 1-to-1 token recovery.
/// Burns old NFT from lost wallet, mints new one to new owner.
/// Authorized by org_authority only (expected to be a multisig).
///
/// Accounts (14):
///   0.  org_account
///   1.  asset
///   2.  old_asset_token(w)
///   3.  old_nft(w)
///   4.  collection(w)
///   5.  collection_authority
///   6.  new_nft(s,w)
///   7.  new_asset_token(w)       — PDA to create
///   8.  new_owner                — recipient wallet
///   9.  emergency_record(w)      — PDA to create
///   10. org_authority(s)
///   11. payer(s,w)
///   12. system_program
///   13. mpl_core_program
///
/// Data: [0..32] new_owner_pubkey
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 14 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let org_account = &accounts[0];
    let asset_account = &accounts[1];
    let old_asset_token_account = &accounts[2];
    let old_nft = &accounts[3];
    let collection = &accounts[4];
    let collection_authority = &accounts[5];
    let new_nft = &accounts[6];
    let new_asset_token_account = &accounts[7];
    let new_owner = &accounts[8];
    let emergency_record_account = &accounts[9];
    let org_authority = &accounts[10];
    let payer = &accounts[11];
    let system_program = &accounts[12];
    let mpl_core_program = &accounts[13];

    // Parse instruction data: new_owner(32) + reason(1) + shares_to_transfer(8) = 41 bytes
    let new_owner_pubkey = read_bytes32(data, 0, "new_owner")?;
    let reason = read_u8(data, 32, "reason")?;
    let shares_to_transfer = read_u64(data, 33, "shares_to_transfer")?;

    // Validate reason
    if reason > 5 {
        pinocchio_log::log!("invalid recovery reason: {}", reason);
        return Err(TokenizerError::InvalidRecoveryReason.into());
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
    let old_lockup_end = old_at.lockup_end;
    let old_last_transfer = old_at.last_transfer_at;
    let old_cost_basis = old_at.cost_basis_per_share;
    drop(old_at_ref);

    // Validate shares_to_transfer
    if shares_to_transfer > old_shares {
        pinocchio_log::log!("shares_to_transfer {} > old_shares {}", shares_to_transfer, old_shares);
        return Err(TokenizerError::InvalidSharesAmount.into());
    }

    // Determine effective shares and whether this is a partial transfer
    let effective_shares = if shares_to_transfer == 0 { old_shares } else { shares_to_transfer };
    let is_partial = effective_shares < old_shares;

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

    // Validate remaining accounts
    require_signer(new_nft, "new_nft")?;
    require_writable(new_nft, "new_nft")?;
    require_writable(new_asset_token_account, "new_asset_token_account")?;
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

    // Validate new_owner matches instruction data
    if new_owner.address().as_array() != &new_owner_pubkey {
        pinocchio_log::log!("new_owner: expected {}, got {}", Pk(&new_owner_pubkey), Pk(new_owner.address().as_array()));
        return Err(TokenizerError::InvalidAuthority.into());
    }

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

    // 6. Read collection.num_minted → new token_index
    let collection_ref = collection.try_borrow()?;
    let coll = CollectionV1::from_borsh(&collection_ref);
    let new_token_index = coll.num_minted;

    let coll_name = coll.get_name();
    let coll_uri = coll.get_uri();

    let mut name_buf = [0u8; 64];
    let name_base_len = coll_name.len();
    name_buf[..name_base_len].copy_from_slice(coll_name);
    name_buf[name_base_len] = b' ';
    name_buf[name_base_len + 1] = b'#';

    let mut uri_buf = [0u8; 200];
    let uri_len = coll_uri.len();
    uri_buf[..uri_len].copy_from_slice(coll_uri);
    drop(collection_ref);

    // NFT name: "Name #N"
    let display_index = new_token_index.saturating_add(1);
    let idx_buf = u32_to_bytes(display_index);
    let idx_len = u32_str_len(display_index);
    let name_len = name_base_len + 2 + idx_len;
    name_buf[name_base_len + 2..name_len].copy_from_slice(&idx_buf[..idx_len]);

    // Prepare attribute strings
    let shares_buf = u64_to_bytes(effective_shares);
    let shares_str = &shares_buf[..u64_str_len(effective_shares)];
    let asset_id_buf = u32_to_bytes(asset_id);
    let asset_id_str = &asset_id_buf[..u32_str_len(asset_id)];

    // 7. Mint new NFT via mint_nft_with_plugins (5 CPIs)
    mint_nft_with_plugins(
        new_nft,
        collection,
        collection_authority,
        payer,
        new_owner,
        system_program,
        mpl_core_program,
        &name_buf[..name_len],
        &uri_buf[..uri_len],
        shares_str,
        asset_id_str,
        &ca_bump_bytes,
    )?;

    // 8. Create + init new AssetToken PDA (recipient)
    let new_at_bump = require_pda(
        new_asset_token_account,
        &[ASSET_TOKEN_SEED, asset_account.address().as_ref(), &new_token_index.to_le_bytes()],
        program_id,
        "new_asset_token_account",
    )?;

    let new_at_bump_bytes = [new_at_bump];
    let new_at_index_bytes = new_token_index.to_le_bytes();
    let new_at_seeds = [
        Seed::from(ASSET_TOKEN_SEED),
        Seed::from(asset_account.address().as_ref()),
        Seed::from(new_at_index_bytes.as_ref()),
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

    let clock = Clock::get()?;
    let is_lost_keys = reason == 0;

    let mut new_at_data = new_asset_token_account.try_borrow_mut()?;
    let nat = unsafe { AssetToken::load_mut(&mut new_at_data) };
    nat.account_key = AccountKey::AssetToken as u8;
    nat.version = 1;
    nat.asset = asset_account.address().to_bytes();
    nat.nft = new_nft.address().to_bytes();
    nat.owner = new_owner_pubkey;
    nat.shares = effective_shares;
    nat.is_listed = 0;
    nat.active_votes = 0;
    nat.parent_token = old_asset_token_account.address().to_bytes();
    nat.last_claimed_epoch = old_last_claimed;
    nat.token_index = new_token_index;
    nat.created_at = clock.unix_timestamp;
    nat.bump = new_at_bump;
    // T&C fields: LostKeys carries forward, legal transfers reset
    if is_lost_keys {
        nat.lockup_end = old_lockup_end;
        nat.last_transfer_at = old_last_transfer;
        nat.cost_basis_per_share = old_cost_basis;
    } else {
        nat.lockup_end = 0;
        nat.last_transfer_at = clock.unix_timestamp;
        nat.cost_basis_per_share = 0;
    }
    drop(new_at_data);

    // 8b. Partial transfer: create remainder token for original owner
    let mut remainder_token_addr = [0u8; 32];
    if is_partial {
        if accounts.len() < 16 {
            return Err(ProgramError::NotEnoughAccountKeys);
        }
        let remainder_nft = &accounts[14];
        let remainder_asset_token = &accounts[15];

        require_signer(remainder_nft, "remainder_nft")?;
        require_writable(remainder_nft, "remainder_nft")?;
        require_writable(remainder_asset_token, "remainder_asset_token")?;

        // Read the next token index from collection
        let collection_ref2 = collection.try_borrow()?;
        let coll2 = CollectionV1::from_borsh(&collection_ref2);
        let remainder_token_index = coll2.num_minted;
        drop(collection_ref2);

        let remainder_shares = old_shares
            .checked_sub(effective_shares)
            .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;

        // Build remainder NFT name
        let rem_display_index = remainder_token_index.saturating_add(1);
        let rem_idx_buf = u32_to_bytes(rem_display_index);
        let rem_idx_len = u32_str_len(rem_display_index);
        let rem_name_len = name_base_len + 2 + rem_idx_len;
        let mut rem_name_buf = [0u8; 64];
        rem_name_buf[..name_base_len + 2].copy_from_slice(&name_buf[..name_base_len + 2]);
        rem_name_buf[name_base_len + 2..rem_name_len].copy_from_slice(&rem_idx_buf[..rem_idx_len]);

        let rem_shares_buf = u64_to_bytes(remainder_shares);
        let rem_shares_str = &rem_shares_buf[..u64_str_len(remainder_shares)];

        // Mint remainder NFT to OLD owner
        // Note: old_owner is not a signer, but we use the lost wallet's address.
        // The NFT goes to whoever held the token (the old_owner's wallet).
        // For Metaplex Core, the owner arg is just the recipient.
        // We need to find the old_owner account — it's at accounts[8] originally (new_owner).
        // Actually we need a reference to old_owner account. In the partial case,
        // the old owner can't sign. We'll use payer as the authority for mint_nft_with_plugins
        // but the NFT owner will be the old owner by address. However, for Metaplex Core
        // the owner is the first_owner field which the CreateV1 sets. Let me check...
        // The old owner account isn't provided. We need to be creative. Actually, let's just
        // use new_owner account ref for the new recipient, and for the remainder we need to
        // find an account for the old owner. But the old owner's wallet may not be accessible.
        //
        // Actually, looking at mint_nft_with_plugins, the `owner` param is just passed to
        // CreateV1 which sets the owner of the NFT. In Metaplex Core, you don't need to sign
        // to receive an NFT. So we just need the old_owner's pubkey. But we need an AccountView
        // reference. The account layout doesn't include old_owner.
        //
        // For the partial flow, the remainder goes back to the original owner. But the original
        // owner may have lost keys (reason=0). For legal transfers (reason 1-5), the remainder
        // stays with old owner who presumably still has access.
        //
        // We can't call mint_nft_with_plugins with an account we don't have. Let me reconsider:
        // For reason=0 (LostKeys), partial makes no sense (why would you partially recover
        // a lost key wallet?). For reason 1-5 (legal transfers), the old owner still has access.
        //
        // For now, we'll require an old_owner account at index 8 if partial. But wait, index 8
        // is new_owner. Let me re-read the account layout. Actually the old owner's pubkey can
        // be read from old_asset_token.owner. We just need an AccountInfo reference.
        //
        // The simplest approach: for partial transfer, the old_owner must be provided at index 8
        // (new_owner is already there). No wait, old_owner was the original token owner, and
        // for legal transfers they're accessible. But the account layout has new_owner at 8.
        //
        // Let me look at the account layout again:
        //   8. new_owner - recipient wallet
        // For partial, we'd need old_owner too. But old_owner's address is in old_asset_token.
        //
        // Actually, for Metaplex Core mint_nft_with_plugins, the owner parameter is just for
        // the CreateV1 instruction which sets the initial owner. We could create a separate
        // "mint to old owner" function, but that requires the old owner as an account.
        //
        // Simplest: For partial, since old owner's pubkey is known from old_at.owner, and
        // we don't actually need old_owner to sign (Metaplex Core doesn't require the new
        // owner to sign to receive an NFT), we just need the account passed as a reference.
        //
        // In the plan, the partial path has: remainder_nft at 14, remainder_asset_token at 15.
        // But we also need old_owner as an account for the NFT creation. We could put old_owner
        // at index 16. OR: since old_owner's pubkey is known, we can search existing accounts.
        //
        // Actually, looking at the current accounts:
        //   0-13 are the standard accounts
        //   14: remainder_nft (signer, writable)
        //   15: remainder_asset_token (writable)
        //
        // For the NFT, in mint_nft_with_plugins the `owner` account is the 5th arg.
        // We need to find it in accounts. The old_owner IS referenced through
        // old_asset_token.owner. But we need the AccountView.
        //
        // For now, let's require the old_owner wallet at index 16 for partial transfers.
        // But wait, we already have old_owner_key from old_at.owner. Let me check if
        // there's any account we already have that matches. The new_owner at 8 is the
        // NEW owner, not the old one. We don't have old_owner as an account.
        //
        // Let me simplify: for partial burn_and_remint, require old_owner account at
        // index 16. This is non-signer (old owner might have lost keys for reason 0,
        // but for legal transfers they're accessible). We don't need them to sign.
        // Metaplex Core just needs the address.
        if accounts.len() < 17 {
            return Err(ProgramError::NotEnoughAccountKeys);
        }
        let old_owner_account = &accounts[16];

        // Verify old_owner account matches old token owner
        if old_owner_account.address().as_array() != &old_owner_key {
            pinocchio_log::log!("old_owner: expected {}, got {}", Pk(&old_owner_key), Pk(old_owner_account.address().as_array()));
            return Err(TokenizerError::InvalidAuthority.into());
        }

        mint_nft_with_plugins(
            remainder_nft,
            collection,
            collection_authority,
            payer,
            old_owner_account,
            system_program,
            mpl_core_program,
            &rem_name_buf[..rem_name_len],
            &uri_buf[..uri_len],
            rem_shares_str,
            asset_id_str,
            &ca_bump_bytes,
        )?;

        // Create remainder AssetToken PDA
        let rem_at_bump = require_pda(
            remainder_asset_token,
            &[ASSET_TOKEN_SEED, asset_account.address().as_ref(), &remainder_token_index.to_le_bytes()],
            program_id,
            "remainder_asset_token",
        )?;

        let rem_at_bump_bytes = [rem_at_bump];
        let rem_at_index_bytes = remainder_token_index.to_le_bytes();
        let rem_at_seeds = [
            Seed::from(ASSET_TOKEN_SEED),
            Seed::from(asset_account.address().as_ref()),
            Seed::from(rem_at_index_bytes.as_ref()),
            Seed::from(&rem_at_bump_bytes),
        ];
        let rem_at_signer = Signer::from(&rem_at_seeds);

        CreateAccount {
            from: payer,
            to: remainder_asset_token,
            lamports: pinocchio::sysvars::rent::Rent::get()
                .map(|r| r.try_minimum_balance(AssetToken::LEN).unwrap_or(0))
                .unwrap_or(0),
            space: AssetToken::LEN as u64,
            owner: program_id,
        }
        .invoke_signed(&[rem_at_signer])?;

        let mut rem_at_data = remainder_asset_token.try_borrow_mut()?;
        let rat = unsafe { AssetToken::load_mut(&mut rem_at_data) };
        rat.account_key = AccountKey::AssetToken as u8;
        rat.version = 1;
        rat.asset = asset_account.address().to_bytes();
        rat.nft = remainder_nft.address().to_bytes();
        rat.owner = old_owner_key;
        rat.shares = remainder_shares;
        rat.is_listed = 0;
        rat.active_votes = 0;
        rat.parent_token = old_asset_token_account.address().to_bytes();
        rat.last_claimed_epoch = old_last_claimed;
        rat.token_index = remainder_token_index;
        rat.created_at = clock.unix_timestamp;
        rat.bump = rem_at_bump;
        // Remainder carries forward all T&C fields from original
        rat.lockup_end = old_lockup_end;
        rat.last_transfer_at = old_last_transfer;
        rat.cost_basis_per_share = old_cost_basis;
        drop(rem_at_data);

        remainder_token_addr = remainder_asset_token.address().to_bytes();
    }

    // 9. Create + init EmergencyRecord PDA
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
    er.recovery_type = 0; // burn_and_remint
    er.created_at = clock.unix_timestamp;
    er.bump = er_bump;
    er.reason = reason;
    er.shares_transferred = effective_shares;
    er.remainder_token = remainder_token_addr;
    drop(er_data);

    // 10. Zero out old AssetToken shares
    let mut old_at_data = old_asset_token_account.try_borrow_mut()?;
    let old_at = unsafe { AssetToken::load_mut(&mut old_at_data) };
    old_at.shares = 0;
    drop(old_at_data);

    Ok(())
}
