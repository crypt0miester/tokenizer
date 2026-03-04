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
    state::{
        protocol_config::ProtocolConfig,
        validate_account_key, AccountKey,
        PROTOCOL_CONFIG_SEED,
    },
    utils::read_u32,
    validation::{
        require_owner, require_pda_with_bump, require_signer, require_token_program,
        require_writable,
    },
};

/// Create a governance realm for the protocol (council multisig),
/// plus a governance instance and native treasury in one shot.
/// Optionally deposits governing tokens for initial council members.
///
/// Accounts (15 base + 3*N trailing for members):
///   0.  config(w)            — also reused as governance_seed & dummy token_owner_record
///   1.  realm(w)
///   2.  realm_authority(s)   — must sign (needed for CreateGovernance CPI)
///   3.  community_mint
///   4.  community_holding(w)
///   5.  council_mint
///   6.  council_holding(w)
///   7.  realm_config(w)
///   8.  payer(s,w)
///   9.  governance_program
///  10.  system_program
///  11.  spl_token_program
///  12.  rent_sysvar
///  13.  governance(w)
///  14.  native_treasury(w)
///  --- trailing (per member) ---
///  15+3i+0.  governing_token_source(w)
///  15+3i+1.  governing_token_owner(s)
///  15+3i+2.  token_owner_record(w)
///
/// Data:
///   [0..4]       name_len (u32 LE)
///   [4..4+N]     realm_name (UTF-8)
///   [4+N..]      governance_config_data (Borsh-encoded GovernanceConfig)
///                followed by member_count (u8) as the last byte
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 15 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let config = &accounts[0];
    let realm = &accounts[1];
    let realm_authority = &accounts[2];
    let community_mint = &accounts[3];
    let community_holding = &accounts[4];
    let council_mint = &accounts[5];
    let council_holding = &accounts[6];
    let realm_config = &accounts[7];
    let payer = &accounts[8];
    let governance_program = &accounts[9];
    let system_program = &accounts[10];
    let spl_token_program = &accounts[11];
    let rent_sysvar = &accounts[12];
    let governance = &accounts[13];
    let native_treasury = &accounts[14];

    // Validate config + require_operator
    require_owner(config, program_id, "config")?;
    require_writable(config, "config")?;
    let config_ref = config.try_borrow()?;
    validate_account_key(&config_ref, AccountKey::ProtocolConfig)?;
    let config_data = unsafe { ProtocolConfig::load(&config_ref) };
    require_pda_with_bump(config, &[PROTOCOL_CONFIG_SEED, &[config_data.bump]], program_id, "config")?;
    config_data.require_operator(realm_authority)?;

    if config_data.realm != [0u8; 32] {
        return Err(TokenizerError::RealmAlreadySet.into());
    }
    drop(config_ref);

    require_signer(realm_authority, "realm_authority")?;
    require_signer(payer, "payer")?;
    require_writable(payer, "payer")?;
    require_writable(realm, "realm")?;
    require_writable(community_holding, "community_holding")?;
    require_writable(council_holding, "council_holding")?;
    require_writable(realm_config, "realm_config")?;
    require_writable(governance, "governance")?;
    require_writable(native_treasury, "native_treasury")?;
    require_token_program(spl_token_program)?;

    // Parse realm name
    let name_len = read_u32(data, 0, "name_len")? as usize;
    if name_len == 0 || data.len() < 4 + name_len {
        return Err(TokenizerError::InstructionDataTooShort.into());
    }
    let realm_name = &data[4..4 + name_len];

    // Parse governance config + member_count (last byte)
    let after_name = &data[4 + name_len..];
    if after_name.is_empty() {
        return Err(TokenizerError::InstructionDataTooShort.into());
    }
    let governance_config_data = &after_name[..after_name.len() - 1];
    let member_count = after_name[after_name.len() - 1] as usize;

    if governance_config_data.is_empty() {
        return Err(TokenizerError::InstructionDataTooShort.into());
    }

    // At least one council member required — operator transfers to governance,
    // so without members nobody can create proposals and the protocol locks.
    if member_count == 0 {
        return Err(TokenizerError::InvalidGovernanceConfig.into());
    }

    // Validate we have enough trailing accounts for members
    let required_accounts = 15 + member_count * 3;
    if accounts.len() < required_accounts {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    // Reject duplicate council member wallets
    for i in 0..member_count {
        for j in (i + 1)..member_count {
            if accounts[15 + i * 3 + 1].address() == accounts[15 + j * 3 + 1].address() {
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
        voter_weight_addin: None,
        max_voter_weight_addin: None,
        name: realm_name,
        config_args: RealmConfigArgs {
            use_council_mint: true,
            min_community_weight_to_create_governance: u64::MAX,
            community_vote_threshold: VoteThreshold::SupplyFraction(10_000_000_000),
            community_token_config: GovTokenConfig {
                use_voter_weight_addin: false,
                use_max_voter_weight_addin: false,
                token_type: GovTokenType::Dormant,
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
    // realm_authority is the governance_authority (operator);
    // config is reused as both governance_seed and token_owner_record
    // (SPL Gov v3 skips token_owner_record validation when governance_authority == realm.authority)
    CreateGovernance {
        governance_program,
        realm,
        governance,
        governance_seed: config,
        token_owner_record: config,
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
        let base = 15 + i * 3;
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

    // Store realm + governance pubkeys and transfer operator to governance.
    // From this point all protocol-level actions (pause, register, update config)
    // require a governance proposal to execute.
    let mut config_mut = config.try_borrow_mut()?;
    let cd = unsafe { ProtocolConfig::load_mut(&mut config_mut) };
    cd.realm = realm.address().to_bytes();
    cd.governance = governance.address().to_bytes();
    cd.operator = governance.address().to_bytes();

    Ok(())
}
