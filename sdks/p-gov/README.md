# p-gov

Pinocchio CPI wrapper for [SPL Governance](https://github.com/solana-labs/solana-program-library/tree/master/governance).

This is **not** a general-purpose SPL Governance SDK. It only wraps the subset of instructions and state readers that the tokenizer program needs for its governance integration. If you need full coverage, use the official [spl-governance](https://crates.io/crates/spl-governance) crate instead.

## What's included

### Instructions

| Instruction | Discriminant | Purpose |
|---|---|---|
| CreateRealm | 0x00 | Create a governance realm with community + optional council mint |
| CreateGovernance | 0x04 | Create a governance instance for a realm |
| CreateNativeTreasury | 0x19 | Create a native SOL treasury for a governance |
| DepositGoverningTokens | 0x01 | Deposit tokens into a realm to get voting power |

All instructions expose `invoke()` and `invoke_signed(&[Signer])` for CPI.

#### Configuration types

- **RealmConfigArgs** — community vote threshold, min weight to create governance, token configs
- **GovTokenConfig** — voter weight addin flags, token type (Liquid / Membership / Dormant)
- **VoteThreshold** — SupplyFraction(u64) or Disabled

### State readers

Zero-copy readers that extract fields directly from raw account data at known offsets. No deserialization or allocation.

| Type | Description |
|---|---|
| RealmV2 | `community_mint()`, `authority()` — handles variable-length RealmConfig |
| GovernanceV2 | `realm()`, `governance_seed()` |
| ProposalV2 | `governance()`, `governing_token_mint()`, `state()`, `token_owner_record()` |
| TokenOwnerRecordV2 | `realm()`, `governing_token_mint()`, `governing_token_owner()` |

Each reader has a `check_account_type(data) -> bool` that accepts both V1 and V2 discriminators.

### Other

- **ProposalState** enum — Draft, SigningOff, Voting, Succeeded, Executing, Completed, Cancelled, Defeated, ExecutingWithErrors, Vetoed — with `is_terminal()` helper
- **Account type constants** — `REALM_V1`, `REALM_V2`, `GOVERNANCE_V1`, `GOVERNANCE_V2`, etc.

## What's NOT included

- WithdrawGoverningTokens, SetGovernanceDelegate, CreateProposal, AddSignatory, CastVote, FinalizeVote, and all other governance instructions
- GovernanceConfig builder (raw Borsh bytes are passed through)
- Full account deserialization (only field extraction at known offsets)
- SignatoryRecord, VoteRecord, ProposalTransaction state types

## Usage

```toml
[dependencies]
p-gov = { path = "../../sdks/p-gov" }
```

```rust
use p_gov::instructions::{CreateRealm, RealmConfigArgs, VoteThreshold, GovTokenConfig, GovTokenType};

let create_realm = CreateRealm {
    governance_program,
    realm,
    realm_authority,
    community_mint,
    payer,
    system_program,
    spl_token_program,
    rent_sysvar,
    council_mint,
    community_token_holding,
    council_token_holding,
    realm_config,
    voter_weight_addin: Some(voter_weight_program),
    max_voter_weight_addin: Some(max_voter_weight_program),
    name: b"My Realm",
    config_args: RealmConfigArgs {
        use_council_mint: true,
        min_community_weight_to_create_governance: 1,
        community_vote_threshold: VoteThreshold::SupplyFraction(60),
        community_token_config: GovTokenConfig {
            use_voter_weight_addin: true,
            use_max_voter_weight_addin: true,
            token_type: GovTokenType::Liquid,
        },
        council_token_config: GovTokenConfig::default(),
    },
};

create_realm.invoke_signed(&[realm_signer])?;
```

```rust
use p_gov::state::RealmV2;

let data = realm_account.try_borrow_data()?;
let community_mint = RealmV2::community_mint(&data); // &[u8] (32 bytes)
let authority = RealmV2::authority(&data);            // Option<&[u8; 32]>
```

## Dependencies

- `pinocchio` 0.10.2 (with `cpi` feature)

## License

Same as the parent project.
