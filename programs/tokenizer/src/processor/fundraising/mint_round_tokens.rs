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
    utils::{mint_nft_with_plugins, u32_str_len, u32_to_bytes, u64_str_len, u64_to_bytes, Pk},
    state::{
        asset::Asset,
        asset_token::AssetToken,
        fundraising_round::FundraisingRound,
        investment::Investment,
        validate_account_key, AccountKey, RoundStatus,
        ASSET_SEED, ASSET_TOKEN_SEED, COLLECTION_AUTHORITY_SEED, FUNDRAISING_ROUND_SEED,
        INVESTMENT_SEED,
    },
    validation::{
        require_mpl_core_program, require_owner, require_pda, require_pda_with_bump,
        require_signer, require_system_program, require_writable,
    },
};

const FIXED_ACCOUNTS: usize = 7;
const ACCOUNTS_PER_INVESTOR: usize = 4;
const MAX_BATCH_SIZE: usize = 10;

/// Permissionless crank: batch-mint NFTs for investors after successful round.
///
/// Processes 1–10 investors per transaction. The caller chooses the batch
/// size based on available compute budget.
///
/// Instruction data layout:
/// [0] count: u8 — number of investors in this batch (1–10)
///
/// Account layout:
///   Fixed (7):
///     0. round_account        — FundraisingRound (writable)
///     1. asset_account        — Asset (writable)
///     2. collection           — Metaplex Core collection (writable)
///     3. collection_authority — Collection authority PDA
///     4. payer                — Signer, writable
///     5. system_program
///     6. mpl_core_program
///
///   Per investor (repeated `count` times, 4 accounts each):
///     7 + i*4 + 0. investment_account  — Investment PDA (writable)
///     7 + i*4 + 1. asset_token_account — AssetToken PDA (writable, to create)
///     7 + i*4 + 2. nft                 — New keypair, signer
///     7 + i*4 + 3. investor            — Investor wallet (NFT recipient)
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    // Parse batch count
    if data.is_empty() {
        return Err(TokenizerError::InstructionDataTooShort.into());
    }
    let count = data[0] as usize;
    if count == 0 || count > MAX_BATCH_SIZE {
        return Err(TokenizerError::InvalidRoundConfig.into());
    }

    let expected_accounts = FIXED_ACCOUNTS + count * ACCOUNTS_PER_INVESTOR;
    if accounts.len() < expected_accounts {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    // Extract fixed accounts
    let round_account = &accounts[0];
    let asset_account = &accounts[1];
    let collection = &accounts[2];
    let collection_authority = &accounts[3];
    let payer = &accounts[4];
    let system_program = &accounts[5];
    let mpl_core_program = &accounts[6];

    // ── Validate shared accounts (once) ─────────────────────────────

    // Validate round
    require_owner(round_account, program_id, "round_account")?;
    require_writable(round_account, "round_account")?;
    let round_ref = round_account.try_borrow()?;
    validate_account_key(&round_ref, AccountKey::FundraisingRound)?;
    let round = unsafe { FundraisingRound::load(&round_ref) };

    if round.status() != RoundStatus::Succeeded {
        pinocchio_log::log!("round.status: {}", round.status);
        return Err(TokenizerError::RoundNotSucceeded.into());
    }

    let round_index = round.round_index;
    let asset_key = round.asset;
    let investors_settled = round.investors_settled;
    let round_bump = round.bump;
    let round_lockup_end = round.lockup_end;
    let round_price_per_share = round.price_per_share;
    drop(round_ref);

    require_pda_with_bump(
        round_account,
        &[FUNDRAISING_ROUND_SEED, &asset_key, &round_index.to_le_bytes(), &[round_bump]],
        program_id,
        "round_account",
    )?;

    // Validate asset
    require_owner(asset_account, program_id, "asset_account")?;
    require_writable(asset_account, "asset_account")?;
    let asset_ref = asset_account.try_borrow()?;
    validate_account_key(&asset_ref, AccountKey::Asset)?;
    let asset = unsafe { Asset::load(&asset_ref) };

    if asset_account.address().as_array() != &asset_key {
        pinocchio_log::log!("round.asset: expected {}, got {}", Pk(&asset_key), Pk(asset_account.address().as_array()));
        return Err(TokenizerError::RoundAssetMismatch.into());
    }

    let asset_id = asset.id;
    let org_key = asset.organization;
    let ca_bump = asset.collection_authority_bump;
    let asset_bump = asset.bump;
    let mut minted_shares = asset.minted_shares;
    let total_shares = asset.total_shares;
    let dividend_epoch = asset.dividend_epoch;

    // Block during active buyout
    if asset.active_buyout != [0u8; 32] {
        pinocchio_log::log!("blocked: active buyout exists");
        return Err(TokenizerError::BuyoutActiveBuyoutExists.into());
    }

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

    // Read collection name + URI (stable across batch)
    let collection_ref = collection.try_borrow()?;
    let coll = CollectionV1::from_borsh(&collection_ref);
    let initial_token_index = coll.num_minted;

    let coll_name = coll.get_name();
    let coll_uri = coll.get_uri();
    let coll_name_len = coll_name.len();
    let mut name_prefix_buf = [0u8; 34]; // max 32 name + ' ' + '#'
    name_prefix_buf[..coll_name_len].copy_from_slice(coll_name);
    name_prefix_buf[coll_name_len] = b' ';
    name_prefix_buf[coll_name_len + 1] = b'#';
    let prefix_len = coll_name_len + 2;

    let uri_len = coll_uri.len();
    let mut uri_buf = [0u8; 200];
    uri_buf[..uri_len].copy_from_slice(coll_uri);
    drop(collection_ref);

    // Validate shared signers/programs
    require_signer(payer, "payer")?;
    require_writable(collection, "collection")?;
    require_system_program(system_program)?;
    require_mpl_core_program(mpl_core_program)?;

    require_pda_with_bump(
        collection_authority,
        &[COLLECTION_AUTHORITY_SEED, collection.address().as_ref(), &[ca_bump]],
        program_id,
        "collection_authority",
    )?;

    let ca_bump_bytes = [ca_bump];
    let clock = Clock::get()?;
    let rent = pinocchio::sysvars::rent::Rent::get()?;
    let at_lamports = rent.try_minimum_balance(AssetToken::LEN).unwrap_or(0);

    let asset_id_str_buf = u32_to_bytes(asset_id);
    let asset_id_str = &asset_id_str_buf[..u32_str_len(asset_id)];

    // ── Process each investor ───────────────────────────────────────

    let mut settled_count = 0u32;

    for i in 0..count {
        let base = FIXED_ACCOUNTS + i * ACCOUNTS_PER_INVESTOR;
        let investment_account = &accounts[base];
        let asset_token_account = &accounts[base + 1];
        let nft = &accounts[base + 2];
        let investor = &accounts[base + 3];

        let token_index = initial_token_index.checked_add(i as u32)
            .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;

        // Validate investment
        require_owner(investment_account, program_id, "investment_account")?;
        require_writable(investment_account, "investment_account")?;
        let inv_ref = investment_account.try_borrow()?;
        validate_account_key(&inv_ref, AccountKey::Investment)?;
        let inv = unsafe { Investment::load(&inv_ref) };

        if inv.is_minted != 0 {
            pinocchio_log::log!("investment[{}]: already minted", i);
            return Err(TokenizerError::InvestmentAlreadyMinted.into());
        }
        if &inv.round != round_account.address().as_array() {
            pinocchio_log::log!("inv.round: expected {}, got {}", Pk(round_account.address().as_array()), Pk(&inv.round));
            return Err(TokenizerError::InvestmentRoundMismatch.into());
        }

        let shares = inv.shares_reserved;
        let investor_key = inv.investor;
        let inv_bump = inv.bump;
        drop(inv_ref);

        require_pda_with_bump(
            investment_account,
            &[INVESTMENT_SEED, round_account.address().as_ref(), &investor_key, &[inv_bump]],
            program_id,
            "investment_account",
        )?;

        if investor.address().as_array() != &investor_key {
            pinocchio_log::log!("inv.investor: expected {}, got {}", Pk(&investor_key), Pk(investor.address().as_array()));
            return Err(TokenizerError::InvestorMismatch.into());
        }

        // Check minted_shares won't exceed total
        let new_minted = minted_shares
            .checked_add(shares)
            .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;
        if new_minted > total_shares {
            return Err(TokenizerError::SharesExceedTotal.into());
        }

        // Validate per-investor accounts
        require_signer(nft, "nft")?;
        require_writable(nft, "nft")?;
        require_writable(asset_token_account, "asset_token_account")?;

        let at_bump = require_pda(
            asset_token_account,
            &[ASSET_TOKEN_SEED, asset_account.address().as_ref(), &token_index.to_le_bytes()],
            program_id,
            "asset_token_account",
        )?;

        // Build NFT name: "CollectionName #N"
        let index_num = token_index.saturating_add(1); // 1-indexed
        let index_str_buf = u32_to_bytes(index_num);
        let index_len = u32_str_len(index_num);
        let nft_name_len = prefix_len + index_len;
        let mut nft_name_buf = [0u8; 44]; // 34 prefix + 10 max digits
        nft_name_buf[..prefix_len].copy_from_slice(&name_prefix_buf[..prefix_len]);
        nft_name_buf[prefix_len..nft_name_len].copy_from_slice(&index_str_buf[..index_len]);

        // ── CPIs for this investor ──────────────────────────────

        let shares_str_buf = u64_to_bytes(shares);
        let shares_str = &shares_str_buf[..u64_str_len(shares)];

        mint_nft_with_plugins(
            nft,
            collection,
            collection_authority,
            payer,
            investor,
            system_program,
            mpl_core_program,
            &nft_name_buf[..nft_name_len],
            &uri_buf[..uri_len],
            shares_str,
            asset_id_str,
            &ca_bump_bytes,
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
            lamports: at_lamports,
            space: AssetToken::LEN as u64,
            owner: program_id,
        }
        .invoke_signed(&[at_signer])?;

        // 7. Initialize AssetToken state
        let mut at_data = asset_token_account.try_borrow_mut()?;
        let token = unsafe { AssetToken::load_mut(&mut at_data) };
        token.account_key = AccountKey::AssetToken as u8;
        token.version = 1;
        token.asset = asset_account.address().to_bytes();
        token.nft = nft.address().to_bytes();
        token.owner = investor.address().to_bytes();
        token.shares = shares;
        token.is_listed = 0;
        token.active_votes = 0;
        token.parent_token = [0u8; 32];
        token.last_claimed_epoch = dividend_epoch;
        token.token_index = token_index;
        token.created_at = clock.unix_timestamp;
        token.bump = at_bump;
        token.lockup_end = round_lockup_end;
        token.last_transfer_at = clock.unix_timestamp;
        token.cost_basis_per_share = round_price_per_share;
        drop(at_data);

        // 8. Mark investment as minted
        let mut inv_mut = investment_account.try_borrow_mut()?;
        let inv = unsafe { Investment::load_mut(&mut inv_mut) };
        inv.is_minted = 1;
        inv.updated_at = clock.unix_timestamp;
        drop(inv_mut);

        minted_shares = new_minted;
        settled_count = settled_count
            .checked_add(1)
            .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;
    }

    // ── Update shared state (once) ──────────────────────────────────

    // Update asset minted_shares and current_holders
    let mut asset_mut = asset_account.try_borrow_mut()?;
    let asset = unsafe { Asset::load_mut(&mut asset_mut) };
    asset.minted_shares = minted_shares;
    asset.current_holders = asset.current_holders
        .checked_add(settled_count)
        .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;
    asset.updated_at = clock.unix_timestamp;
    drop(asset_mut);

    // Update round investors_settled
    let mut round_mut = round_account.try_borrow_mut()?;
    let round = unsafe { FundraisingRound::load_mut(&mut round_mut) };
    round.investors_settled = investors_settled
        .checked_add(settled_count)
        .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;
    round.updated_at = clock.unix_timestamp;

    Ok(())
}
