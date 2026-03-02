use super::PluginAuthority;

/// Freeze Delegate plugin - allows delegate to freeze/unfreeze assets
#[repr(C)]
#[derive(Copy, Clone, Debug)]
pub struct FreezeDelegate {
    /// Whether the asset is currently frozen
    pub frozen: bool,
    /// Authority who can freeze/unfreeze
    pub authority: PluginAuthority,
    /// Reserved space for authority pubkey if Address type
    pub authority_key: [u8; 32],
    /// Padding for alignment
    pub _padding: [u8; 3],
}

impl FreezeDelegate {
    pub const LEN: usize = 1 + 1 + 32 + 3;

    pub fn new(authority: PluginAuthority, frozen: bool) -> Self {
        let mut authority_key = [0u8; 32];
        if let PluginAuthority::Address(pubkey) = authority {
            authority_key.copy_from_slice(&pubkey);
        }

        Self {
            frozen,
            authority,
            authority_key,
            _padding: [0; 3],
        }
    }
}

/// Burn Delegate plugin - allows delegate to burn assets
#[repr(C)]
#[derive(Copy, Clone, Debug)]
pub struct BurnDelegate {
    /// Authority who can burn
    pub authority: PluginAuthority,
    /// Reserved space for authority pubkey if Address type
    pub authority_key: [u8; 32],
    /// Padding for alignment
    pub _padding: [u8; 3],
}

impl BurnDelegate {
    pub const LEN: usize = 1 + 32 + 3;

    pub fn new(authority: PluginAuthority) -> Self {
        let mut authority_key = [0u8; 32];
        if let PluginAuthority::Address(pubkey) = authority {
            authority_key.copy_from_slice(&pubkey);
        }

        Self {
            authority,
            authority_key,
            _padding: [0; 3],
        }
    }
}

/// Transfer Delegate plugin - allows delegate to transfer assets
#[repr(C)]
#[derive(Copy, Clone, Debug)]
pub struct TransferDelegate {
    /// Authority who can transfer
    pub authority: PluginAuthority,
    /// Reserved space for authority pubkey if Address type
    pub authority_key: [u8; 32],
    /// Padding for alignment
    pub _padding: [u8; 3],
}

impl TransferDelegate {
    pub const LEN: usize = 1 + 32 + 3;

    pub fn new(authority: PluginAuthority) -> Self {
        let mut authority_key = [0u8; 32];
        if let PluginAuthority::Address(pubkey) = authority {
            authority_key.copy_from_slice(&pubkey);
        }

        Self {
            authority,
            authority_key,
            _padding: [0; 3],
        }
    }
}

/// Royalties plugin - defines royalty configuration for collections
#[repr(C)]
#[derive(Copy, Clone, Debug)]
pub struct Royalties {
    /// Basis points for royalty (0-10000)
    pub basis_points: u16,
    /// Padding for alignment
    pub _padding1: [u8; 2],
    /// Primary creator address
    pub primary_creator: [u8; 32],
    /// Max number of additional creators
    pub creator_count: u8,
    /// Padding for alignment
    pub _padding2: [u8; 3],
    /// Additional creators (up to 5)
    pub creators: [RoyaltyCreator; 5],
}

/// Individual creator in royalty split
#[repr(C)]
#[derive(Copy, Clone, Debug)]
pub struct RoyaltyCreator {
    /// Creator address
    pub address: [u8; 32],
    /// Share percentage (0-100)
    pub percentage: u8,
    /// Is this slot active?
    pub is_active: bool,
    /// Padding
    pub _padding: [u8; 2],
}

impl Royalties {
    pub const LEN: usize = 2 + 2 + 32 + 1 + 3 + (36 * 5); // 220 bytes

    pub fn new(basis_points: u16, primary_creator: [u8; 32]) -> Self {
        Self {
            basis_points,
            _padding1: [0; 2],
            primary_creator,
            creator_count: 0,
            _padding2: [0; 3],
            creators: [RoyaltyCreator {
                address: [0u8; 32],
                percentage: 0,
                is_active: false,
                _padding: [0; 2],
            }; 5],
        }
    }
}

/// Edition plugin - tracks edition number for prints
#[repr(C)]
#[derive(Copy, Clone, Debug)]
pub struct Edition {
    /// Edition number (0 for master)
    pub number: u32,
    /// Padding for alignment
    pub _padding: [u8; 4],
}

impl Edition {
    pub const LEN: usize = 4 + 4;

    pub fn new(number: u32) -> Self {
        Self {
            number,
            _padding: [0; 4],
        }
    }
}

/// Master Edition plugin - defines print configuration
#[repr(C)]
#[derive(Copy, Clone, Debug)]
pub struct MasterEdition {
    /// Maximum supply (0 for unlimited)
    pub max_supply: u32,
    /// Current supply (number printed)
    pub supply: u32,
    /// Authority who can print
    pub authority: PluginAuthority,
    /// Reserved space for authority pubkey if Address type
    pub authority_key: [u8; 32],
    /// Padding for alignment
    pub _padding: [u8; 3],
}

impl MasterEdition {
    pub const LEN: usize = 4 + 4 + 1 + 32 + 3;

    pub fn new(max_supply: u32, authority: PluginAuthority) -> Self {
        let mut authority_key = [0u8; 32];
        if let PluginAuthority::Address(pubkey) = authority {
            authority_key.copy_from_slice(&pubkey);
        }

        Self {
            max_supply,
            supply: 0,
            authority,
            authority_key,
            _padding: [0; 3],
        }
    }
}