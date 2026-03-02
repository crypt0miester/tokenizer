/// An enum representing the types of accounts that can update data on an asset.
#[repr(C)]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum UpdateAuthority {
    /// No update authority, used for immutability.
    None,
    /// A standard address or PDA.
    Address([u8; 32]),
    /// Authority delegated to a collection.
    Collection([u8; 32]),
}

impl UpdateAuthority {
    /// Get the address of the update authority.
    pub fn key(&self) -> [u8; 32] {
        match self {
            Self::None => [0u8; 32],
            Self::Address(address) => *address,
            Self::Collection(address) => *address,
        }
    }

    /// Get the discriminator byte for serialization
    pub fn discriminator(&self) -> u8 {
        match self {
            Self::None => 0,
            Self::Address(_) => 1,
            Self::Collection(_) => 2,
        }
    }

    /// Create from discriminator and optional pubkey
    pub fn from_bytes(discriminator: u8, key: &[u8; 32]) -> Self {
        match discriminator {
            0 => Self::None,
            1 => Self::Address(*key),
            2 => Self::Collection(*key),
            _ => Self::None,
        }
    }
}