use pinocchio::Address;

use super::EMERGENCY_RECORD_SEED;

/// Audit trail for emergency token recovery operations.
/// Prevents double recovery and provides on-chain proof.
/// PDA: ["emergency_record", old_asset_token.key()]
#[repr(C)]
pub struct EmergencyRecord {
    pub account_key: u8,           // AccountKey::EmergencyRecord (10)
    pub version: u8,
    pub asset: [u8; 32],           // Parent asset
    pub old_asset_token: [u8; 32], // The recovered token
    pub old_owner: [u8; 32],       // Previous owner (lost wallet)
    pub recovery_type: u8,         // 0 = burn_and_remint, 1 = split_and_remint
    pub created_at: i64,
    pub bump: u8,

    // Terms & Conditions fields

    /// Recovery reason (RecoveryReason enum). 0 = LostKeys (default).
    pub reason: u8,

    /// Number of shares transferred (for partial burn_and_remint). 0 = full transfer.
    pub shares_transferred: u64,

    /// Remainder token PDA address (for partial burn_and_remint). Zero = no remainder.
    pub remainder_token: [u8; 32],
}

impl EmergencyRecord {
    pub const LEN: usize = core::mem::size_of::<Self>();

    #[inline(always)]
    pub unsafe fn load(data: &[u8]) -> &Self {
        &*(data.as_ptr() as *const Self)
    }

    #[inline(always)]
    pub unsafe fn load_mut(data: &mut [u8]) -> &mut Self {
        &mut *(data.as_mut_ptr() as *mut Self)
    }

    pub fn derive_pda(
        old_asset_token: &[u8; 32],
        program_id: &Address,
    ) -> (Address, u8) {
        Address::find_program_address(
            &[EMERGENCY_RECORD_SEED, old_asset_token],
            program_id,
        )
    }
}
