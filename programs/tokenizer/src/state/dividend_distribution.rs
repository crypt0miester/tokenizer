use pinocchio::Address;

use super::DIVIDEND_DISTRIBUTION_SEED;

/// Dividend distribution for an asset. Holds escrow with deposited stablecoins
/// and tracks total_amount / total_shares for pro-rata payout calculation.
/// PDA: ["dividend_distribution", asset.key(), &epoch.to_le_bytes()]
#[repr(C)]
pub struct DividendDistribution {
    // Discriminator
    pub account_key: u8,              // AccountKey::DividendDistribution
    pub version: u8,

    // Identity
    pub asset: [u8; 32],             // Parent Asset PDA
    pub epoch: u32,                   // Distribution epoch (matches asset.dividend_epoch at creation)

    // Distribution config
    pub accepted_mint: [u8; 32],     // Which stablecoin
    pub total_amount: u64,            // Total stablecoins deposited for distribution
    pub total_shares: u64,            // Snapshot of asset.minted_shares at creation time
    pub shares_claimed: u64,          // Running total of shares claimed so far

    // Escrow
    pub escrow: [u8; 32],            // Escrow token account address

    // Timestamps
    pub created_at: i64,

    // PDA bumps
    pub bump: u8,
    pub escrow_bump: u8,
}

impl DividendDistribution {
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
        asset: &[u8; 32],
        epoch: u32,
        program_id: &Address,
    ) -> (Address, u8) {
        Address::find_program_address(
            &[DIVIDEND_DISTRIBUTION_SEED, asset, &epoch.to_le_bytes()],
            program_id,
        )
    }
}
