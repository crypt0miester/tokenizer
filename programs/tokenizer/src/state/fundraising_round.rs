use pinocchio::Address;

use super::{RoundStatus, FUNDRAISING_ROUND_SEED};

/// Fundraising round for an asset. Holds configuration, timing, and progress.
/// Escrow token account holds deposited stablecoins until finalization.
/// PDA: ["fundraising_round", asset.key(), &round_index.to_le_bytes()]
#[repr(C)]
pub struct FundraisingRound {
    // Discriminator
    pub account_key: u8,              // AccountKey::FundraisingRound
    pub version: u8,

    // Identity
    pub round_index: u32,             // Sequential per asset
    pub asset: [u8; 32],             // Parent Asset PDA
    pub organization: [u8; 32],      // Parent Organization PDA

    // Round configuration
    pub shares_offered: u64,          // Total shares available in this round
    pub price_per_share: u64,         // Price in smallest stablecoin units
    pub accepted_mint: [u8; 32],     // Which stablecoin
    pub min_raise: u64,               // Minimum total raise for success
    pub max_raise: u64,               // Maximum total raise (hard cap)
    pub min_per_wallet: u64,          // Min investment per wallet (0 = no min)
    pub max_per_wallet: u64,          // Max investment per wallet (0 = no max)

    // Timing
    pub start_time: i64,              // Unix timestamp — investments accepted from
    pub end_time: i64,                // Unix timestamp — investments accepted until

    // Status
    pub status: u8,                   // RoundStatus

    // Escrow
    pub escrow: [u8; 32],            // Escrow token account address

    // Progress
    pub total_raised: u64,            // Total stablecoins deposited
    pub shares_sold: u64,             // Total shares reserved by investors
    pub investor_count: u32,          // Number of unique investors
    pub investors_settled: u32,       // Investors minted (success) or refunded (fail/cancel)

    // Timestamps
    pub created_at: i64,
    pub updated_at: i64,

    // PDA bumps
    pub bump: u8,
    pub escrow_bump: u8,

    /// Wallet that receives the org share of funds at finalization.
    /// Set at round creation: governance native_treasury if governance exists, else org.authority.
    pub treasury: [u8; 32],

    // Terms & Conditions fields

    /// Unix timestamp until which tokens minted from this round are locked. 0 = no lockup.
    pub lockup_end: i64,

    /// SHA-256 hash of the terms & conditions document investors must agree to.
    pub terms_hash: [u8; 32],
}

impl FundraisingRound {
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
        round_index: u32,
        program_id: &Address,
    ) -> (Address, u8) {
        Address::find_program_address(
            &[FUNDRAISING_ROUND_SEED, asset, &round_index.to_le_bytes()],
            program_id,
        )
    }

    #[inline(always)]
    pub fn status(&self) -> RoundStatus {
        unsafe { core::mem::transmute(self.status) }
    }
}
