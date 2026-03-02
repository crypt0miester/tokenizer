use pinocchio::Address;

use super::LISTING_SEED;

/// Secondary market listing for an AssetToken.
/// PDA: ["listing", asset_token.key()]
#[repr(C)]
pub struct Listing {
    // Discriminator
    pub account_key: u8,          // AccountKey::Listing
    pub version: u8,

    // References
    pub asset_token: [u8; 32],   // AssetToken PDA being listed
    pub asset: [u8; 32],         // Parent Asset PDA
    pub seller: [u8; 32],        // Token owner wallet

    // Payment
    pub accepted_mint: [u8; 32], // Stablecoin mint

    // Terms
    pub shares_for_sale: u64,
    pub price_per_share: u64,
    pub expiry: i64,              // 0 = no expiry

    // State
    pub status: u8,               // ListingStatus
    pub is_partial: u8,           // Allow partial buys?

    // Timestamps
    pub created_at: i64,

    // PDA
    pub bump: u8,
}

impl Listing {
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
        program_id: &Address,
    ) -> (Address, u8) {
        Address::find_program_address(
            &[LISTING_SEED, asset_token],
            program_id,
        )
    }
}
