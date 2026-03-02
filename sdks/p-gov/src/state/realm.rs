use super::account_type;

/// Zero-copy reader for spl-gov RealmV2 account data.
///
/// Borsh layout (fixed prefix):
///   [0]       account_type (1 byte — 16 for RealmV2)
///   [1..33]   community_mint (Pubkey)
pub struct RealmV2;

impl RealmV2 {
    pub const ACCOUNT_TYPE: u8 = account_type::REALM_V2;

    /// Returns true if byte 0 matches RealmV1 or RealmV2.
    #[inline(always)]
    pub fn check_account_type(data: &[u8]) -> bool {
        !data.is_empty()
            && (data[0] == account_type::REALM_V1 || data[0] == account_type::REALM_V2)
    }

    /// Community mint pubkey bytes at offset [1..33].
    #[inline(always)]
    pub fn community_mint(data: &[u8]) -> &[u8] {
        &data[1..33]
    }

    /// Parse the realm authority (Option<Pubkey>) from Borsh-encoded data.
    /// Layout: account_type(1) + community_mint(32) + RealmConfig(...) + reserved(6) + voting_proposal_count(2) + authority
    /// RealmConfig has variable size due to council_mint: Option<Pubkey>.
    /// council_mint option tag is at offset 58.
    pub fn authority(data: &[u8]) -> Option<&[u8; 32]> {
        if data.len() < 59 {
            return None;
        }
        // council_mint Option tag at offset 58
        let authority_offset = if data[58] == 0 {
            59 + 6 + 2 // 67: None council_mint (1 tag byte)
        } else {
            59 + 32 + 6 + 2 // 99: Some council_mint (1 tag + 32 pubkey)
        };
        if data.len() < authority_offset + 1 + 32 {
            return None;
        }
        if data[authority_offset] == 0 {
            return None; // authority is None
        }
        data[authority_offset + 1..authority_offset + 33].try_into().ok()
    }
}
