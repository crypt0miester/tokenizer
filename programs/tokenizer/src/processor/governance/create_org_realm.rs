use pinocchio::{
    error::ProgramError,
    AccountView,
    Address,
    ProgramResult,
};

use p_gov::instructions::{
    CreateGovernance, CreateNativeTreasury, DepositGoverningTokens,
    CreateRealm, GovTokenConfig, GovTokenType, RealmConfigArgs, VoteThreshold,
};

use crate::{
    error::TokenizerError,
    utils::{read_u32, Pk},
    state::{
        organization::Organization,
        protocol_config::ProtocolConfig,
        validate_account_key, AccountKey,
        ORGANIZATION_SEED, PROTOCOL_CONFIG_SEED,
    },
    validation::{
        require_owner, require_pda_with_bump, require_signer, require_token_program,
        require_writable,
    },
};

/// Create a governance realm for an organization (council + investor voting),
/// plus a governance instance and native treasury in one shot.
/// Optionally deposits governing tokens for initial council members.
///
/// Accounts (19 base + 3*N trailing for members):
///   0.  config
///   1.  org_account(w)
///   2.  realm(w)
///   3.  realm_authority(s)
///   4.  council_mint
///   5.  council_holding(w)
///   6.  community_mint
///   7.  community_holding(w)
///   8.  realm_config(w)
///   9.  authority(s)              — org_authority OR operator
///   10. payer(s,w)
///   11. governance_program
///   12. system_program
///   13. spl_token_program
///   14. rent_sysvar
///   15. voter_weight_addin        — tokenizer program id
///   16. max_voter_weight_addin    — tokenizer program id
///   17. governance(w)
///   18. native_treasury(w)
///   --- trailing (per member) ---
///   19+3i+0. governing_token_source(w)
///   19+3i+1. governing_token_owner(s)
///   19+3i+2. token_owner_record(w)
///
/// Data:
///   [0..4]         name_len (u32 LE)
///   [4..4+N]       realm_name (UTF-8)
///   [4+N..]        governance_config_data (Borsh-encoded GovernanceConfig)
///                  followed by member_count (u8) as the last byte
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 19 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let config = &accounts[0];
    let org_account = &accounts[1];
    let realm = &accounts[2];
    let realm_authority = &accounts[3];
    let council_mint = &accounts[4];
    let council_holding = &accounts[5];
    let community_mint = &accounts[6];
    let community_holding = &accounts[7];
    let realm_config = &accounts[8];
    let authority = &accounts[9];
    let payer = &accounts[10];
    let governance_program = &accounts[11];
    let system_program = &accounts[12];
    let spl_token_program = &accounts[13];
    let rent_sysvar = &accounts[14];
    let voter_weight_addin = &accounts[15];
    let max_voter_weight_addin = &accounts[16];
    let governance = &accounts[17];
    let native_treasury = &accounts[18];

    // Validate config for operator check
    require_owner(config, program_id, "config")?;
    let config_ref = config.try_borrow()?;
    validate_account_key(&config_ref, AccountKey::ProtocolConfig)?;
    let config_data = unsafe { ProtocolConfig::load(&config_ref) };
    require_pda_with_bump(config, &[PROTOCOL_CONFIG_SEED, &[config_data.bump]], program_id, "config")?;

    // Validate org
    require_owner(org_account, program_id, "org_account")?;
    require_writable(org_account, "org_account")?;
    let org_ref = org_account.try_borrow()?;
    validate_account_key(&org_ref, AccountKey::Organization)?;
    let org = unsafe { Organization::load(&org_ref) };

    if !org.is_active() {
        return Err(TokenizerError::OrganizationNotActive.into());
    }
    if org.realm != [0u8; 32] {
        return Err(TokenizerError::RealmAlreadySet.into());
    }

    // Authority check: org authority OR protocol operator
    require_signer(authority, "authority")?;
    let is_org_authority = authority.address().as_array() == &org.authority;
    let is_operator = authority.address().as_array() == &config_data.operator;
    if !is_org_authority && !is_operator {
        pinocchio_log::log!("unauthorized: signer {} is neither org_authority nor operator", Pk(authority.address().as_array()));
        return Err(TokenizerError::Unauthorized.into());
    }

    let org_id = org.id;
    let org_bump = org.bump;
    drop(org_ref);
    drop(config_ref);

    require_signer(realm_authority, "realm_authority")?;
    require_signer(payer, "payer")?;
    require_writable(payer, "payer")?;
    require_writable(realm, "realm")?;
    require_writable(council_holding, "council_holding")?;
    require_writable(community_holding, "community_holding")?;
    require_writable(realm_config, "realm_config")?;
    require_writable(governance, "governance")?;
    require_writable(native_treasury, "native_treasury")?;
    require_token_program(spl_token_program)?;

    require_pda_with_bump(
        org_account,
        &[ORGANIZATION_SEED, &org_id.to_le_bytes(), &[org_bump]],
        program_id,
        "org_account",
    )?;

    // Voter weight addins must be the tokenizer program itself
    if voter_weight_addin.address() != program_id {
        pinocchio_log::log!("voter_weight_addin must be the tokenizer program");
        return Err(TokenizerError::InvalidGovernanceConfig.into());
    }
    if max_voter_weight_addin.address() != program_id {
        pinocchio_log::log!("max_voter_weight_addin must be the tokenizer program");
        return Err(TokenizerError::InvalidGovernanceConfig.into());
    }

    // Parse realm name
    let name_len = read_u32(data, 0, "name_len")? as usize;
    if name_len == 0 || data.len() < 4 + name_len {
        return Err(TokenizerError::InstructionDataTooShort.into());
    }
    let realm_name = &data[4..4 + name_len];

    // Parse governance config + member_count
    let after_name = &data[4 + name_len..];
    if after_name.is_empty() {
        return Err(TokenizerError::InstructionDataTooShort.into());
    }
    // The last byte is member_count, everything before it is governance_config_data
    let governance_config_data = &after_name[..after_name.len() - 1];
    let member_count = after_name[after_name.len() - 1] as usize;

    if governance_config_data.is_empty() {
        return Err(TokenizerError::InstructionDataTooShort.into());
    }

    // Org governance must have communityVoteThreshold = Disabled (council-only).
    // First byte of GovernanceConfig = VoteThreshold discriminator: 2 = Disabled.
    if governance_config_data[0] != 2 {
        pinocchio_log::log!("org governance must have communityVoteThreshold=Disabled (council-only)");
        return Err(TokenizerError::InvalidGovernanceConfig.into());
    }

    // Validate we have enough trailing accounts for members
    let required_accounts = 19 + member_count * 3;
    if accounts.len() < required_accounts {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    // Reject duplicate council member wallets
    for i in 0..member_count {
        for j in (i + 1)..member_count {
            if accounts[19 + i * 3 + 1].address() == accounts[19 + j * 3 + 1].address() {
                return Err(TokenizerError::DuplicateCouncilMember.into());
            }
        }
    }

    // 1. CreateRealm CPI
    CreateRealm {
        governance_program,
        realm,
        realm_authority,
        community_mint,
        payer,
        system_program,
        spl_token_program,
        rent_sysvar,
        council_mint,
        community_token_holding: community_holding,
        council_token_holding: council_holding,
        realm_config,
        voter_weight_addin: Some(voter_weight_addin),
        max_voter_weight_addin: Some(max_voter_weight_addin),
        name: realm_name,
        config_args: RealmConfigArgs {
            use_council_mint: true,
            min_community_weight_to_create_governance: 1,
            community_vote_threshold: VoteThreshold::SupplyFraction(10_000_000_000),
            community_token_config: GovTokenConfig {
                use_voter_weight_addin: true,
                use_max_voter_weight_addin: true,
                token_type: GovTokenType::Liquid,
            },
            council_token_config: GovTokenConfig {
                use_voter_weight_addin: false,
                use_max_voter_weight_addin: false,
                token_type: GovTokenType::Membership,
            },
        },
    }
    .invoke()?;

    // 2. CreateGovernance CPI
    // realm_authority is the governance_authority;
    // org_account is reused as both governance_seed and token_owner_record
    // (SPL Gov v3 skips token_owner_record validation when governance_authority == realm.authority)
    CreateGovernance {
        governance_program,
        realm,
        governance,
        governance_seed: org_account,
        token_owner_record: org_account,
        payer,
        system_program,
        governance_authority: realm_authority,
        realm_config,
        voter_weight_record: None,
        governance_config_data,
    }
    .invoke()?;

    // 3. CreateNativeTreasury CPI
    CreateNativeTreasury {
        governance_program,
        governance,
        native_treasury,
        payer,
        system_program,
    }
    .invoke()?;

    // 4. Deposit governing tokens for initial council members
    for i in 0..member_count {
        let base = 19 + i * 3;
        let governing_token_source = &accounts[base];
        let governing_token_owner = &accounts[base + 1];
        let token_owner_record = &accounts[base + 2];

        DepositGoverningTokens {
            governance_program,
            realm,
            governing_token_holding: council_holding,
            governing_token_source,
            governing_token_owner,
            governing_token_transfer_authority: governing_token_owner,
            token_owner_record,
            payer,
            system_program,
            spl_token_program,
            realm_config,
            amount: 1,
        }
        .invoke()?;
    }

    // Store realm in org
    let mut org_mut = org_account.try_borrow_mut()?;
    let org = unsafe { Organization::load_mut(&mut org_mut) };
    org.realm = realm.address().to_bytes();

    Ok(())
}
