mod attributes;
pub use attributes::*;

mod plugin_types;
pub use plugin_types::*;

/// Maximum number of attributes per asset
pub const MAX_ATTRIBUTES: usize = 10;

/// Plugin discriminator types
#[repr(u8)]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum PluginType {
    /// Royalties plugin (collection level)
    Royalties = 0,
    /// Freeze Delegate plugin (owner managed)
    FreezeDelegate = 1,
    /// Burn Delegate plugin (owner managed)
    BurnDelegate = 2,
    /// Transfer Delegate plugin (owner managed)
    TransferDelegate = 3,
    /// Update Delegate plugin (authority managed)
    UpdateDelegate = 4,
    /// Permanent Freeze Delegate (permanent)
    PermanentFreezeDelegate = 5,
    /// Attributes plugin for key-value pairs (authority managed)
    Attributes = 6,
    /// Permanent Transfer Delegate (permanent)
    PermanentTransferDelegate = 7,
    /// Permanent Burn Delegate (permanent)
    PermanentBurnDelegate = 8,
    /// Edition plugin (permanent)
    Edition = 9,
    /// Master Edition plugin (authority managed)
    MasterEdition = 10,
    /// Add Blocker plugin (authority managed)
    AddBlocker = 11,
    /// Immutable Metadata plugin (authority managed)
    ImmutableMetadata = 12,
    /// Verified Creators plugin (authority managed)
    VerifiedCreators = 13,
}

impl From<u8> for PluginType {
    fn from(value: u8) -> Self {
        match value {
            0 => PluginType::Royalties,
            1 => PluginType::FreezeDelegate,
            2 => PluginType::BurnDelegate,
            3 => PluginType::TransferDelegate,
            4 => PluginType::UpdateDelegate,
            5 => PluginType::PermanentFreezeDelegate,
            6 => PluginType::Attributes,
            7 => PluginType::PermanentTransferDelegate,
            8 => PluginType::PermanentBurnDelegate,
            9 => PluginType::Edition,
            10 => PluginType::MasterEdition,
            11 => PluginType::AddBlocker,
            12 => PluginType::ImmutableMetadata,
            13 => PluginType::VerifiedCreators,
            _ => PluginType::Attributes, // Default fallback
        }
    }
}

/// Plugin authority types
#[repr(C)]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum PluginAuthority {
    /// No authority - cannot be updated
    None,
    /// Owner can update
    Owner,
    /// Update authority can update
    UpdateAuthority,
    /// Specific address can update
    Address([u8; 32]),
}

impl PluginAuthority {
    /// Get discriminator byte for serialization
    pub fn discriminator(&self) -> u8 {
        match self {
            PluginAuthority::None => 0,
            PluginAuthority::Owner => 1,
            PluginAuthority::UpdateAuthority => 2,
            PluginAuthority::Address(_) => 3,
        }
    }

    /// Create from discriminator and optional pubkey
    pub fn from_bytes(discriminator: u8, key: &[u8; 32]) -> Self {
        match discriminator {
            0 => PluginAuthority::None,
            1 => PluginAuthority::Owner,
            2 => PluginAuthority::UpdateAuthority,
            3 => PluginAuthority::Address(*key),
            _ => PluginAuthority::None,
        }
    }
}

/// Plugin header for tracking plugin data in accounts
#[repr(C)]
#[derive(Copy, Clone, Debug)]
pub struct PluginHeaderV1 {
    /// Account discriminator key
    pub key: super::state::Key,
    /// The current size of the plugin registry
    pub plugin_registry_offset: u32,
}

impl PluginHeaderV1 {
    pub const LEN: usize = 1 + 4; // Key + offset

    /// Load plugin header from account data
    pub unsafe fn load(data: &[u8]) -> &Self {
        &*(data.as_ptr() as *const Self)
    }

    /// Load mutable plugin header from account data
    pub unsafe fn load_mut(data: &mut [u8]) -> &mut Self {
        &mut *(data.as_mut_ptr() as *mut Self)
    }
}

/// Plugin registry for tracking plugins on an asset
#[repr(C)]
#[derive(Copy, Clone, Debug)]
pub struct PluginRegistryV1 {
    /// Account discriminator key
    pub key: super::state::Key,
    /// Number of registered plugins (max 16)
    pub plugin_count: u8,
    /// Reserved for future use
    pub _padding: [u8; 3],
}

impl PluginRegistryV1 {
    pub const LEN: usize = 1 + 1 + 3; // Key + count + padding
    pub const MAX_PLUGINS: usize = 16;

    /// Load plugin registry from account data
    pub unsafe fn load(data: &[u8]) -> &Self {
        &*(data.as_ptr() as *const Self)
    }

    /// Load mutable plugin registry from account data
    pub unsafe fn load_mut(data: &mut [u8]) -> &mut Self {
        &mut *(data.as_mut_ptr() as *mut Self)
    }
}