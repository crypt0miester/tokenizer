# p-core

Pinocchio CPI wrapper for [Metaplex Core](https://developers.metaplex.com/core) (`CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d`).

This is **not** a general-purpose MPL Core SDK. It only wraps the subset of instructions, state, and plugins that the tokenizer program needs. If you need full MPL Core coverage, use the official [mpl-core](https://crates.io/crates/mpl-core) crate instead.

## What's included

### Instructions

| Instruction | Discriminant | Purpose |
|---|---|---|
| CreateV1 | 0 | Create an asset (with optional collection + plugins) |
| CreateCollectionV1 | 1 | Create a collection |
| TransferV1 | 14 | Transfer an asset between owners |
| BurnV1 | 12 | Burn an asset |
| UpdateV1 | 15 | Update asset name, URI, or update authority |
| UpdateCollectionV1 | 16 | Update collection name or URI |
| AddPluginV1 | 2 | Add a plugin to an asset |
| UpdatePluginV1 | 3 | Update plugin data on an asset |
| RemovePluginV1 | 4 | Remove a plugin from an asset |

All instructions expose `invoke()` and `invoke_signed(&[Signer])` for CPI.

### State

| Type | Size | Description |
|---|---|---|
| AssetV1 | 308 bytes | Fixed-size asset — owner, update authority, name (32 B), URI (200 B), sequence |
| CollectionV1 | 289 bytes | Fixed-size collection — update authority, name, URI, num_minted, current_size |
| UpdateAuthority | enum | None / Address / Collection |
| Key | enum | Account discriminator (Uninitialized, AssetV1, CollectionV1, etc.) |

### Plugins

| Plugin | Size | Description |
|---|---|---|
| Attributes | 1107 bytes | Up to 10 key-value pairs (32 B key, 64 B value each) |
| FreezeDelegate | 37 bytes | Freeze/unfreeze by delegate |
| BurnDelegate | 36 bytes | Burn by delegate |
| TransferDelegate | 36 bytes | Transfer by delegate |
| PermanentFreezeDelegate | — | Permanent freeze (via AddPluginV1) |
| Royalties | 220 bytes | Basis points + up to 5 creators |
| Edition | 8 bytes | Edition number |
| MasterEdition | 44 bytes | Max supply, current supply |

Plugin header/registry types (`PluginHeaderV1`, `PluginRegistryV1`) and `PluginAuthority` (None, Owner, UpdateAuthority, Address) are also included.

## What's NOT included

- HashedAsset / compression proofs
- Collection-level plugins
- AddCollectionPluginV1 / UpdateCollectionPluginV1 / RemoveCollectionPluginV1
- Oracle, AppData, LifecycleHook, and other external plugins
- Deserialization of arbitrary on-chain plugin registries (we use fixed-size `repr(C)` structs)

## Usage

```toml
[dependencies]
p-core = { path = "../../sdks/p-core" }
```

```rust
use p_core::instructions::{CreateV1, DataState};

let create = CreateV1 {
    asset,
    collection: Some(collection_account),
    authority: Some(authority_account),
    payer,
    owner: Some(owner_account),
    update_authority: Some(update_authority_account),
    system_program,
    log_wrapper: None,
    data_state: DataState::AccountState,
    name: b"My Asset",
    uri: b"https://example.com/metadata.json",
    plugins: None,
};

create.invoke_signed(&[signer])?;
```

```rust
use p_core::state::AssetV1;

let asset = unsafe { AssetV1::load(&account_data) };
let name = asset.get_name();   // &str, trimmed
let uri = asset.get_uri();     // &str, trimmed
```

## Dependencies

- `pinocchio` 0.10.2 (with `cpi` feature)

## License

Same as the parent project.
