use pinocchio::{
    cpi::{Seed, Signer},
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    AccountView,
    Address,
    ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;

use p_core::instructions::{BurnV1, PluginUpdateData, TransferV1, UpdatePluginV1};
use p_core::state::CollectionV1;

use crate::{
    error::TokenizerError,
    utils::{mint_nft_with_plugins, spl_transfer, u32_str_len, u32_to_bytes, u64_str_len, u64_to_bytes, Pk},
    state::{
        asset::Asset,
        asset_token::AssetToken,
        listing::Listing,
        protocol_config::ProtocolConfig,
        validate_account_key, AccountKey, AssetStatus, ListingStatus,
        ASSET_SEED, ASSET_TOKEN_SEED, COLLECTION_AUTHORITY_SEED,
        LISTING_SEED, PROTOCOL_CONFIG_SEED,
    },
    validation::{
        close_account, create_ata_if_needed, require_ata_program, require_mpl_core_program,
        require_owner, require_pda, require_pda_with_bump, require_rent_destination,
        require_signer, require_system_program, require_token_account, require_token_program,
        require_writable,
    },
};

/// Purchase a listed token on the secondary market.
///
/// Two code paths:
///   Full buy  (shares_for_sale == token.shares): thaw → transfer → freeze
///   Partial buy (shares_for_sale < token.shares): burn old → mint 2 new
///
/// Common accounts (0-17):
///   0.  config
///   1.  asset
///   2.  asset_token(w)
///   3.  listing(w)
///   4.  nft(w)
///   5.  collection(w)
///   6.  collection_authority
///   7.  buyer(s)
///   8.  seller
///   9.  buyer_token_acc(w)
///   10. seller_token_acc(w)
///   11. fee_treasury_token(w)
///   12. payer(s,w)
///   13. accepted_mint
///   14. system_program
///   15. token_program
///   16. mpl_core_program
///   17. ata_program
///   18. rent_destination(w) — original rent payer
///
/// Additional for partial (19-22):
///   19. new_nft_buyer(s)
///   20. buyer_asset_token(w)
///   21. new_nft_seller(s)
///   22. seller_asset_token(w)
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    _data: &[u8],
) -> ProgramResult {
    if accounts.len() < 19 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let config = &accounts[0];
    let asset_account = &accounts[1];
    let asset_token_account = &accounts[2];
    let listing_account = &accounts[3];
    let nft = &accounts[4];
    let collection = &accounts[5];
    let collection_authority = &accounts[6];
    let buyer = &accounts[7];
    let seller = &accounts[8];
    let buyer_token_acc = &accounts[9];
    let seller_token_acc = &accounts[10];
    let fee_treasury_token = &accounts[11];
    let payer = &accounts[12];
    let accepted_mint = &accounts[13];
    let system_program = &accounts[14];
    let token_program = &accounts[15];
    let mpl_core_program = &accounts[16];
    let ata_program = &accounts[17];
    let rent_destination = &accounts[18];

    // Validate protocol
    require_owner(config, program_id, "config")?;
    let config_ref = config.try_borrow()?;
    validate_account_key(&config_ref, AccountKey::ProtocolConfig)?;
    let config_data = unsafe { ProtocolConfig::load(&config_ref) };
    require_pda_with_bump(config, &[PROTOCOL_CONFIG_SEED, &[config_data.bump]], program_id, "config")?;
    config_data.require_not_paused()?;
    let fee_bps = config_data.fee_bps;
    let fee_treasury = config_data.fee_treasury;
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

    // Block during active buyout
    if asset.active_buyout != [0u8; 32] {
        pinocchio_log::log!("blocked: active buyout exists");
        return Err(TokenizerError::BuyoutActiveBuyoutExists.into());
    }

    let org_key = asset.organization;
    let asset_id = asset.id;
    let ca_bump = asset.collection_authority_bump;
    let accepted_mint_key = asset.accepted_mint;
    let asset_bump = asset.bump;

    // Verify collection matches
    if &asset.collection != collection.address().as_array() {
        pinocchio_log::log!("asset.collection: expected {}, got {}", Pk(&asset.collection), Pk(collection.address().as_array()));
        return Err(TokenizerError::CollectionMismatch.into());
    }

    let asset_max_holders = asset.max_holders;
    let asset_current_holders = asset.current_holders;
    drop(asset_ref);

    // Validate accepted_mint matches asset
    if accepted_mint.address().as_array() != &accepted_mint_key {
        pinocchio_log::log!("accepted_mint: expected {}, got {}", Pk(&accepted_mint_key), Pk(accepted_mint.address().as_array()));
        return Err(TokenizerError::InvalidMint.into());
    }

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

    // Verify seller owns token
    if &at.owner != seller.address().as_array() {
        pinocchio_log::log!("at.owner: expected {}, got {}", Pk(&at.owner), Pk(seller.address().as_array()));
        return Err(TokenizerError::NotTokenOwner.into());
    }

    // Verify NFT matches
    if &at.nft != nft.address().as_array() {
        pinocchio_log::log!("at.nft: expected {}, got {}", Pk(&at.nft), Pk(nft.address().as_array()));
        return Err(TokenizerError::NftMismatch.into());
    }

    if at.has_active_votes() {
        return Err(TokenizerError::GovernanceTokenLocked.into());
    }

    let token_shares = at.shares;
    let token_index = at.token_index;
    let original_last_claimed = at.last_claimed_epoch;
    let at_bump = at.bump;
    let at_lockup_end = at.lockup_end;
    let at_last_transfer_at = at.last_transfer_at;
    let at_cost_basis = at.cost_basis_per_share;
    drop(at_ref);

    // Validate asset_token PDA
    require_pda_with_bump(
        asset_token_account,
        &[ASSET_TOKEN_SEED, asset_account.address().as_ref(), &token_index.to_le_bytes(), &[at_bump]],
        program_id,
        "asset_token_account",
    )?;

    // Validate listing
    require_owner(listing_account, program_id, "listing_account")?;
    require_writable(listing_account, "listing_account")?;
    let listing_ref = listing_account.try_borrow()?;
    validate_account_key(&listing_ref, AccountKey::Listing)?;
    let listing = unsafe { Listing::load(&listing_ref) };

    if listing.status != ListingStatus::Active as u8 {
        pinocchio_log::log!("listing.status: {}", listing.status);
        return Err(TokenizerError::ListingNotActive.into());
    }

    // Verify listing references this asset_token
    if &listing.asset_token != asset_token_account.address().as_array() {
        pinocchio_log::log!("listing.asset_token: expected {}, got {}", Pk(&listing.asset_token), Pk(asset_token_account.address().as_array()));
        return Err(TokenizerError::ListingTokenMismatch.into());
    }

    // Check expiry
    let clock = Clock::get()?;
    if listing.expiry != 0 && clock.unix_timestamp > listing.expiry {
        pinocchio_log::log!("expired: now={}, expiry={}", clock.unix_timestamp, listing.expiry);
        return Err(TokenizerError::ListingExpired.into());
    }

    let shares_for_sale = listing.shares_for_sale;
    let price_per_share = listing.price_per_share;
    let is_partial = listing.is_partial;
    let listing_bump = listing.bump;
    let listing_rent_payer = listing.rent_payer;
    drop(listing_ref);

    // Validate listing PDA
    require_pda_with_bump(
        listing_account,
        &[LISTING_SEED, asset_token_account.address().as_ref(), &[listing_bump]],
        program_id,
        "listing_account",
    )?;

    // Buyer cannot be the seller
    require_signer(buyer, "buyer")?;
    if buyer.address() == seller.address() {
        pinocchio_log::log!("buyer is seller ({})", Pk(buyer.address().as_array()));
        return Err(TokenizerError::InvalidBuyer.into());
    }

    // Validate remaining common accounts
    require_signer(payer, "payer")?;
    require_writable(nft, "nft")?;
    require_writable(collection, "collection")?;
    require_writable(buyer_token_acc, "buyer_token_acc")?;
    require_writable(seller_token_acc, "seller_token_acc")?;
    require_writable(fee_treasury_token, "fee_treasury_token")?;
    require_system_program(system_program)?;
    require_token_program(token_program)?;
    require_ata_program(ata_program)?;
    require_mpl_core_program(mpl_core_program)?;
    require_rent_destination(rent_destination, &listing_rent_payer)?;

    // Validate collection authority PDA
    require_pda_with_bump(
        collection_authority,
        &[COLLECTION_AUTHORITY_SEED, collection.address().as_ref(), &[ca_bump]],
        program_id,
        "collection_authority",
    )?;

    // Validate fee treasury matches protocol config
    if fee_treasury_token.address().as_array() != &fee_treasury {
        pinocchio_log::log!("fee_treasury_token: expected {}, got {}", Pk(&fee_treasury), Pk(fee_treasury_token.address().as_array()));
        return Err(TokenizerError::InvalidFeeTreasury.into());
    }

    // Validate buyer token account: SPL Token owned, correct mint, correct owner
    require_token_account(buyer_token_acc, &accepted_mint_key, buyer.address().as_array())?;

    // Create seller ATA if needed
    create_ata_if_needed(payer, seller_token_acc, seller, accepted_mint, system_program, token_program)?;

    // Validate seller token account: SPL Token owned, correct mint, correct owner
    require_token_account(seller_token_acc, &accepted_mint_key, seller.address().as_array())?;

    // Calculate payment
    let total_price = u64::try_from(
        (shares_for_sale as u128)
            .checked_mul(price_per_share as u128)
            .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?
    ).map_err(|_| -> ProgramError { TokenizerError::MathOverflow.into() })?;

    let fee = u64::try_from(
        (total_price as u128)
            .checked_mul(fee_bps as u128)
            .and_then(|v| v.checked_div(10_000))
            .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?
    ).map_err(|_| -> ProgramError { TokenizerError::MathOverflow.into() })?;

    let seller_proceeds = total_price
        .checked_sub(fee)
        .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;

    // SPL Transfers: fee + payment from buyer
    if fee > 0 {
        spl_transfer(buyer_token_acc, fee_treasury_token, buyer, fee, &accepted_mint_key)?;
    }
    spl_transfer(buyer_token_acc, seller_token_acc, buyer, seller_proceeds, &accepted_mint_key)?;

    let is_full_buy = shares_for_sale == token_shares;

    if !is_full_buy && is_partial == 0 {
        pinocchio_log::log!("listing does not allow partial buys");
        return Err(TokenizerError::PartialBuyNotAllowed.into());
    }

    if is_full_buy {
        // Full buy: thaw → transfer → freeze

        // Thaw NFT
        let ca_bump_bytes = [ca_bump];
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

        // Transfer NFT to buyer
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
            new_owner: buyer,
            system_program,
            log_wrapper: mpl_core_program,
        }
        .invoke_signed(&[ca_signer2])?;

        // Re-freeze NFT (PermanentFreezeDelegate authority persists through transfer)
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

        // Update AssetToken owner and T&C fields
        let mut at_data = asset_token_account.try_borrow_mut()?;
        let at = unsafe { AssetToken::load_mut(&mut at_data) };
        at.owner = buyer.address().to_bytes();
        at.is_listed = 0;
        at.last_transfer_at = clock.unix_timestamp;
        at.cost_basis_per_share = price_per_share;
        drop(at_data);
    } else {
        // Partial buy: burn old → mint 2 new

        if accounts.len() < 23 {
            return Err(ProgramError::NotEnoughAccountKeys);
        }

        let new_nft_buyer = &accounts[19];
        let buyer_asset_token = &accounts[20];
        let new_nft_seller = &accounts[21];
        let seller_asset_token = &accounts[22];

        require_signer(new_nft_buyer, "new_nft_buyer")?;
        require_writable(new_nft_buyer, "new_nft_buyer")?;
        require_writable(buyer_asset_token, "buyer_asset_token")?;
        require_signer(new_nft_seller, "new_nft_seller")?;
        require_writable(new_nft_seller, "new_nft_seller")?;
        require_writable(seller_asset_token, "seller_asset_token")?;

        // Read collection for name/URI
        let collection_ref = collection.try_borrow()?;
        let coll = CollectionV1::from_borsh(&collection_ref);
        let token_index_buyer = coll.num_minted;

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

        // Buyer NFT name: "Name #N"
        let buyer_index_num = token_index_buyer.saturating_add(1);
        let buyer_idx_buf = u32_to_bytes(buyer_index_num);
        let buyer_idx_len = u32_str_len(buyer_index_num);
        let buyer_name_len = name_base_len + 2 + buyer_idx_len;
        let mut buyer_name_buf = [0u8; 64];
        buyer_name_buf[..name_base_len + 2].copy_from_slice(&name_buf[..name_base_len + 2]);
        buyer_name_buf[name_base_len + 2..buyer_name_len].copy_from_slice(&buyer_idx_buf[..buyer_idx_len]);

        // Seller NFT name: "Name #N+1"
        let seller_index_num = token_index_buyer.saturating_add(2);
        let token_index_seller = token_index_buyer
            .checked_add(1)
            .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;
        let seller_idx_buf = u32_to_bytes(seller_index_num);
        let seller_idx_len = u32_str_len(seller_index_num);
        let seller_name_len = name_base_len + 2 + seller_idx_len;
        let mut seller_name_buf = [0u8; 64];
        seller_name_buf[..name_base_len + 2].copy_from_slice(&name_buf[..name_base_len + 2]);
        seller_name_buf[name_base_len + 2..seller_name_len].copy_from_slice(&seller_idx_buf[..seller_idx_len]);

        // Validate new AssetToken PDAs
        let buyer_at_bump = require_pda(
            buyer_asset_token,
            &[ASSET_TOKEN_SEED, asset_account.address().as_ref(), &token_index_buyer.to_le_bytes()],
            program_id,
            "buyer_asset_token",
        )?;

        let seller_at_bump = require_pda(
            seller_asset_token,
            &[ASSET_TOKEN_SEED, asset_account.address().as_ref(), &token_index_seller.to_le_bytes()],
            program_id,
            "seller_asset_token",
        )?;

        let buyer_shares = shares_for_sale;
        let remaining_shares = token_shares
            .checked_sub(shares_for_sale)
            .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;

        // Prepare attribute strings
        let buyer_shares_buf = u64_to_bytes(buyer_shares);
        let buyer_shares_str = &buyer_shares_buf[..u64_str_len(buyer_shares)];
        let seller_shares_buf = u64_to_bytes(remaining_shares);
        let seller_shares_str = &seller_shares_buf[..u64_str_len(remaining_shares)];
        let asset_id_buf = u32_to_bytes(asset_id);
        let asset_id_str = &asset_id_buf[..u32_str_len(asset_id)];

        // 1. Thaw + Burn old NFT
        let ca_bump_bytes = [ca_bump];
        let ca_seeds_thaw = [
            Seed::from(COLLECTION_AUTHORITY_SEED),
            Seed::from(collection.address().as_ref()),
            Seed::from(&ca_bump_bytes),
        ];
        let ca_signer_thaw = Signer::from(&ca_seeds_thaw);

        UpdatePluginV1 {
            asset: nft,
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
            asset: nft,
            collection,
            payer,
            authority: collection_authority,
            system_program,
            log_wrapper: mpl_core_program,
        }
        .invoke_signed(&[ca_signer_burn])?;

        // 2. Mint buyer NFT (5 CPIs: CreateV1 + 4 AddPluginV1)
        mint_nft_with_plugins(
            new_nft_buyer,
            collection,
            collection_authority,
            payer,
            buyer,
            system_program,
            mpl_core_program,
            &buyer_name_buf[..buyer_name_len],
            &uri_buf[..uri_len],
            buyer_shares_str,
            asset_id_str,
            &ca_bump_bytes,
        )?;

        // 3. Mint seller NFT (5 CPIs: CreateV1 + 4 AddPluginV1)
        mint_nft_with_plugins(
            new_nft_seller,
            collection,
            collection_authority,
            payer,
            seller,
            system_program,
            mpl_core_program,
            &seller_name_buf[..seller_name_len],
            &uri_buf[..uri_len],
            seller_shares_str,
            asset_id_str,
            &ca_bump_bytes,
        )?;

        // 4. Create buyer AssetToken PDA
        let buyer_at_bump_bytes = [buyer_at_bump];
        let buyer_at_index_bytes = token_index_buyer.to_le_bytes();
        let buyer_at_seeds = [
            Seed::from(ASSET_TOKEN_SEED),
            Seed::from(asset_account.address().as_ref()),
            Seed::from(buyer_at_index_bytes.as_ref()),
            Seed::from(&buyer_at_bump_bytes),
        ];
        let buyer_at_signer = Signer::from(&buyer_at_seeds);

        CreateAccount {
            from: payer,
            to: buyer_asset_token,
            lamports: pinocchio::sysvars::rent::Rent::get()
                .map(|r| r.try_minimum_balance(AssetToken::LEN).unwrap_or(0))
                .unwrap_or(0),
            space: AssetToken::LEN as u64,
            owner: program_id,
        }
        .invoke_signed(&[buyer_at_signer])?;

        // Initialize buyer AssetToken
        let mut buyer_at_data = buyer_asset_token.try_borrow_mut()?;
        let bat = unsafe { AssetToken::load_mut(&mut buyer_at_data) };
        bat.account_key = AccountKey::AssetToken as u8;
        bat.version = 1;
        bat.asset = asset_account.address().to_bytes();
        bat.nft = new_nft_buyer.address().to_bytes();
        bat.owner = buyer.address().to_bytes();
        bat.shares = buyer_shares;
        bat.is_listed = 0;
        bat.active_votes = 0;
        bat.parent_token = asset_token_account.address().to_bytes();
        bat.last_claimed_epoch = original_last_claimed;
        bat.token_index = token_index_buyer;
        bat.created_at = clock.unix_timestamp;
        bat.bump = buyer_at_bump;
        bat.lockup_end = 0;
        bat.last_transfer_at = clock.unix_timestamp;
        bat.cost_basis_per_share = price_per_share;
        drop(buyer_at_data);

        // Max holders check (partial buy creates new holder)
        if asset_max_holders != 0 && asset_current_holders >= asset_max_holders {
            pinocchio_log::log!("max holders reached: {}/{}", asset_current_holders, asset_max_holders);
            return Err(TokenizerError::MaxHoldersReached.into());
        }

        // Increment current_holders on asset (asset must be writable)
        require_writable(asset_account, "asset_account")?;
        let mut asset_mut2 = asset_account.try_borrow_mut()?;
        let asset2 = unsafe { Asset::load_mut(&mut asset_mut2) };
        asset2.current_holders = asset_current_holders
            .checked_add(1)
            .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;
        drop(asset_mut2);

        // 5. Create seller AssetToken PDA
        let seller_at_bump_bytes = [seller_at_bump];
        let seller_at_index_bytes = token_index_seller.to_le_bytes();
        let seller_at_seeds = [
            Seed::from(ASSET_TOKEN_SEED),
            Seed::from(asset_account.address().as_ref()),
            Seed::from(seller_at_index_bytes.as_ref()),
            Seed::from(&seller_at_bump_bytes),
        ];
        let seller_at_signer = Signer::from(&seller_at_seeds);

        CreateAccount {
            from: payer,
            to: seller_asset_token,
            lamports: pinocchio::sysvars::rent::Rent::get()
                .map(|r| r.try_minimum_balance(AssetToken::LEN).unwrap_or(0))
                .unwrap_or(0),
            space: AssetToken::LEN as u64,
            owner: program_id,
        }
        .invoke_signed(&[seller_at_signer])?;

        // Initialize seller AssetToken
        let mut seller_at_data = seller_asset_token.try_borrow_mut()?;
        let sat = unsafe { AssetToken::load_mut(&mut seller_at_data) };
        sat.account_key = AccountKey::AssetToken as u8;
        sat.version = 1;
        sat.asset = asset_account.address().to_bytes();
        sat.nft = new_nft_seller.address().to_bytes();
        sat.owner = seller.address().to_bytes();
        sat.shares = remaining_shares;
        sat.is_listed = 0;
        sat.active_votes = 0;
        sat.parent_token = asset_token_account.address().to_bytes();
        sat.last_claimed_epoch = original_last_claimed;
        sat.token_index = token_index_seller;
        sat.created_at = clock.unix_timestamp;
        sat.bump = seller_at_bump;
        sat.lockup_end = at_lockup_end;
        sat.last_transfer_at = at_last_transfer_at;
        sat.cost_basis_per_share = at_cost_basis;
        drop(seller_at_data);

        // 6. Close spent AssetToken — rent to payer
        close_account(asset_token_account, payer)?;
    }

    // Close listing account — rent SOL to original payer
    close_account(listing_account, rent_destination)?;

    Ok(())
}
