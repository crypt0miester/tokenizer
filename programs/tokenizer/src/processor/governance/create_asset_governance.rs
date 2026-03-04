use pinocchio::{
    error::ProgramError,
    AccountView,
    Address,
    ProgramResult,
};

use p_gov::instructions::{CreateGovernance, CreateNativeTreasury};

use crate::{
    error::TokenizerError,
    state::{
        asset::Asset,
        organization::Organization,
        protocol_config::ProtocolConfig,
        validate_account_key, AccountKey,
        ASSET_SEED, ORGANIZATION_SEED, PROTOCOL_CONFIG_SEED,
    },
    utils::read_u64,
    validation::{
        require_owner, require_pda_with_bump, require_signer, require_writable,
    },
};

/// Parse the Borsh-encoded GovernanceConfig to extract `minCommunityWeightToCreateProposal`.
///
/// GovernanceConfig Borsh layout:
///   communityVoteThreshold: VoteThreshold (enum — 1 byte disc + optional 1 byte value)
///   minCommunityWeightToCreateProposal: u64 (8 bytes, LE)
///   ...remaining fields...
/// Size of a Borsh-encoded VoteThreshold: Disabled = 1 byte, others = 2 bytes.
fn vote_threshold_size(disc: u8) -> usize {
    if disc == 2 { 1 } else { 2 }
}

/// Walk the GovernanceConfig Borsh layout to councilVetoVoteThreshold and
/// verify it is not Disabled. Council must retain veto power over community proposals.
fn require_council_veto_enabled(data: &[u8]) -> Result<(), ProgramError> {
    let mut o = 0;
    // communityVoteThreshold
    if o >= data.len() { return Err(TokenizerError::InstructionDataTooShort.into()); }
    o += vote_threshold_size(data[o]);
    // minCommunityWeightToCreateProposal (u64) + minTransactionHoldUpTime (u32)
    // + votingBaseTime (u32) + communityVoteTipping (u8)
    o += 8 + 4 + 4 + 1;
    // councilVoteThreshold
    if o >= data.len() { return Err(TokenizerError::InstructionDataTooShort.into()); }
    o += vote_threshold_size(data[o]);
    // councilVetoVoteThreshold
    if o >= data.len() { return Err(TokenizerError::InstructionDataTooShort.into()); }
    if data[o] == 2 {
        pinocchio_log::log!("asset governance must have councilVetoVoteThreshold enabled");
        return Err(TokenizerError::InvalidGovernanceConfig.into());
    }
    Ok(())
}

fn parse_min_community_weight(data: &[u8]) -> Result<u64, ProgramError> {
    if data.is_empty() {
        return Err(TokenizerError::InstructionDataTooShort.into());
    }
    // VoteThreshold is a Borsh enum:
    //   0 (YesVotePercentage) = 1 disc + 1 value = 2 bytes
    //   1 (QuorumPercentage)  = 1 disc + 1 value = 2 bytes
    //   2 (Disabled)          = 1 disc            = 1 byte
    let threshold_len = if data[0] == 2 { 1 } else { 2 };
    let offset = threshold_len;
    let val = read_u64(data, offset, "min_community_weight")?;
    Ok(val)
}

/// Create a governance instance for an asset (investor voting on proposals)
/// and its native treasury in one shot.
///
/// Validates that the caller is authorized (org authority or operator) and
/// that the governance config's `minCommunityWeightToCreateProposal` meets
/// the protocol's `min_proposal_weight_bps` threshold relative to the
/// asset's `total_shares`.
///
/// Accounts (13 or 14):
///   0.  config
///   1.  organization
///   2.  asset
///   3.  authority(s)             
///   4.  realm
///   5.  governance(w)
///   6.  token_owner_record
///   7.  governance_authority(s)
///   8.  realm_config
///   9.  payer(s,w)
///  10.  governance_program
///  11.  system_program
///  12.  native_treasury(w)
///  13.  voter_weight_record       — optional
///
/// Data: [0..N] GovernanceConfig bytes (Borsh, ~39 bytes)
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 13 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let config = &accounts[0];
    let org_account = &accounts[1];
    let asset_account = &accounts[2];
    let authority = &accounts[3];
    let realm = &accounts[4];
    let governance = &accounts[5];
    let token_owner_record = &accounts[6];
    let governance_authority = &accounts[7];
    let realm_config = &accounts[8];
    let payer = &accounts[9];
    let governance_program = &accounts[10];
    let system_program = &accounts[11];
    let native_treasury = &accounts[12];

    if data.is_empty() {
        return Err(TokenizerError::InstructionDataTooShort.into());
    }

    // Validate protocol config 
    require_owner(config, program_id, "config")?;
    let config_ref = config.try_borrow()?;
    validate_account_key(&config_ref, AccountKey::ProtocolConfig)?;
    let cfg = unsafe { ProtocolConfig::load(&config_ref) };
    require_pda_with_bump(config, &[PROTOCOL_CONFIG_SEED, &[cfg.bump]], program_id, "config")?;

    let min_bps = cfg.min_proposal_weight_bps;
    let is_operator = authority.address().as_array() == &cfg.operator;
    drop(config_ref);

    // Validate organization
    require_owner(org_account, program_id, "org_account")?;
    let org_ref = org_account.try_borrow()?;
    validate_account_key(&org_ref, AccountKey::Organization)?;
    let org = unsafe { Organization::load(&org_ref) };

    if !org.is_active() {
        return Err(TokenizerError::OrganizationNotActive.into());
    }
    // The realm must be set on the org (created via create_org_realm)
    if org.realm == [0u8; 32] {
        return Err(TokenizerError::RealmNotSet.into());
    }
    // Verify the provided realm matches the org's realm
    if realm.address().as_array() != &org.realm {
        return Err(TokenizerError::InvalidRealmAuthority.into());
    }

    let org_id = org.id;
    let org_bump = org.bump;
    let is_org_authority = authority.address().as_array() == &org.authority;
    drop(org_ref);

    require_pda_with_bump(
        org_account,
        &[ORGANIZATION_SEED, &org_id.to_le_bytes(), &[org_bump]],
        program_id,
        "org_account",
    )?;

    // Validate authority───
    require_signer(authority, "authority")?;
    if !is_org_authority && !is_operator {
        return Err(TokenizerError::Unauthorized.into());
    }

    // Validate asset───
    require_owner(asset_account, program_id, "asset_account")?;
    require_writable(asset_account, "asset_account")?;
    let asset_ref = asset_account.try_borrow()?;
    validate_account_key(&asset_ref, AccountKey::Asset)?;
    let asset = unsafe { Asset::load(&asset_ref) };

    // Asset must belong to this org
    if &asset.organization != org_account.address().as_array() {
        return Err(TokenizerError::TokenAssetMismatch.into());
    }

    let total_shares = asset.total_shares;
    let asset_id = asset.id;
    let asset_bump = asset.bump;
    drop(asset_ref);

    require_pda_with_bump(
        asset_account,
        &[ASSET_SEED, org_account.address().as_ref(), &asset_id.to_le_bytes(), &[asset_bump]],
        program_id,
        "asset_account",
    )?;

    // Validate governance config structure 
    // Asset governance must have communityVoteThreshold ENABLED (not Disabled).
    // Shareholders must be able to vote on asset-level proposals.
    if data[0] == 2 {
        pinocchio_log::log!("asset governance must have communityVoteThreshold enabled (not Disabled)");
        return Err(TokenizerError::InvalidGovernanceConfig.into());
    }
    require_council_veto_enabled(data)?;

    // Validate governance config threshold 
    if min_bps > 0 {
        let min_weight = (total_shares as u128)
            .checked_mul(min_bps as u128)
            .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())?
            / 10_000u128;

        let provided_weight = parse_min_community_weight(data)?;

        if (provided_weight as u128) < min_weight {
            pinocchio_log::log!(
                "min_community_weight_to_create_proposal {} < required {} ({}bps of {})",
                provided_weight, min_weight as u64, min_bps, total_shares
            );
            return Err(TokenizerError::MinProposalWeightTooLow.into());
        }
    }

    // Validation done — pass through to SPL Governance 

    require_writable(governance, "governance")?;
    require_signer(payer, "payer")?;
    require_writable(payer, "payer")?;
    require_writable(native_treasury, "native_treasury")?;

    CreateGovernance {
        governance_program,
        realm,
        governance,
        governance_seed: asset_account,
        token_owner_record,
        payer,
        system_program,
        governance_authority,
        realm_config,
        voter_weight_record: if accounts.len() >= 14 {
            Some(&accounts[13])
        } else {
            None
        },
        governance_config_data: data,
    }
    .invoke()?;

    CreateNativeTreasury {
        governance_program,
        governance,
        native_treasury,
        payer,
        system_program,
    }
    .invoke()?;

    // Store native treasury address on the asset for treasury routing
    let mut asset_mut = asset_account.try_borrow_mut()?;
    let asset = unsafe { Asset::load_mut(&mut asset_mut) };
    asset.native_treasury = native_treasury.address().to_bytes();

    Ok(())
}
