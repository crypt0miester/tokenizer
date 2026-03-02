mod asset;
pub use asset::*;

mod collection;
pub use collection::*;

mod update_authority;
pub use update_authority::*;

/// Account discriminator keys for MPL Core accounts
#[repr(u8)]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Key {
    /// Uninitialized or invalid account.
    Uninitialized = 0,
    /// An account holding an uncompressed asset.
    AssetV1 = 1,
    /// An account holding a compressed asset.
    HashedAssetV1 = 2,
    /// A discriminator indicating the plugin header.
    PluginHeaderV1 = 3,
    /// A discriminator indicating the plugin registry.
    PluginRegistryV1 = 4,
    /// A discriminator indicating the collection.
    CollectionV1 = 5,
}

impl From<u8> for Key {
    fn from(value: u8) -> Self {
        match value {
            0 => Key::Uninitialized,
            1 => Key::AssetV1,
            2 => Key::HashedAssetV1,
            3 => Key::PluginHeaderV1,
            4 => Key::PluginRegistryV1,
            5 => Key::CollectionV1,
            _ => Key::Uninitialized,
        }
    }
}

/// Authority types for managing plugins and assets
#[repr(u8)]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Authority {
    /// No authority, used for immutability.
    None = 0,
    /// Authority managed by the asset owner.
    Owner = 1,
    /// Authority managed by the update authority.
    UpdateAuthority = 2,
    /// Authority managed by an approved address.
    Address { address: [u8; 32] } = 3,
}