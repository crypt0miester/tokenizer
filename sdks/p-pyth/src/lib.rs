//! p-pyth: Minimal pinocchio-compatible Pyth price feed reader
//!
//! This crate provides a minimal implementation for reading Pyth price feeds
//! on Solana using pinocchio. It only includes the fields necessary for
//! price reading, not the full publisher component array.
//!
//! # Example
//! ```ignore
//! use p_pyth::{PythPriceAccount, OraclePrice};
//! use pinocchio::account_info::AccountInfo;
//!
//! fn read_price(pyth_account: &AccountInfo, current_slot: u64) -> Option<OraclePrice> {
//!     let data = pyth_account.try_borrow_data().ok()?;
//!     let price_account = unsafe { PythPriceAccount::load(&data) }.ok()?;
//!     price_account.get_price_no_older_than(current_slot, 30) // 30 slots max staleness
//! }
//! ```

#![cfg_attr(not(test), no_std)]

// Required for no_std when building as standalone (not for tests or when using this as a lib)
#[cfg(all(not(feature = "no-panic-handler"), not(test)))]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}

use pinocchio::error::ProgramError;


// CONSTANTS


/// Pyth magic number for account validation
pub const PYTH_MAGIC: u32 = 0xa1b2c3d4;

/// Pyth version number (must be 2)
pub const PYTH_VERSION: u32 = 2;

/// Account type for Price accounts
pub const PYTH_PRICE_ACCOUNT_TYPE: u32 = 3;

/// Price status indicating the feed is actively trading
pub const PRICE_STATUS_TRADING: u8 = 1;

/// Minimum data length required (header up to and including agg)
pub const MIN_PRICE_ACCOUNT_LEN: usize = 240;


// ERROR CODES


/// Pyth-specific error codes
#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PythError {
    /// Account data is invalid or too short
    InvalidAccountData = 0,
    /// Magic number doesn't match
    InvalidMagic = 1,
    /// Version number is not supported
    InvalidVersion = 2,
    /// Account type is not a Price account
    InvalidAccountType = 3,
    /// Price is stale (exceeds max age)
    StalePrice = 4,
    /// Price status is not Trading
    NotTrading = 5,
}

impl From<PythError> for ProgramError {
    fn from(e: PythError) -> Self {
        ProgramError::Custom(6100 + e as u32)
    }
}


// DATA STRUCTURES


/// Rational number representation used by Pyth for EMA values
///
/// Layout: 24 bytes
/// - val: i64 (8 bytes) - the value
/// - numer: i64 (8 bytes) - numerator
/// - denom: i64 (8 bytes) - denominator
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct Rational {
    pub val: i64,
    pub numer: i64,
    pub denom: i64,
}

/// Price information for aggregate or publisher prices
///
/// Layout: 32 bytes
/// - price: i64 (8 bytes, offset 0)
/// - conf: u64 (8 bytes, offset 8)
/// - status: u8 (1 byte, offset 16)
/// - corp_act: u8 (1 byte, offset 17)
/// - _padding: [u8; 6] (6 bytes, offset 18)
/// - pub_slot: u64 (8 bytes, offset 24)
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct PriceInfo {
    /// The price
    pub price: i64,
    /// Confidence interval around the price
    pub conf: u64,
    /// Price status (1 = Trading)
    pub status: u8,
    /// Corporate action status
    pub corp_act: u8,
    /// Padding for alignment
    pub _padding: [u8; 6],
    /// Slot when this price was published
    pub pub_slot: u64,
}

impl PriceInfo {
    /// Check if the price status is Trading
    #[inline]
    pub fn is_trading(&self) -> bool {
        self.status == PRICE_STATUS_TRADING
    }
}

/// Pyth Price Account header (minimal, 240 bytes)
///
/// This struct represents the header portion of a Pyth price account,
/// containing all fields necessary for reading the current price.
/// The publisher component array (comp) is NOT included.
///
/// ## Byte Layout
/// ```text
/// Offset  Size  Field
/// ------  ----  -----
/// 0       4     magic
/// 4       4     ver
/// 8       4     atype
/// 12      4     size
/// 16      1     ptype
/// 17      3     _pad1
/// 20      4     expo
/// 24      4     num
/// 28      4     num_qt
/// 32      8     last_slot
/// 40      8     valid_slot
/// 48      24    ema_price
/// 72      24    ema_conf
/// 96      8     timestamp
/// 104     1     min_pub
/// 105     1     drv2
/// 106     2     drv3
/// 108     4     drv4
/// 112     32    prod
/// 144     32    next
/// 176     8     prev_slot
/// 184     8     prev_price
/// 192     8     prev_conf
/// 200     8     prev_timestamp
/// 208     32    agg
/// ------
/// Total: 240 bytes
/// ```
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct PythPriceAccount {
    /// Pyth magic number (0xa1b2c3d4)
    pub magic: u32,
    /// Program version (must be 2)
    pub ver: u32,
    /// Account type (3 = Price)
    pub atype: u32,
    /// Account size
    pub size: u32,
    /// Price type
    pub ptype: u8,
    /// Padding for alignment
    pub _pad1: [u8; 3],
    /// Price exponent (e.g., -8 means price is in units of 10^-8)
    pub expo: i32,
    /// Number of component prices
    pub num: u32,
    /// Number of quoters
    pub num_qt: u32,
    /// Slot of last valid aggregate price
    pub last_slot: u64,
    /// Valid slot of aggregate price
    pub valid_slot: u64,
    /// Exponentially weighted moving average price
    pub ema_price: Rational,
    /// Exponentially weighted moving average confidence
    pub ema_conf: Rational,
    /// Unix timestamp of aggregate price
    pub timestamp: i64,
    /// Minimum publishers for valid price
    pub min_pub: u8,
    /// Reserved
    pub drv2: u8,
    /// Reserved
    pub drv3: u16,
    /// Reserved
    pub drv4: u32,
    /// Product account key
    pub prod: [u8; 32],
    /// Next price account in linked list
    pub next: [u8; 32],
    /// Valid slot of previous update
    pub prev_slot: u64,
    /// Aggregate price of previous update with TRADING status
    pub prev_price: i64,
    /// Confidence interval of previous update with TRADING status
    pub prev_conf: u64,
    /// Unix timestamp of previous aggregate with TRADING status
    pub prev_timestamp: i64,
    /// Current aggregate price info
    pub agg: PriceInfo,
}

// Compile-time size assertion
const _: () = assert!(core::mem::size_of::<PythPriceAccount>() == MIN_PRICE_ACCOUNT_LEN);

impl PythPriceAccount {
    /// Load a PythPriceAccount from raw account data
    ///
    /// # Safety
    /// The caller must ensure the data slice remains valid for the lifetime
    /// of the returned reference.
    ///
    /// # Errors
    /// Returns an error if:
    /// - Data is too short (< 240 bytes)
    /// - Magic number doesn't match
    /// - Version is not 2
    /// - Account type is not Price (3)
    #[inline]
    pub unsafe fn load(data: &[u8]) -> Result<&Self, PythError> {
        if data.len() < MIN_PRICE_ACCOUNT_LEN {
            return Err(PythError::InvalidAccountData);
        }

        let account = &*(data.as_ptr() as *const Self);

        if account.magic != PYTH_MAGIC {
            return Err(PythError::InvalidMagic);
        }

        if account.ver != PYTH_VERSION {
            return Err(PythError::InvalidVersion);
        }

        if account.atype != PYTH_PRICE_ACCOUNT_TYPE {
            return Err(PythError::InvalidAccountType);
        }

        Ok(account)
    }

    /// Get the current price if it's not older than the specified slot threshold
    ///
    /// This method implements Pyth's recommended staleness check:
    /// 1. If the current aggregate price is TRADING and recent, use it
    /// 2. Otherwise, fall back to the previous price if it's recent
    /// 3. If both are stale, return None
    ///
    /// # Arguments
    /// * `current_slot` - The current blockchain slot
    /// * `max_staleness_slots` - Maximum age in slots before price is considered stale
    ///
    /// # Returns
    /// Some(OraclePrice) if a valid price is found, None if all prices are stale
    #[inline]
    pub fn get_price_no_older_than(
        &self,
        current_slot: u64,
        max_staleness_slots: u64,
    ) -> Option<OraclePrice> {
        let min_valid_slot = current_slot.saturating_sub(max_staleness_slots);

        // Check current aggregate price
        if self.agg.is_trading() && self.agg.pub_slot >= min_valid_slot {
            return Some(OraclePrice {
                price: self.agg.price,
                conf: self.agg.conf,
                expo: self.expo,
                publish_time: self.timestamp,
            });
        }

        // Fallback to previous price
        if self.prev_slot >= min_valid_slot {
            return Some(OraclePrice {
                price: self.prev_price,
                conf: self.prev_conf,
                expo: self.expo,
                publish_time: self.prev_timestamp,
            });
        }

        // Both prices are stale
        None
    }

    /// Get the current price, returning an error if stale
    ///
    /// This is a convenience method that converts None to an error.
    #[inline]
    pub fn get_price_no_older_than_or_err(
        &self,
        current_slot: u64,
        max_staleness_slots: u64,
    ) -> Result<OraclePrice, PythError> {
        self.get_price_no_older_than(current_slot, max_staleness_slots)
            .ok_or(PythError::StalePrice)
    }

    /// Get the EMA (exponentially weighted moving average) price
    ///
    /// Note: EMA price doesn't have a staleness check built-in,
    /// you should still verify the account is recent using agg.pub_slot
    #[inline]
    pub fn get_ema_price(&self) -> OraclePrice {
        OraclePrice {
            price: self.ema_price.val,
            conf: self.ema_conf.val as u64,
            expo: self.expo,
            publish_time: self.timestamp,
        }
    }
}


// OUTPUT TYPES


/// Normalized price output from oracle
///
/// The actual price is: price * 10^expo
/// For example: price = 15023, expo = -2 means $150.23
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct OraclePrice {
    /// The price value (must be scaled by 10^expo)
    pub price: i64,
    /// Confidence interval (same scale as price)
    pub conf: u64,
    /// Exponent for scaling (typically negative)
    pub expo: i32,
    /// Unix timestamp when the price was published
    pub publish_time: i64,
}

impl OraclePrice {
    /// Calculate the price as a u64 scaled to a target exponent
    ///
    /// # Arguments
    /// * `target_expo` - The desired exponent (typically negative, e.g., -9 for lamports)
    ///
    /// # Returns
    /// The price scaled to the target exponent, or None if overflow/underflow
    pub fn get_price_in_target_expo(&self, target_expo: i32) -> Option<u64> {
        if self.price < 0 {
            return None; // Negative prices not supported for this conversion
        }

        let price = self.price as u64;
        let expo_diff = self.expo - target_expo;

        if expo_diff >= 0 {
            // Need to multiply (make smaller exponent)
            let multiplier = 10u64.checked_pow(expo_diff as u32)?;
            price.checked_mul(multiplier)
        } else {
            // Need to divide (make larger exponent)
            let divisor = 10u64.checked_pow((-expo_diff) as u32)?;
            Some(price / divisor)
        }
    }

    /// Get the price with confidence bounds
    ///
    /// Returns (min_price, max_price) accounting for confidence interval
    #[inline]
    pub fn get_price_with_confidence(&self) -> (i64, i64) {
        let min_price = self.price.saturating_sub(self.conf as i64);
        let max_price = self.price.saturating_add(self.conf as i64);
        (min_price, max_price)
    }

    /// Check if confidence is within acceptable threshold (basis points)
    ///
    /// # Arguments
    /// * `max_conf_bps` - Maximum confidence as basis points of price (e.g., 100 = 1%)
    ///
    /// # Returns
    /// true if confidence is within threshold
    #[inline]
    pub fn is_confidence_acceptable(&self, max_conf_bps: u16) -> bool {
        if self.price == 0 {
            return false;
        }

        // conf_pct = (conf * 10000) / |price|
        let price_abs = self.price.unsigned_abs();
        let conf_bps = (self.conf.saturating_mul(10000)) / price_abs;
        conf_bps <= max_conf_bps as u64
    }
}


// HELPER FUNCTIONS


/// Load Pyth price from account info
///
/// # Safety
/// Uses unsafe pointer cast internally
#[inline]
pub fn load_pyth_price(
    data: &[u8],
    current_slot: u64,
    max_staleness_slots: u64,
) -> Result<OraclePrice, PythError> {
    let account = unsafe { PythPriceAccount::load(data)? };
    account
        .get_price_no_older_than(current_slot, max_staleness_slots)
        .ok_or(PythError::StalePrice)
}

/// Load Pyth price with confidence check
#[inline]
pub fn load_pyth_price_with_confidence(
    data: &[u8],
    current_slot: u64,
    max_staleness_slots: u64,
    max_confidence_bps: u16,
) -> Result<OraclePrice, PythError> {
    let price = load_pyth_price(data, current_slot, max_staleness_slots)?;

    if !price.is_confidence_acceptable(max_confidence_bps) {
        return Err(PythError::NotTrading); // Reusing error - confidence too wide
    }

    Ok(price)
}


// TESTS


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_struct_sizes() {
        assert_eq!(core::mem::size_of::<Rational>(), 24);
        assert_eq!(core::mem::size_of::<PriceInfo>(), 32);
        assert_eq!(core::mem::size_of::<PythPriceAccount>(), 240);
    }

    #[test]
    fn test_price_info_layout() {
        // Verify PriceInfo field offsets
        let info = PriceInfo::default();
        let base = &info as *const _ as usize;

        assert_eq!(&info.price as *const _ as usize - base, 0);
        assert_eq!(&info.conf as *const _ as usize - base, 8);
        assert_eq!(&info.status as *const _ as usize - base, 16);
        assert_eq!(&info.corp_act as *const _ as usize - base, 17);
        assert_eq!(&info.pub_slot as *const _ as usize - base, 24);
    }

    #[test]
    fn test_oracle_price_scaling() {
        let price = OraclePrice {
            price: 15023,
            conf: 10,
            expo: -2,
            publish_time: 0,
        };

        // 15023 * 10^-2 = 150.23
        // To get in 10^-8: expo_diff = -2 - (-8) = 6
        // So multiply by 10^6: 15023 * 1_000_000 = 15_023_000_000
        assert_eq!(price.get_price_in_target_expo(-8), Some(15023000000));

        // Test the other direction (divide)
        let price2 = OraclePrice {
            price: 150230000,
            conf: 10,
            expo: -6,
            publish_time: 0,
        };
        // 150230000 * 10^-6 = 150.23
        // To get in 10^-2: expo_diff = -6 - (-2) = -4
        // So divide by 10^4: 150230000 / 10000 = 15023
        assert_eq!(price2.get_price_in_target_expo(-2), Some(15023));
    }

    #[test]
    fn test_confidence_check() {
        let price = OraclePrice {
            price: 10000,
            conf: 100, // 1% confidence
            expo: 0,
            publish_time: 0,
        };

        assert!(price.is_confidence_acceptable(100)); // 1% threshold - exactly at limit
        assert!(price.is_confidence_acceptable(200)); // 2% threshold - within
        assert!(!price.is_confidence_acceptable(50)); // 0.5% threshold - exceeds
    }
}
