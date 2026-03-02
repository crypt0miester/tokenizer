use pinocchio::Address;

use super::MAX_VOTER_WEIGHT_RECORD_SEED;

/// MaxVoterWeightRecord — Borsh-compatible layout for spl-gov max voter weight plugin interface.
/// PDA: ["max-voter-weight-record", realm, governing_token_mint]
///
/// NOT #[repr(C)] — uses fixed byte offsets for Borsh compatibility.
///
/// Layout:
///   0..8    discriminator [157, 95, 242, 151, 16, 98, 26, 118]
///   8..40   realm (Pubkey)
///   40..72  governing_token_mint (Pubkey)
///   72..80  max_voter_weight (u64 LE)
///   80      0x01 (Some tag)
///   81..89  max_voter_weight_expiry (u64 LE slot)
///   89..97  reserved [u8; 8]
///   Total: 97 bytes
pub struct MaxVoterWeightRecord;

pub const MAX_VOTER_WEIGHT_RECORD_DISCRIMINATOR: [u8; 8] = [157, 95, 242, 151, 16, 98, 26, 118];

impl MaxVoterWeightRecord {
    pub const LEN: usize = 97;

    pub fn derive_pda(
        realm: &[u8; 32],
        governing_token_mint: &[u8; 32],
        program_id: &Address,
    ) -> (Address, u8) {
        Address::find_program_address(
            &[MAX_VOTER_WEIGHT_RECORD_SEED, realm, governing_token_mint],
            program_id,
        )
    }

    /// Write all fields to account data at fixed Borsh-compatible offsets.
    pub fn store(
        data: &mut [u8],
        realm: &[u8; 32],
        governing_token_mint: &[u8; 32],
        max_voter_weight: u64,
        max_voter_weight_expiry: u64,
        has_expiry: bool,
    ) {
        // discriminator
        data[0..8].copy_from_slice(&MAX_VOTER_WEIGHT_RECORD_DISCRIMINATOR);
        // realm
        data[8..40].copy_from_slice(realm);
        // governing_token_mint
        data[40..72].copy_from_slice(governing_token_mint);
        // max_voter_weight
        data[72..80].copy_from_slice(&max_voter_weight.to_le_bytes());
        if has_expiry {
            // Some tag + expiry
            data[80] = 0x01;
            data[81..89].copy_from_slice(&max_voter_weight_expiry.to_le_bytes());
        } else {
            // None tag
            data[80] = 0x00;
            data[81..89].copy_from_slice(&[0u8; 8]);
        }
        // reserved
        data[89..97].copy_from_slice(&[0u8; 8]);
    }
}
