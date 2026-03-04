use pinocchio::Address;

use super::BUYOUT_OFFER_SEED;

/// Full buyout offer for an asset.
/// PDA: ["buyout_offer", asset.key(), buyer.key()]
#[repr(C)]
pub struct BuyoutOffer {
    pub account_key: u8,              // 0
    pub version: u8,                  // 1
    pub buyer: [u8; 32],              // 2
    pub asset: [u8; 32],              // 34
    // pad 6 bytes                    // 66-71
    pub price_per_share: u64,         // 72
    pub accepted_mint: [u8; 32],      // 80
    pub escrow: [u8; 32],             // 112
    pub treasury_disposition: u8,     // 144
    pub terms_hash: [u8; 32],         // 145
    pub broker: [u8; 32],             // 177
    // pad 1 byte                     // 209
    pub broker_bps: u16,              // 210
    // pad 4 bytes                    // 212-215
    pub broker_amount: u64,           // 216
    pub minted_shares: u64,           // 224
    pub shares_settled: u64,          // 232
    pub treasury_amount: u64,         // 240
    pub status: u8,                   // 248
    pub is_council_buyout: u8,        // 249
    // pad 6 bytes                    // 250-255
    pub expires_at: i64,              // 256
    pub created_at: i64,              // 264
    pub updated_at: i64,              // 272
    pub bump: u8,                     // 280
    pub rent_payer: [u8; 32],         // 281
    // trailing pad updated by repr(C)
}

impl BuyoutOffer {
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
        buyer: &[u8; 32],
        program_id: &Address,
    ) -> (Address, u8) {
        Address::find_program_address(
            &[BUYOUT_OFFER_SEED, asset, buyer],
            program_id,
        )
    }
}
