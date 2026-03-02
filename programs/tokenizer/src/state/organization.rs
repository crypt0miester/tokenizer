use pinocchio::{error::ProgramError, Address};

use super::{FeeMode, ORGANIZATION_SEED};
use crate::error::TokenizerError;

pub const MAX_NAME_LEN: usize = 64;
pub const MAX_REG_NUMBER_LEN: usize = 32;
pub const MAX_ORG_ACCEPTED_MINTS: usize = 4;

/// Registered issuer/organization.
/// PDA: ["organization", &id.to_le_bytes()]
#[repr(C)]
pub struct Organization {
    pub account_key: u8,
    pub version: u8,

    pub id: u32,
    pub authority: [u8; 32],

    pub name: [u8; MAX_NAME_LEN],
    pub name_len: u8,
    pub registration_number: [u8; MAX_REG_NUMBER_LEN],
    pub registration_number_len: u8,
    pub country: [u8; 4],

    pub is_active: u8,

    pub asset_count: u32,

    pub realm: [u8; 32],

    pub accepted_mint_count: u8,
    pub accepted_mints: [[u8; 32]; MAX_ORG_ACCEPTED_MINTS],

    pub created_at: i64,
    pub updated_at: i64,

    pub bump: u8,

    // ── Fee fields ──
    pub round_fee_mode: u8,           // FeeMode
    pub buyout_fee_mode: u8,          // FeeMode
    pub secondary_fee_mode: u8,       // FeeMode
    pub distribution_fee_mode: u8,    // FeeMode
    // 3 bytes padding (struct alignment)
    pub round_fee_value: u64,
    pub buyout_fee_value: u64,
    pub secondary_fee_value: u64,
    pub distribution_fee_value: u64,
}

impl Organization {
    pub const LEN: usize = core::mem::size_of::<Self>();

    #[inline(always)]
    pub unsafe fn load(data: &[u8]) -> &Self {
        &*(data.as_ptr() as *const Self)
    }

    #[inline(always)]
    pub unsafe fn load_mut(data: &mut [u8]) -> &mut Self {
        &mut *(data.as_mut_ptr() as *mut Self)
    }

    pub fn derive_pda(id: u32, program_id: &Address) -> (Address, u8) {
        Address::find_program_address(&[ORGANIZATION_SEED, &id.to_le_bytes()], program_id)
    }

    #[inline(always)]
    pub fn is_active(&self) -> bool {
        self.is_active != 0
    }

    /// Calculate a fee given a mode byte, value, and base amount.
    /// Bps mode: fee = amount * value / 10_000
    /// Flat mode: fee = value (capped at amount)
    pub fn calc_fee(&self, mode: u8, value: u64, amount: u64) -> Result<u64, ProgramError> {
        let fee_mode = FeeMode::try_from(mode)?;
        match fee_mode {
            FeeMode::Bps => {
                let fee = (amount as u128)
                    .checked_mul(value as u128)
                    .and_then(|v| v.checked_div(10_000))
                    .ok_or::<ProgramError>(TokenizerError::MathOverflow.into())? as u64;
                Ok(fee)
            }
            FeeMode::Flat => {
                Ok(value.min(amount))
            }
        }
    }

    pub fn is_mint_accepted(&self, mint: &[u8; 32]) -> bool {
        let count = self.accepted_mint_count as usize;
        for i in 0..count {
            if &self.accepted_mints[i] == mint {
                return true;
            }
        }
        false
    }
}
