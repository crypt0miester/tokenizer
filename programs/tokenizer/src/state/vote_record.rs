/// Per-asset-token vote tracking record — tracks which proposals a token is actively voting on.
/// PDA: ["vote_record", asset_token.key()]
///
/// Layout (header: 35 bytes + 32 per proposal):
///   offset  0: account_key: u8      (AccountKey::VoteRecord = 13)
///   offset  1: bump: u8
///   offset  2: creator: [u8; 32]    (payer who created — receives rent on close)
///   offset 34: proposals_count: u8  (active proposals, max 255)
///   offset 35: proposals: [u8; 32*N] (proposal pubkeys)
#[repr(C)]
pub struct VoteRecordHeader {
    pub account_key: u8,
    pub bump: u8,
    pub creator: [u8; 32],
    pub proposals_count: u8,
}

impl VoteRecordHeader {
    pub const LEN: usize = 35; // 1 + 1 + 32 + 1
}

/// Check if the proposals list contains a given proposal.
#[inline(always)]
pub fn contains_proposal(data: &[u8], proposal: &[u8; 32]) -> bool {
    let count = data[34] as usize;
    for i in 0..count {
        let offset = VoteRecordHeader::LEN + i * 32;
        if &data[offset..offset + 32] == proposal {
            return true;
        }
    }
    false
}

/// Append a proposal to the list. Caller must ensure space is available.
#[inline(always)]
pub fn add_proposal(data: &mut [u8], proposal: &[u8; 32]) {
    let count = data[34] as usize;
    let offset = VoteRecordHeader::LEN + count * 32;
    data[offset..offset + 32].copy_from_slice(proposal);
    data[34] = (count + 1) as u8;
}

/// Remove a proposal from the list using swap-with-last.
/// Returns true if found and removed, false if not found.
#[inline(always)]
pub fn remove_proposal(data: &mut [u8], proposal: &[u8; 32]) -> bool {
    let count = data[34] as usize;
    for i in 0..count {
        let offset = VoteRecordHeader::LEN + i * 32;
        if &data[offset..offset + 32] == proposal {
            if i < count - 1 {
                let last_offset = VoteRecordHeader::LEN + (count - 1) * 32;
                let mut last = [0u8; 32];
                last.copy_from_slice(&data[last_offset..last_offset + 32]);
                data[offset..offset + 32].copy_from_slice(&last);
            }
            data[34] = (count - 1) as u8;
            return true;
        }
    }
    false
}
