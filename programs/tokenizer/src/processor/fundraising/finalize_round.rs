use pinocchio::{
    cpi::Seed,
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    AccountView,
    Address,
    ProgramResult,
};
use crate::{
    error::TokenizerError,
    state::{
        asset::Asset,
        fundraising_round::FundraisingRound,
        protocol_config::ProtocolConfig,
        validate_account_key, AccountKey, AssetStatus, RoundStatus,
        ASSET_SEED, FUNDRAISING_ROUND_SEED, PROTOCOL_CONFIG_SEED,
    },
    utils::{spl_transfer_signed, Pk},
    validation::{
        create_ata_if_needed, require_ata_program, require_owner, require_pda_with_bump,
        require_signer, require_system_program, require_token_program, require_writable,
    },
};

/// Finalize a fundraising round after end_time.
/// Permissionless — anyone can call this.
///
/// If min_raise is met: status → Succeeded, funds transferred to org + fee treasury.
/// If min_raise not met: status → Failed, funds remain in escrow for refunds.
///
/// Accounts:
///   0.  config            — ProtocolConfig (read)
///   1.  asset_account     — Asset (writable)
///   2.  round_account     — FundraisingRound (writable)
///   3.  escrow            — Escrow token account (writable)
///   4.  fee_treasury_token — Protocol fee treasury token account (writable)
///   5.  org_treasury_token — Organization receiving token account (writable)
///   6.  treasury_wallet   — Wallet that owns org_treasury_token (must match round.treasury)
///   7.  payer             — Signer, funds ATA creation
///   8.  accepted_mint
///   9.  system_program
///   10. token_program
///   11. ata_program
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    _data: &[u8],
) -> ProgramResult {
    let [
        config,
        asset_account,
        round_account,
        escrow,
        fee_treasury_token,
        org_treasury_token,
        treasury_wallet,
        payer,
        accepted_mint,
        system_program,
        token_program,
        ata_program,
    ] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Validate protocol
    require_owner(config, program_id, "config")?;
    let config_ref = config.try_borrow()?;
    validate_account_key(&config_ref, AccountKey::ProtocolConfig)?;
    let config_data = unsafe { ProtocolConfig::load(&config_ref) };
    // Note: finalization allowed even when paused (to protect investors)
    let fee_bps = config_data.fee_bps;
    let fee_treasury = config_data.fee_treasury;
    let config_bump = config_data.bump;
    drop(config_ref);
    require_pda_with_bump(config, &[PROTOCOL_CONFIG_SEED, &[config_bump]], program_id, "config")?;

    // Validate round
    require_owner(round_account, program_id, "round_account")?;
    require_writable(round_account, "round_account")?;
    let round_ref = round_account.try_borrow()?;
    validate_account_key(&round_ref, AccountKey::FundraisingRound)?;
    let round = unsafe { FundraisingRound::load(&round_ref) };

    if round.status() != RoundStatus::Active {
        pinocchio_log::log!("round.status: {}", round.status);
        return Err(TokenizerError::RoundNotActive.into());
    }

    // Must be past end_time
    let clock = Clock::get()?;
    if clock.unix_timestamp <= round.end_time {
        pinocchio_log::log!("round not ended: now={}, end={}", clock.unix_timestamp, round.end_time);
        return Err(TokenizerError::RoundNotEnded.into());
    }

    // Validate round PDA
    let round_index = round.round_index;
    let asset_key = round.asset;
    let total_raised = round.total_raised;
    let min_raise = round.min_raise;
    let round_bump = round.bump;

    // Validate escrow matches
    if &round.escrow != escrow.address().as_array() {
        pinocchio_log::log!("round.escrow: expected {}, got {}", Pk(&round.escrow), Pk(escrow.address().as_array()));
        return Err(TokenizerError::EscrowMismatch.into());
    }
    let round_mint = round.accepted_mint;
    let round_price_per_share = round.price_per_share;
    let round_shares_sold = round.shares_sold;
    let treasury = round.treasury;
    drop(round_ref);

    // Validate accepted_mint matches round
    if accepted_mint.address().as_array() != &round_mint {
        pinocchio_log::log!("accepted_mint: expected {}, got {}", Pk(&round_mint), Pk(accepted_mint.address().as_array()));
        return Err(TokenizerError::InvalidMint.into());
    }

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
    let asset_id = asset.id;
    let org_key = asset.organization;
    let asset_bump = asset.bump;
    drop(asset_ref);

    // Verify asset_account address matches the key stored in the round
    if asset_account.address().as_array() != &asset_key {
        pinocchio_log::log!("round.asset: expected {}, got {}", Pk(&asset_key), Pk(asset_account.address().as_array()));
        return Err(TokenizerError::RoundAssetMismatch.into());
    }

    require_pda_with_bump(
        asset_account,
        &[ASSET_SEED, &org_key, &asset_id.to_le_bytes(), &[asset_bump]],
        program_id,
        "asset_account",
    )?;

    require_writable(escrow, "escrow")?;
    require_signer(payer, "payer")?;
    require_system_program(system_program)?;
    require_token_program(token_program)?;
    require_ata_program(ata_program)?;

    // Determine success or failure
    let succeeded = total_raised >= min_raise;

    if succeeded {
        // Transfer funds: calculate fee, then distribute
        require_writable(fee_treasury_token, "fee_treasury_token")?;
        require_writable(org_treasury_token, "org_treasury_token")?;

        // Validate fee treasury matches protocol config
        if fee_treasury_token.address().as_array() != &fee_treasury {
            pinocchio_log::log!("fee_treasury_token: expected {}, got {}", Pk(&fee_treasury), Pk(fee_treasury_token.address().as_array()));
            return Err(TokenizerError::InvalidFeeTreasury.into());
        }

        // Validate treasury_wallet matches round.treasury
        if treasury_wallet.address().as_array() != &treasury {
            pinocchio_log::log!("treasury_wallet: expected {}, got {}", Pk(&treasury), Pk(treasury_wallet.address().as_array()));
            return Err(TokenizerError::InvalidTreasuryWallet.into());
        }

        // Create org treasury ATA if needed
        create_ata_if_needed(payer, org_treasury_token, treasury_wallet, accepted_mint, system_program, token_program)?;

        let fee_amount = (total_raised as u128)
            .checked_mul(fee_bps as u128)
            .and_then(|v| v.checked_div(10_000))
            .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())? as u64;

        let org_amount = total_raised
            .checked_sub(fee_amount)
            .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?;

        // Build round PDA seeds for escrow transfers
        let round_index_bytes = round_index.to_le_bytes();
        let round_bump_bytes = [round_bump];

        // Transfer fee to protocol treasury
        if fee_amount > 0 {
            let seeds = [
                Seed::from(FUNDRAISING_ROUND_SEED),
                Seed::from(asset_key.as_ref()),
                Seed::from(round_index_bytes.as_ref()),
                Seed::from(&round_bump_bytes),
            ];
            spl_transfer_signed(escrow, fee_treasury_token, round_account, fee_amount, &round_mint, &seeds)?;
        }

        // Transfer remaining to organization
        if org_amount > 0 {
            let seeds = [
                Seed::from(FUNDRAISING_ROUND_SEED),
                Seed::from(asset_key.as_ref()),
                Seed::from(round_index_bytes.as_ref()),
                Seed::from(&round_bump_bytes),
            ];
            spl_transfer_signed(escrow, org_treasury_token, round_account, org_amount, &round_mint, &seeds)?;
        }
    }

    // Update round status
    let mut round_mut = round_account.try_borrow_mut()?;
    let round = unsafe { FundraisingRound::load_mut(&mut round_mut) };
    round.status = if succeeded {
        RoundStatus::Succeeded as u8
    } else {
        RoundStatus::Failed as u8
    };
    round.updated_at = clock.unix_timestamp;
    drop(round_mut);

    // Update asset status
    let mut asset_mut = asset_account.try_borrow_mut()?;
    let asset = unsafe { Asset::load_mut(&mut asset_mut) };
    if succeeded {
        asset.status = AssetStatus::Active as u8;
        // Price guard (Decision #6): only update price_per_share if the round
        // is material (>=5% of minted shares), raises the price, and stays
        // within a 3× cap to prevent manipulation via tiny or extreme rounds.
        let minted = asset.minted_shares;
        let is_material = (round_shares_sold as u128) * 100 >= (minted as u128) * 5;
        let within_cap = round_price_per_share <= asset.price_per_share.saturating_mul(3);
        if is_material && round_price_per_share > asset.price_per_share && within_cap {
            asset.price_per_share = round_price_per_share;
        }
    } else {
        // Revert to Draft on failure so a new round can be created
        asset.status = AssetStatus::Draft as u8;
    }
    asset.updated_at = clock.unix_timestamp;

    Ok(())
}
