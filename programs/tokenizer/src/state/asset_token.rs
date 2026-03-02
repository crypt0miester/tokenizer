use pinocchio::Address;

use super::ASSET_TOKEN_SEED;

/// Per-holder token record tracking shares and provenance.
/// PDA: ["asset_token", asset.key(), &token_index.to_le_bytes()]
#[repr(C)]
pub struct AssetToken {
    // Discriminator
    pub account_key: u8,          // AccountKey::AssetToken
    pub version: u8,

    // References
    pub asset: [u8; 32],         // Parent Asset PDA
    pub nft: [u8; 32],           // Metaplex Core asset (NFT) address
    pub owner: [u8; 32],         // Current owner wallet

    // Shares
    pub shares: u64,

    // State
    pub is_listed: u8,            // 0 = not listed, 1 = listed
    pub active_votes: u8,         // 0 = free, >0 = participating in N governance votes

    // Provenance
    pub parent_token: [u8; 32],  // Zero = original mint, else parent AssetToken PDA

    // Dividends
    pub last_claimed_epoch: u32,

    // Index
    pub token_index: u32,         // Sequential within the asset

    // Timestamps
    pub created_at: i64,

    // PDA
    pub bump: u8,

    // ── Terms & Conditions fields ──

    /// Unix timestamp until which this token is locked (cannot be listed/transferred). 0 = no lockup.
    pub lockup_end: i64,

    /// Unix timestamp of the last transfer (sale, offer acceptance, mint, recovery).
    pub last_transfer_at: i64,

    /// Cost basis per share in smallest stablecoin units. 0 = unknown/not set.
    pub cost_basis_per_share: u64,
}

impl AssetToken {
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
        token_index: u32,
        program_id: &Address,
    ) -> (Address, u8) {
        Address::find_program_address(
            &[ASSET_TOKEN_SEED, asset, &token_index.to_le_bytes()],
            program_id,
        )
    }

    #[inline(always)]
    pub fn is_listed(&self) -> bool {
        self.is_listed != 0
    }

    #[inline(always)]
    pub fn has_active_votes(&self) -> bool {
        self.active_votes != 0
    }

    /// Returns true if this token can be transferred/listed given lockup and cooldown.
    #[inline(always)]
    pub fn is_transferable(&self, now: i64, cooldown: i64) -> bool {
        (self.lockup_end == 0 || now >= self.lockup_end)
            && (cooldown == 0 || now - self.last_transfer_at >= cooldown)
    }
}
