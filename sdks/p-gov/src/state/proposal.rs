use super::{account_type, ProposalState};

/// Zero-copy reader for spl-gov ProposalV2 account data.
///
/// Borsh layout (fixed prefix):
///   [0]       account_type (1 byte — 14 for ProposalV2)
///   [1..33]   governance (Pubkey)
///   [33..65]  governing_token_mint (Pubkey)
///   [65]      state (ProposalState, 1 byte)
///   [66..98]  token_owner_record (Pubkey)
pub struct ProposalV2;

impl ProposalV2 {
    pub const ACCOUNT_TYPE: u8 = account_type::PROPOSAL_V2;

    /// Returns true if byte 0 matches ProposalV1 or ProposalV2.
    #[inline(always)]
    pub fn check_account_type(data: &[u8]) -> bool {
        !data.is_empty()
            && (data[0] == account_type::PROPOSAL_V1 || data[0] == account_type::PROPOSAL_V2)
    }

    /// Governance pubkey bytes at offset [1..33].
    #[inline(always)]
    pub fn governance(data: &[u8]) -> &[u8] {
        &data[1..33]
    }

    /// Governing token mint pubkey bytes at offset [33..65].
    #[inline(always)]
    pub fn governing_token_mint(data: &[u8]) -> &[u8] {
        &data[33..65]
    }

    /// Proposal state at offset [65].
    #[inline(always)]
    pub fn state(data: &[u8]) -> Option<ProposalState> {
        ProposalState::from_u8(data[65])
    }

    /// Token owner record pubkey bytes at offset [66..98].
    #[inline(always)]
    pub fn token_owner_record(data: &[u8]) -> &[u8] {
        &data[66..98]
    }
}
