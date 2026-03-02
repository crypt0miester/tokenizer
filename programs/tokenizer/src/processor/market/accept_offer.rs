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
    utils::{mint_nft_with_plugins, spl_transfer_signed, close_token_account_signed, u32_str_len, u32_to_bytes, u64_str_len, u64_to_bytes, Pk},
    state::{
        asset::Asset,
        asset_token::AssetToken,
        offer::Offer,
        protocol_config::ProtocolConfig,
        validate_account_key, AccountKey, AssetStatus, OfferStatus,
        ASSET_SEED, ASSET_TOKEN_SEED, COLLECTION_AUTHORITY_SEED,
        OFFER_ESCROW_SEED, OFFER_SEED, PROTOCOL_CONFIG_SEED,
    },
    validation::{
        close_account, create_ata_if_needed, require_ata_program, require_mpl_core_program,
        require_owner, require_pda, require_pda_with_bump, require_signer, require_system_program,
        require_token_account, require_token_program, require_writable,
    },
};

/// Seller accepts an offer, executing the trade.
/// Token must NOT be listed (seller must delist first).
/// Payment comes from offer escrow (offer PDA signs).
///
/// Two code paths:
///   Full buy  (shares == token.shares): thaw → transfer → freeze
///   Partial buy (shares < token.shares): thaw → burn old → mint 2 new
///
/// Common accounts (0-17):
///   0.  config
///   1.  asset
///   2.  asset_token(w)
///   3.  offer(w)
///   4.  escrow(w)
///   5.  nft(w)
///   6.  collection(w)
///   7.  collection_authority
///   8.  seller(s)
///   9.  buyer
///   10. seller_token_acc(w)
///   11. fee_treasury_token(w)
///   12. payer(s,w)
///   13. accepted_mint
///   14. system_program
///   15. token_program
///   16. mpl_core_program
///   17. ata_program
///
/// Additional for partial (18-21):
///   18. new_nft_buyer(s)
///   19. buyer_asset_token(w)
///   20. new_nft_seller(s)
///   21. seller_asset_token(w)
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    _data: &[u8],
) -> ProgramResult {
    if accounts.len() < 18 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let config = &accounts[0];
    let asset_account = &accounts[1];
    let asset_token_account = &accounts[2];
    let offer_account = &accounts[3];
    let escrow = &accounts[4];
    let nft = &accounts[5];
    let collection = &accounts[6];
    let collection_authority = &accounts[7];
    let seller = &accounts[8];
    let buyer = &accounts[9];
    let seller_token_acc = &accounts[10];
    let fee_treasury_token = &accounts[11];
    let payer = &accounts[12];
    let accepted_mint = &accounts[13];
    let system_program = &accounts[14];
    let token_program = &accounts[15];
    let mpl_core_program = &accounts[16];
    let ata_program = &accounts[17];

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

    if &asset.collection != collection.address().as_array() {
        pinocchio_log::log!("asset.collection: expected {}, got {}", Pk(&asset.collection), Pk(collection.address().as_array()));
        return Err(TokenizerError::CollectionMismatch.into());
    }
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
    require_signer(seller, "seller")?;
    if &at.owner != seller.address().as_array() {
        pinocchio_log::log!("at.owner: expected {}, got {}", Pk(&at.owner), Pk(seller.address().as_array()));
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

    // Verify NFT matches
    if &at.nft != nft.address().as_array() {
        pinocchio_log::log!("at.nft: expected {}, got {}", Pk(&at.nft), Pk(nft.address().as_array()));
        return Err(TokenizerError::NftMismatch.into());
    }

    let token_shares = at.shares;
    let token_index = at.token_index;
    let original_last_claimed = at.last_claimed_epoch;
    let at_bump = at.bump;
    let at_lockup_end = at.lockup_end;
    let at_last_transfer_at = at.last_transfer_at;
    let at_cost_basis = at.cost_basis_per_share;
    drop(at_ref);

    require_pda_with_bump(
        asset_token_account,
        &[ASSET_TOKEN_SEED, asset_account.address().as_ref(), &token_index.to_le_bytes(), &[at_bump]],
        program_id,
        "asset_token_account",
    )?;

    // Check lockup and cooldown on seller's token
    {
        let asset_ref2 = asset_account.try_borrow()?;
        let asset2 = unsafe { Asset::load(&asset_ref2) };
        let cooldown = asset2.transfer_cooldown;
        drop(asset_ref2);

        let clock_check = Clock::get()?;
        if at_lockup_end != 0 && clock_check.unix_timestamp < at_lockup_end {
            pinocchio_log::log!("token locked until {}", at_lockup_end);
            return Err(TokenizerError::TokenLocked.into());
        }
        if cooldown != 0 && clock_check.unix_timestamp - at_last_transfer_at < cooldown {
            pinocchio_log::log!("transfer cooldown active");
            return Err(TokenizerError::TransferCooldownActive.into());
        }
    }

    // Validate offer
    require_owner(offer_account, program_id, "offer_account")?;
    require_writable(offer_account, "offer_account")?;
    let offer_ref = offer_account.try_borrow()?;
    validate_account_key(&offer_ref, AccountKey::Offer)?;
    let offer = unsafe { Offer::load(&offer_ref) };

    if offer.status != OfferStatus::Active as u8 {
        pinocchio_log::log!("offer.status: {}", offer.status);
        return Err(TokenizerError::OfferNotActive.into());
    }

    // Verify offer targets this asset_token
    if &offer.asset_token != asset_token_account.address().as_array() {
        pinocchio_log::log!("offer.asset_token: expected {}, got {}", Pk(&offer.asset_token), Pk(asset_token_account.address().as_array()));
        return Err(TokenizerError::OfferTokenMismatch.into());
    }

    // Verify buyer matches
    if &offer.buyer != buyer.address().as_array() {
        pinocchio_log::log!("offer.buyer: expected {}, got {}", Pk(&offer.buyer), Pk(buyer.address().as_array()));
        return Err(TokenizerError::BuyerMismatch.into());
    }

    // Verify escrow matches
    if &offer.escrow != escrow.address().as_array() {
        pinocchio_log::log!("offer.escrow: expected {}, got {}", Pk(&offer.escrow), Pk(escrow.address().as_array()));
        return Err(TokenizerError::EscrowMismatch.into());
    }

    // Check expiry
    let clock = Clock::get()?;
    if offer.expiry != 0 && clock.unix_timestamp > offer.expiry {
        pinocchio_log::log!("expired: now={}, expiry={}", clock.unix_timestamp, offer.expiry);
        return Err(TokenizerError::OfferExpired.into());
    }

    let shares_requested = offer.shares_requested;
    let price_per_share = offer.price_per_share;
    let total_deposited = offer.total_deposited;
    let offer_bump = offer.bump;
    let escrow_bump = offer.escrow_bump;
    let buyer_key = offer.buyer;
    drop(offer_ref);

    // Validate offer PDA
    require_pda_with_bump(
        offer_account,
        &[OFFER_SEED, asset_token_account.address().as_ref(), &buyer_key, &[offer_bump]],
        program_id,
        "offer_account",
    )?;

    // Validate escrow PDA
    require_pda_with_bump(
        escrow,
        &[OFFER_ESCROW_SEED, offer_account.address().as_ref(), &[escrow_bump]],
        program_id,
        "escrow",
    )?;

    // Validate remaining common accounts
    require_signer(payer, "payer")?;
    require_writable(nft, "nft")?;
    require_writable(collection, "collection")?;
    require_writable(escrow, "escrow")?;
    require_writable(seller_token_acc, "seller_token_acc")?;
    require_writable(fee_treasury_token, "fee_treasury_token")?;
    require_system_program(system_program)?;
    require_token_program(token_program)?;
    require_ata_program(ata_program)?;
    require_mpl_core_program(mpl_core_program)?;

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

    // Create seller ATA if needed
    create_ata_if_needed(payer, seller_token_acc, seller, accepted_mint, system_program, token_program)?;

    // Validate seller token account: SPL Token owned, correct mint, correct owner
    require_token_account(seller_token_acc, &accepted_mint_key, seller.address().as_array())?;

    // Determine effective shares
    let effective_shares = if shares_requested == 0 {
        token_shares
    } else {
        shares_requested
    };

    // Calculate payment from escrow
    let total_price = u64::try_from(
        (effective_shares as u128)
            .checked_mul(price_per_share as u128)
            .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?
    ).map_err(|_| -> ProgramError { TokenizerError::MathOverflow.into() })?;

    // Sanity check: total_deposited should be >= total_price
    if total_deposited < total_price {
        pinocchio_log::log!("escrow: deposited={}, needed={}", total_deposited, total_price);
        return Err(TokenizerError::InsufficientEscrowDeposit.into());
    }

    let fee = u64::try_from(
        (total_price as u128)
            .checked_mul(fee_bps as u128)
            .and_then(|v| v.checked_div(10_000))
            .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?
    ).map_err(|_| -> ProgramError { TokenizerError::MathOverflow.into() })?;

    let seller_proceeds = total_price
        .checked_sub(fee)
        .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;

    // SPL Transfers from escrow (offer PDA signs)
    let offer_bump_bytes = [offer_bump];

    if fee > 0 {
        let offer_seeds1 = [
            Seed::from(OFFER_SEED),
            Seed::from(asset_token_account.address().as_ref()),
            Seed::from(buyer_key.as_ref()),
            Seed::from(&offer_bump_bytes),
        ];
        spl_transfer_signed(escrow, fee_treasury_token, offer_account, fee, &accepted_mint_key, &offer_seeds1)?;
    }

    let offer_seeds2 = [
        Seed::from(OFFER_SEED),
        Seed::from(asset_token_account.address().as_ref()),
        Seed::from(buyer_key.as_ref()),
        Seed::from(&offer_bump_bytes),
    ];
    spl_transfer_signed(escrow, seller_token_acc, offer_account, seller_proceeds, &accepted_mint_key, &offer_seeds2)?;

    let is_full_buy = effective_shares == token_shares;

    if is_full_buy {
        // ── Full buy: thaw → transfer → re-freeze ──
        // PermanentFreezeDelegate (authority-managed) persists through transfer,
        // so the collection authority retains freeze control.

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
            new_owner: buyer,
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

        // Update AssetToken owner and T&C fields
        let mut at_data = asset_token_account.try_borrow_mut()?;
        let at = unsafe { AssetToken::load_mut(&mut at_data) };
        at.owner = buyer.address().to_bytes();
        at.last_transfer_at = clock.unix_timestamp;
        at.cost_basis_per_share = price_per_share;
        drop(at_data);
    } else {
        // ── Partial buy: burn old → mint 2 new ──

        if accounts.len() < 22 {
            return Err(ProgramError::NotEnoughAccountKeys);
        }

        let new_nft_buyer = &accounts[18];
        let buyer_asset_token = &accounts[19];
        let new_nft_seller = &accounts[20];
        let seller_asset_token = &accounts[21];

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

        // Build NFT names
        let buyer_index_num = token_index_buyer.saturating_add(1);
        let buyer_idx_buf = u32_to_bytes(buyer_index_num);
        let buyer_idx_len = u32_str_len(buyer_index_num);
        let buyer_name_len = name_base_len + 2 + buyer_idx_len;
        let mut buyer_name_buf = [0u8; 64];
        buyer_name_buf[..name_base_len + 2].copy_from_slice(&name_buf[..name_base_len + 2]);
        buyer_name_buf[name_base_len + 2..buyer_name_len].copy_from_slice(&buyer_idx_buf[..buyer_idx_len]);

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

        let buyer_shares = effective_shares;
        let remaining_shares = token_shares
            .checked_sub(effective_shares)
            .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;

        // Attribute strings
        let buyer_shares_buf = u64_to_bytes(buyer_shares);
        let buyer_shares_str = &buyer_shares_buf[..u64_str_len(buyer_shares)];
        let seller_shares_buf = u64_to_bytes(remaining_shares);
        let seller_shares_str = &seller_shares_buf[..u64_str_len(remaining_shares)];
        let asset_id_buf = u32_to_bytes(asset_id);
        let asset_id_str = &asset_id_buf[..u32_str_len(asset_id)];

        // Thaw + Burn old NFT
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

        // Mint buyer NFT
        mint_nft_with_plugins(
            new_nft_buyer, collection, collection_authority, payer, buyer,
            system_program, mpl_core_program, &buyer_name_buf[..buyer_name_len], &uri_buf[..uri_len],
            buyer_shares_str, asset_id_str, &ca_bump_bytes,
        )?;

        // Mint seller NFT
        mint_nft_with_plugins(
            new_nft_seller, collection, collection_authority, payer, seller,
            system_program, mpl_core_program, &seller_name_buf[..seller_name_len], &uri_buf[..uri_len],
            seller_shares_str, asset_id_str, &ca_bump_bytes,
        )?;

        // Create buyer AssetToken PDA
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

        // Create seller AssetToken PDA
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

    }

    // Close escrow token account — CPI must happen before direct lamport modifications
    let offer_seeds3 = [
        Seed::from(OFFER_SEED),
        Seed::from(asset_token_account.address().as_ref()),
        Seed::from(buyer_key.as_ref()),
        Seed::from(&offer_bump_bytes),
    ];
    close_token_account_signed(escrow, payer, offer_account, &offer_seeds3)?;

    // Direct lamport closes after all CPIs
    if !is_full_buy {
        close_account(asset_token_account, payer)?;
    }
    close_account(offer_account, payer)?;

    Ok(())
}
