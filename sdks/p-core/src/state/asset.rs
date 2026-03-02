use super::{Key, UpdateAuthority};

/// Maximum length for asset name
pub const MAX_NAME_LEN: usize = 32;
/// Maximum length for asset URI
pub const MAX_URI_LEN: usize = 200;

/// The Core Asset structure that exists at the beginning of every asset account.
#[repr(C)]
#[derive(Copy, Clone, Debug)]
pub struct AssetV1 {
    /// The account discriminator.
    pub key: Key,
    /// The owner of the asset.
    pub owner: [u8; 32],
    /// The update authority of the asset.
    pub update_authority: UpdateAuthority,
    /// The name of the asset (fixed size with actual length).
    pub name: [u8; MAX_NAME_LEN],
    /// Actual length of the name.
    pub name_len: u32,
    /// The URI of the asset that points to the off-chain data.
    pub uri: [u8; MAX_URI_LEN],
    /// Actual length of the URI.
    pub uri_len: u32,
    /// The sequence number used for indexing with compression (u64::MAX = None).
    pub seq: u64,
    /// Whether seq is valid (true if compressed)
    pub has_seq: bool,
    /// Padding for alignment
    pub _padding: [u8; 7],
}

impl AssetV1 {
    /// The fixed size of an AssetV1 account in bytes
    pub const LEN: usize = 1 // Key discriminator
        + 32 // Owner pubkey
        + 33 // UpdateAuthority (1 byte discriminator + 32 bytes pubkey)
        + MAX_NAME_LEN // Name array
        + 4 // Name length
        + MAX_URI_LEN // URI array
        + 4 // URI length
        + 8 // seq u64
        + 1 // has_seq bool
        + 7; // padding

    /// Parse an AssetV1 from Borsh-encoded account data (mainnet MPL Core format).
    ///
    /// Borsh layout: key(1) + owner(32) + update_authority(1+0|32) + name(4+N) + uri(4+M) + seq(1+0|8)
    pub fn from_borsh(data: &[u8]) -> Self {
        let key = Key::from(data[0]);

        let mut owner = [0u8; 32];
        owner.copy_from_slice(&data[1..33]);

        // update_authority: enum discriminant(1) + optional pubkey(32)
        let ua_disc = data[33];
        let mut ua_key = [0u8; 32];
        let mut offset = 34;
        if ua_disc == 1 || ua_disc == 2 {
            ua_key.copy_from_slice(&data[34..66]);
            offset = 66;
        }
        let update_authority = UpdateAuthority::from_bytes(ua_disc, &ua_key);

        // name: Borsh string
        let name_len = u32::from_le_bytes([
            data[offset], data[offset + 1], data[offset + 2], data[offset + 3],
        ]) as usize;
        offset += 4;
        let mut name = [0u8; MAX_NAME_LEN];
        let copy_len = name_len.min(MAX_NAME_LEN);
        name[..copy_len].copy_from_slice(&data[offset..offset + copy_len]);
        offset += name_len;

        // uri: Borsh string
        let uri_len = u32::from_le_bytes([
            data[offset], data[offset + 1], data[offset + 2], data[offset + 3],
        ]) as usize;
        offset += 4;
        let mut uri = [0u8; MAX_URI_LEN];
        let uri_copy_len = uri_len.min(MAX_URI_LEN);
        uri[..uri_copy_len].copy_from_slice(&data[offset..offset + uri_copy_len]);
        offset += uri_len;

        // seq: Option<u64>
        let mut seq = 0u64;
        let mut has_seq = false;
        if offset < data.len() {
            let seq_option = data[offset];
            offset += 1;
            if seq_option == 1 && offset + 8 <= data.len() {
                seq = u64::from_le_bytes([
                    data[offset], data[offset + 1], data[offset + 2], data[offset + 3],
                    data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7],
                ]);
                has_seq = true;
            }
        }

        Self {
            key,
            owner,
            update_authority,
            name,
            name_len: name_len as u32,
            uri,
            uri_len: uri_len as u32,
            seq,
            has_seq,
            _padding: [0u8; 7],
        }
    }

    /// Create a new AssetV1
    pub fn new(
        owner: [u8; 32],
        update_authority: UpdateAuthority,
        name: &[u8],
        uri: &[u8],
    ) -> Self {
        let mut asset = Self {
            key: Key::AssetV1,
            owner,
            update_authority,
            name: [0u8; MAX_NAME_LEN],
            name_len: 0,
            uri: [0u8; MAX_URI_LEN],
            uri_len: 0,
            seq: 0,
            has_seq: false,
            _padding: [0u8; 7],
        };

        // Copy name
        let name_len = name.len().min(MAX_NAME_LEN);
        asset.name[..name_len].copy_from_slice(&name[..name_len]);
        asset.name_len = name_len as u32;

        // Copy URI
        let uri_len = uri.len().min(MAX_URI_LEN);
        asset.uri[..uri_len].copy_from_slice(&uri[..uri_len]);
        asset.uri_len = uri_len as u32;

        asset
    }

    /// Get the name as a slice
    pub fn get_name(&self) -> &[u8] {
        let len = (self.name_len as usize).min(MAX_NAME_LEN);
        &self.name[..len]
    }

    /// Get the URI as a slice
    pub fn get_uri(&self) -> &[u8] {
        let len = (self.uri_len as usize).min(MAX_URI_LEN);
        &self.uri[..len]
    }

    /// Check if this is a valid AssetV1 account
    pub fn is_valid(&self) -> bool {
        self.key == Key::AssetV1
    }
}