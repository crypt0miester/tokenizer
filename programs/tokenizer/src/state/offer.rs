use pinocchio::Address;

use super::{OFFER_SEED, OFFER_ESCROW_SEED};

/// Secondary market offer for an AssetToken.
/// PDA: ["offer", asset_token.key(), buyer.key()]
#[repr(C)]
pub struct Offer {
    // Discriminator
    pub account_key: u8,          // AccountKey::Offer
    pub version: u8,

    // References
    pub asset_token: [u8; 32],   // Target AssetToken PDA
    pub asset: [u8; 32],         // Parent Asset PDA
    pub buyer: [u8; 32],         // Buyer wallet

    // Payment
    pub accepted_mint: [u8; 32], // Stablecoin mint

    // Terms
    pub shares_requested: u64,    // 0 = all shares
    pub price_per_share: u64,

    // Timing
    pub expiry: i64,              // 0 = no expiry

    // State
    pub status: u8,               // OfferStatus

    // Escrow
    pub escrow: [u8; 32],        // Escrow token account
    pub total_deposited: u64,     // Stablecoins in escrow

    // Timestamps
    pub created_at: i64,

    // PDA
    pub bump: u8,
    pub escrow_bump: u8,
    pub rent_payer: [u8; 32],
}

impl Offer {
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
        asset_token: &[u8; 32],
        buyer: &[u8; 32],
        program_id: &Address,
    ) -> (Address, u8) {
        Address::find_program_address(
            &[OFFER_SEED, asset_token, buyer],
            program_id,
        )
    }

    pub fn derive_escrow_pda(
        offer: &[u8; 32],
        program_id: &Address,
    ) -> (Address, u8) {
        Address::find_program_address(
            &[OFFER_ESCROW_SEED, offer],
            program_id,
        )
    }
}
