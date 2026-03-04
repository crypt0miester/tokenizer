use pinocchio::{error::ProgramError, Address};

use super::VOTER_WEIGHT_RECORD_SEED;
use crate::utils::read_u64;

/// VoterWeightRecord — Borsh-compatible layout for spl-gov voter weight plugin interface.
/// PDA: ["voter-weight-record", realm, governing_token_mint, governing_token_owner]
///
/// NOT #[repr(C)] — uses fixed byte offsets for Borsh compatibility.
/// All Option fields are always written as Some(...) for deterministic offsets.
///
/// Layout:
///   0..8     discriminator [46, 249, 155, 75, 153, 248, 116, 9]
///   8..40    realm (Pubkey)
///   40..72   governing_token_mint (Pubkey)
///   72..104  governing_token_owner (Pubkey)
///   104..112 voter_weight (u64 LE)
///   112      0x01 (Some tag)
///   113..121 voter_weight_expiry (u64 LE slot)
///   121      0x01 (Some tag)
///   122      weight_action (u8 enum)
///   123      0x01 (Some tag)
///   124..156 weight_action_target (Pubkey)
///   156..164 reserved [u8; 8]
///   Total: 164 bytes
pub struct VoterWeightRecord;

pub const VOTER_WEIGHT_RECORD_DISCRIMINATOR: [u8; 8] = [46, 249, 155, 75, 153, 248, 116, 9];

impl VoterWeightRecord {
    pub const LEN: usize = 164;

    pub fn derive_pda(
        realm: &[u8; 32],
        governing_token_mint: &[u8; 32],
        governing_token_owner: &[u8; 32],
        program_id: &Address,
    ) -> (Address, u8) {
        Address::find_program_address(
            &[VOTER_WEIGHT_RECORD_SEED, realm, governing_token_mint, governing_token_owner],
            program_id,
        )
    }

    /// Read voter_weight from account data at fixed offset 104.
    #[inline(always)]
    pub fn load_voter_weight(data: &[u8]) -> Result<u64, ProgramError> {
        read_u64(data, 104, "voter_weight")
    }

    /// Write all fields to account data at fixed Borsh-compatible offsets.
    pub fn store(
        data: &mut [u8],
        realm: &[u8; 32],
        governing_token_mint: &[u8; 32],
        governing_token_owner: &[u8; 32],
        voter_weight: u64,
        voter_weight_expiry: u64,
        weight_action: u8,
        weight_action_target: &[u8; 32],
    ) {
        // discriminator
        data[0..8].copy_from_slice(&VOTER_WEIGHT_RECORD_DISCRIMINATOR);
        // realm
        data[8..40].copy_from_slice(realm);
        // governing_token_mint
        data[40..72].copy_from_slice(governing_token_mint);
        // governing_token_owner
        data[72..104].copy_from_slice(governing_token_owner);
        // voter_weight
        data[104..112].copy_from_slice(&voter_weight.to_le_bytes());
        // Some tag + voter_weight_expiry
        data[112] = 0x01;
        data[113..121].copy_from_slice(&voter_weight_expiry.to_le_bytes());
        // Some tag + weight_action
        data[121] = 0x01;
        data[122] = weight_action;
        // Some tag + weight_action_target
        data[123] = 0x01;
        data[124..156].copy_from_slice(weight_action_target);
        // reserved
        data[156..164].copy_from_slice(&[0u8; 8]);
    }
}
