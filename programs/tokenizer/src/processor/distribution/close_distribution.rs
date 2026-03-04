use pinocchio::{
    cpi::Seed,
    error::ProgramError,
    AccountView,
    Address,
    ProgramResult,
};

use crate::{
    error::TokenizerError,
    utils::{read_token_balance, close_token_account_signed, spl_transfer_signed, Pk},
    state::{
        asset::Asset,
        dividend_distribution::DividendDistribution,
        organization::Organization,
        validate_account_key, AccountKey,
        ASSET_SEED, DISTRIBUTION_ESCROW_SEED, DIVIDEND_DISTRIBUTION_SEED,
    },
    validation::{
        close_account, require_owner, require_pda_with_bump, require_rent_destination,
        require_signer, require_token_account, require_token_program, require_writable,
    },
};

/// Close a fully-claimed dividend distribution.
///
/// Permissionless: anyone may close once all shares have been claimed.
/// Sweeps any rounding dust from the escrow, closes the escrow token account,
/// and closes the distribution PDA. Rent lamports are returned to payer.
///
/// Accounts:
///   0. distribution_account (writable) — DividendDistribution PDA
///   1. escrow (writable)               — Escrow token account
///   2. asset                           — Parent Asset (read)
///   3. org_account                     — Organization (read)
///   4. dust_recipient (writable)       — Token account to receive rounding dust
///   5. payer (signer, writable)        — Receives rent lamports
///   6. token_program
///   7. rent_destination (writable)    — Original rent payer
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    _data: &[u8],
) -> ProgramResult {
    let [
        distribution_account,
        escrow,
        asset_account,
        org_account,
        dust_recipient,
        payer,
        token_program,
        rent_destination,
    ] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate distribution
    require_owner(distribution_account, program_id, "distribution_account")?;
    require_writable(distribution_account, "distribution_account")?;
    let dist_ref = distribution_account.try_borrow()?;
    validate_account_key(&dist_ref, AccountKey::DividendDistribution)?;
    let dist = unsafe { DividendDistribution::load(&dist_ref) };

    let dist_asset = dist.asset;
    let dist_epoch = dist.epoch;
    let dist_bump = dist.bump;
    let dist_escrow_bump = dist.escrow_bump;
    let dist_mint = dist.accepted_mint;
    let total_shares = dist.total_shares;
    let shares_claimed = dist.shares_claimed;
    let dist_rent_payer = dist.rent_payer;

    if &dist.escrow != escrow.address().as_array() {
        pinocchio_log::log!("dist.escrow: expected {}, got {}", Pk(&dist.escrow), Pk(escrow.address().as_array()));
        return Err(TokenizerError::EscrowMismatch.into());
    }

    // All shares must be claimed before closing
    if shares_claimed != total_shares {
        pinocchio_log::log!("shares_claimed: {}/{}", shares_claimed, total_shares);
        return Err(TokenizerError::DistributionNotFullyClaimed.into());
    }

    drop(dist_ref);

    // Validate distribution PDA
    let epoch_bytes = dist_epoch.to_le_bytes();
    require_pda_with_bump(
        distribution_account,
        &[DIVIDEND_DISTRIBUTION_SEED, &dist_asset, &epoch_bytes, &[dist_bump]],
        program_id,
        "distribution_account",
    )?;

    // Validate asset
    require_owner(asset_account, program_id, "asset_account")?;
    if asset_account.address().as_array() != &dist_asset {
        pinocchio_log::log!("dist.asset: expected {}, got {}", Pk(&dist_asset), Pk(asset_account.address().as_array()));
        return Err(TokenizerError::DistributionAssetMismatch.into());
    }
    let asset_ref = asset_account.try_borrow()?;
    validate_account_key(&asset_ref, AccountKey::Asset)?;
    let asset = unsafe { Asset::load(&asset_ref) };
    let org_key = asset.organization;
    let asset_id = asset.id;
    let asset_bump = asset.bump;
    drop(asset_ref);

    require_pda_with_bump(
        asset_account,
        &[ASSET_SEED, &org_key, &asset_id.to_le_bytes(), &[asset_bump]],
        program_id,
        "asset_account",
    )?;

    // Validate org_account matches asset.organization
    require_owner(org_account, program_id, "org_account")?;
    let org_ref = org_account.try_borrow()?;
    validate_account_key(&org_ref, AccountKey::Organization)?;
    let org = unsafe { Organization::load(&org_ref) };
    if org_account.address().as_array() != &org_key {
        pinocchio_log::log!("org_account: expected {}, got {}", Pk(&org_key), Pk(org_account.address().as_array()));
        return Err(TokenizerError::TokenAssetMismatch.into());
    }
    let org_authority = org.authority;
    drop(org_ref);

    // Validate escrow PDA
    require_pda_with_bump(
        escrow,
        &[DISTRIBUTION_ESCROW_SEED, distribution_account.address().as_ref(), &[dist_escrow_bump]],
        program_id,
        "escrow",
    )?;

    require_signer(payer, "payer")?;
    require_writable(payer, "payer")?;
    require_writable(escrow, "escrow")?;
    require_writable(dust_recipient, "dust_recipient")?;
    require_token_program(token_program)?;
    require_rent_destination(rent_destination, &dist_rent_payer)?;

    // Validate dust_recipient is a token account for the correct mint owned by org authority
    require_token_account(dust_recipient, &dist_mint, &org_authority)?;

    // Distribution PDA seeds for signing
    let dist_bump_bytes = [dist_bump];
    let dist_seeds = [
        Seed::from(DIVIDEND_DISTRIBUTION_SEED),
        Seed::from(dist_asset.as_ref()),
        Seed::from(epoch_bytes.as_ref()),
        Seed::from(&dist_bump_bytes),
    ];

    // Sweep any rounding dust from escrow
    let escrow_data = escrow.try_borrow()?;
    let escrow_balance = read_token_balance(&escrow_data)?;
    drop(escrow_data);

    if escrow_balance > 0 {
        spl_transfer_signed(
            escrow, dust_recipient, distribution_account,
            escrow_balance, &dist_mint, &dist_seeds,
        )?;
    }

    // Close escrow token account → rent to original payer
    close_token_account_signed(escrow, rent_destination, distribution_account, &dist_seeds)?;

    // Decrement asset.open_distributions
    require_writable(asset_account, "asset_account")?;
    let mut asset_mut = asset_account.try_borrow_mut()?;
    let asset_w = unsafe { Asset::load_mut(&mut asset_mut) };
    asset_w.open_distributions = asset_w.open_distributions.saturating_sub(1);
    drop(asset_mut);

    // Close distribution PDA → rent to original payer
    close_account(distribution_account, rent_destination)?;

    Ok(())
}
