use super::account_type;

/// Zero-copy reader for spl-gov GovernanceV2 account data.
///
/// Borsh layout (fixed prefix):
///   [0]       account_type (1 byte — 18 for GovernanceV2)
///   [1..33]   realm (Pubkey)
///   [33..65]  governance_seed (Pubkey)
pub struct GovernanceV2;

impl GovernanceV2 {
    pub const ACCOUNT_TYPE: u8 = account_type::GOVERNANCE_V2;

    /// Returns true if byte 0 matches GovernanceV1 or GovernanceV2.
    #[inline(always)]
    pub fn check_account_type(data: &[u8]) -> bool {
        !data.is_empty()
            && (data[0] == account_type::GOVERNANCE_V1 || data[0] == account_type::GOVERNANCE_V2)
    }

    /// Realm pubkey bytes at offset [1..33].
    #[inline(always)]
    pub fn realm(data: &[u8]) -> &[u8] {
        &data[1..33]
    }

    /// Governance seed pubkey bytes at offset [33..65].
    #[inline(always)]
    pub fn governance_seed(data: &[u8]) -> &[u8] {
        &data[33..65]
    }
}
