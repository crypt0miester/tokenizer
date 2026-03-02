use pinocchio::Address;

use super::INVESTMENT_SEED;

/// Per-investor-per-round investment record.
/// Tracks deposit amount and settlement status.
/// PDA: ["investment", round.key(), investor.key()]
#[repr(C)]
pub struct Investment {
    // Discriminator
    pub account_key: u8,              // AccountKey::Investment
    pub version: u8,

    // References
    pub round: [u8; 32],             // FundraisingRound PDA
    pub investor: [u8; 32],          // Investor wallet

    // Investment details
    pub shares_reserved: u64,         // Number of shares reserved
    pub amount_deposited: u64,        // Stablecoin amount deposited

    // Settlement flags
    pub is_minted: u8,                // 0 = pending, 1 = NFT minted
    pub is_refunded: u8,              // 0 = pending, 1 = funds refunded

    // Timestamps
    pub created_at: i64,
    pub updated_at: i64,

    // PDA
    pub bump: u8,
}

impl Investment {
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
        round: &[u8; 32],
        investor: &[u8; 32],
        program_id: &Address,
    ) -> (Address, u8) {
        Address::find_program_address(
            &[INVESTMENT_SEED, round, investor],
            program_id,
        )
    }
}
