use super::account_type;

/// Zero-copy reader for spl-gov TokenOwnerRecordV2 account data.
///
/// Borsh layout (fixed prefix):
///   [0]        account_type (1 byte — 17 for TokenOwnerRecordV2)
///   [1..33]    realm (Pubkey)
///   [33..65]   governing_token_mint (Pubkey)
///   [65..97]   governing_token_owner (Pubkey)
///   [97..105]  governing_token_deposit_amount (u64 LE)
pub struct TokenOwnerRecordV2;

impl TokenOwnerRecordV2 {
    pub const ACCOUNT_TYPE: u8 = account_type::TOKEN_OWNER_RECORD_V2;

    /// Returns true if byte 0 matches TokenOwnerRecordV1 or TokenOwnerRecordV2.
    #[inline(always)]
    pub fn check_account_type(data: &[u8]) -> bool {
        !data.is_empty()
            && (data[0] == account_type::TOKEN_OWNER_RECORD_V1
                || data[0] == account_type::TOKEN_OWNER_RECORD_V2)
    }

    /// Realm pubkey bytes at offset [1..33].
    #[inline(always)]
    pub fn realm(data: &[u8]) -> &[u8] {
        &data[1..33]
    }

    /// Governing token mint pubkey bytes at offset [33..65].
    #[inline(always)]
    pub fn governing_token_mint(data: &[u8]) -> &[u8] {
        &data[33..65]
    }

    /// Governing token owner pubkey bytes at offset [65..97].
    #[inline(always)]
    pub fn governing_token_owner(data: &[u8]) -> &[u8] {
        &data[65..97]
    }

    /// Governance delegate Option<Pubkey> at offset 121.
    /// Layout: ...outstanding_proposal_count(1) + version(1) + reserved(6) + Option tag(1) + Pubkey(32)
    /// Returns Some(&[u8]) if delegate is set, None otherwise.
    #[inline(always)]
    pub fn governance_delegate(data: &[u8]) -> Option<&[u8]> {
        if data.len() < 154 || data[121] == 0 {
            None
        } else {
            Some(&data[122..154])
        }
    }
}
