use pinocchio::Address;

use super::{AssetStatus, ASSET_SEED};

/// Tokenizable asset with an associated Metaplex Core collection.
/// Metadata (name, URI) lives in the collection — not duplicated here.
/// Token count (num_minted) is tracked by the collection natively.
/// PDA: ["asset", organization.key(), &id.to_le_bytes()]
#[repr(C)]
pub struct Asset {
    // Discriminator
    pub account_key: u8,              // AccountKey::Asset
    pub version: u8,

    // Identity
    pub id: u32,
    pub organization: [u8; 32],      // Parent organization PDA

    // Metaplex Core
    pub collection: [u8; 32],        // Metaplex Core collection address

    // Shares
    pub total_shares: u64,
    pub minted_shares: u64,

    // State
    pub status: u8,                   // AssetStatus
    pub transfer_policy: u8,          // TransferPolicy (0 = NonTransferable, 1 = Transferable)

    // Pricing
    pub price_per_share: u64,         // Smallest stablecoin unit
    pub accepted_mint: [u8; 32],     // Which stablecoin

    // Dividends
    pub dividend_epoch: u32,          // Current dividend epoch

    // Fundraising
    pub fundraising_round_count: u32, // Number of rounds created for this asset

    // Timestamps
    pub created_at: i64,
    pub updated_at: i64,

    // PDA
    pub bump: u8,

    // Collection authority PDA bump (cached for CPI signing)
    pub collection_authority_bump: u8,

    /// Native treasury wallet for this asset's governance (set by create_asset_governance).
    /// Zero = no governance, funds go to org authority.
    pub native_treasury: [u8; 32],

    // Terms & Conditions fields

    /// Active buyout PDA (future buyout use). Zero = no active buyout.
    pub active_buyout: [u8; 32],

    /// Number of succeeded rounds whose tokens haven't been fully minted yet.
    pub unminted_succeeded_rounds: u32,

    /// Number of open (unclosed) dividend distributions.
    pub open_distributions: u32,

    /// Future Arcium compliance program address. Zero = none.
    pub compliance_program: [u8; 32],

    /// Minimum seconds between transfers for any token of this asset. 0 = no cooldown.
    pub transfer_cooldown: i64,

    /// Maximum number of distinct holders. 0 = unlimited.
    pub max_holders: u32,

    /// Current number of distinct holders.
    pub current_holders: u32,

    /// Unix timestamp after which asset is matured (no new rounds). 0 = no maturity.
    pub maturity_date: i64,

    /// Grace period (seconds) after maturity_date before asset expires. 0 = no grace.
    pub maturity_grace_period: i64,

    // Oracle pricing (opt-in)

    /// Oracle source: 0 = None (manual pricing), 1 = Pyth, 2 = Switchboard
    pub oracle_source: u8,
    /// Reserved for alignment after oracle_source
    pub _oracle_pad: [u8; 7],
    /// Oracle price feed account pubkey. Zeroed if oracle_source == 0.
    pub oracle_feed: [u8; 32],
    /// How many shares represent 1 unit of the underlying asset.
    /// e.g., 1000 means 1000 shares = 1 oz gold.
    /// Oracle price is divided by this to get price_per_share.
    pub shares_per_unit: u64,
    /// Unix timestamp of the last oracle price refresh.
    pub last_oracle_update: i64,
    /// Maximum staleness in slots before oracle price is rejected.
    pub oracle_max_staleness: u32,
    /// Maximum confidence/std_dev in basis points (e.g., 200 = 2%).
    /// 0 = skip confidence check.
    pub oracle_max_confidence_bps: u16,
    /// Mint decimals for accepted_mint (cached to avoid extra account read on refresh).
    pub accepted_mint_decimals: u8,
    /// Reserved for future oracle config.
    pub _oracle_reserved: u8,
}

impl Asset {
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
        organization: &[u8; 32],
        id: u32,
        program_id: &Address,
    ) -> (Address, u8) {
        Address::find_program_address(
            &[ASSET_SEED, organization, &id.to_le_bytes()],
            program_id,
        )
    }

    #[inline(always)]
    pub fn status(&self) -> AssetStatus {
        // Safe because we validate on write
        unsafe { core::mem::transmute(self.status) }
    }

    /// Returns true if the asset has reached its maturity date.
    #[inline(always)]
    pub fn is_matured(&self, now: i64) -> bool {
        self.maturity_date != 0 && now >= self.maturity_date
    }

    /// Returns true if the asset has passed maturity + grace period.
    #[inline(always)]
    pub fn is_expired(&self, now: i64) -> bool {
        self.maturity_date != 0
            && self.maturity_grace_period != 0
            && now >= self.maturity_date.saturating_add(self.maturity_grace_period)
    }
}
