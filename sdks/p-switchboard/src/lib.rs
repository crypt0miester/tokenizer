//! p-switchboard: Minimal pinocchio-compatible Switchboard on-demand pull feed reader
//!
//! Reads price data from Switchboard on-demand `PullFeedAccountData` accounts.
//! Values are i128 scaled by 10^18 (PRECISION = 18).
//!
//! Layout is derived from the official `switchboard-on-demand` v0.11.3 crate source
//! (`PullFeedAccountData`, repr(C), bytemuck::Pod).
//!
//! # Example
//! ```ignore
//! use p_switchboard::load_switchboard_price;
//!
//! let data = feed_account.try_borrow()?;
//! let price = load_switchboard_price(&data, current_slot, 100)?;
//! let usdc_price = price.get_price_in_decimals(6).unwrap();
//! ```

#![cfg_attr(not(test), no_std)]

#[cfg(all(not(feature = "no-panic-handler"), not(test)))]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}

use pinocchio::error::ProgramError;

// ── Constants ────────────────────────────────────────────────────────────────

/// Anchor discriminator for PullFeedAccountData
pub const DISCRIMINATOR: [u8; 8] = [196, 27, 108, 196, 10, 215, 219, 40];

/// Switchboard values are scaled by 10^18
pub const PRECISION: u32 = 18;

/// OracleSubmission: oracle([u8;32]) + slot(u64) + landed_at(u64) + value(i128) = 64 bytes
const SUBMISSION_SIZE: usize = 64;
const NUM_SUBMISSIONS: usize = 32;

/// CurrentResult: 6×i128 + u8 + u8 + [u8;6] + 3×u64 = 128 bytes
const CURRENT_RESULT_SIZE: usize = 128;

// Byte offsets from start of account data (after 8-byte Anchor discriminator)
// See PullFeedAccountData layout in switchboard-on-demand v0.11.3

/// submissions: [OracleSubmission; 32] = 32 × 64 = 2048 bytes
const OFF_SUBMISSIONS: usize = 8;
const OFF_AUTHORITY: usize = OFF_SUBMISSIONS + NUM_SUBMISSIONS * SUBMISSION_SIZE; // 2056
const OFF_QUEUE: usize = OFF_AUTHORITY + 32; // 2088
const OFF_FEED_HASH: usize = OFF_QUEUE + 32; // 2120
const OFF_INITIALIZED_AT: usize = OFF_FEED_HASH + 32; // 2152
const OFF_PERMISSIONS: usize = OFF_INITIALIZED_AT + 8; // 2160
const OFF_MAX_VARIANCE: usize = OFF_PERMISSIONS + 8; // 2168
const OFF_MIN_RESPONSES: usize = OFF_MAX_VARIANCE + 8; // 2176
const OFF_NAME: usize = OFF_MIN_RESPONSES + 4; // 2180
const OFF_PADDING1: usize = OFF_NAME + 32; // 2212
const OFF_PERMIT_WRITE: usize = OFF_PADDING1 + 1; // 2213
const OFF_HIST_IDX: usize = OFF_PERMIT_WRITE + 1; // 2214
const OFF_MIN_SAMPLE_SIZE: usize = OFF_HIST_IDX + 1; // 2215
const OFF_LAST_UPDATE_TS: usize = OFF_MIN_SAMPLE_SIZE + 1; // 2216
const OFF_LUT_SLOT: usize = OFF_LAST_UPDATE_TS + 8; // 2224
const OFF_RESERVED1: usize = OFF_LUT_SLOT + 8; // 2232

// CurrentResult fields
const OFF_RESULT: usize = OFF_RESERVED1 + 32; // 2264
const OFF_RESULT_VALUE: usize = OFF_RESULT; // 2264 (i128)
const OFF_RESULT_STD_DEV: usize = OFF_RESULT + 16; // 2280 (i128)
const _OFF_RESULT_MEAN: usize = OFF_RESULT + 32; // 2296 (i128)
const _OFF_RESULT_RANGE: usize = OFF_RESULT + 48; // 2312 (i128)
const _OFF_RESULT_MIN_VALUE: usize = OFF_RESULT + 64; // 2328 (i128)
const _OFF_RESULT_MAX_VALUE: usize = OFF_RESULT + 80; // 2344 (i128)
// num_samples(u8) + submission_idx(u8) + padding1([u8;6]) = 8 bytes at OFF_RESULT + 96
const OFF_RESULT_SLOT: usize = OFF_RESULT + 104; // 2368 (u64)

const OFF_MAX_STALENESS: usize = OFF_RESULT + CURRENT_RESULT_SIZE; // 2392

/// Minimum data length to read result + max_staleness
pub const MIN_PULL_FEED_LEN: usize = OFF_MAX_STALENESS + 4; // 2396

// ── Errors ───────────────────────────────────────────────────────────────────

#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SwitchboardError {
    InvalidAccountData = 0,
    InvalidDiscriminator = 1,
    StalePrice = 2,
    InvalidPrice = 3,
    ConfidenceTooWide = 4,
}

impl From<SwitchboardError> for ProgramError {
    fn from(e: SwitchboardError) -> Self {
        ProgramError::Custom(6200 + e as u32)
    }
}

// ── Output ───────────────────────────────────────────────────────────────────

/// Price output from Switchboard oracle
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SwitchboardPrice {
    /// Median price value, scaled by 10^18
    pub value: i128,
    /// Standard deviation, scaled by 10^18
    pub std_dev: i128,
    /// Slot when this result was computed
    pub result_slot: u64,
    /// Unix timestamp of last feed update
    pub last_update_timestamp: i64,
}

impl SwitchboardPrice {
    /// Convert the price to a u64 scaled to target decimal precision.
    ///
    /// Example: value = 2650.5 * 10^18, target_decimals = 6
    ///          → 2650.5 * 10^6 = 2_650_500_000
    pub fn get_price_in_decimals(&self, target_decimals: u32) -> Option<u64> {
        if self.value <= 0 {
            return None;
        }

        let value = self.value as u128;

        if target_decimals >= PRECISION {
            let multiplier = 10u128.checked_pow(target_decimals - PRECISION)?;
            u64::try_from(value.checked_mul(multiplier)?).ok()
        } else {
            let divisor = 10u128.checked_pow(PRECISION - target_decimals)?;
            u64::try_from(value / divisor).ok()
        }
    }

    /// Check if std_dev is within acceptable threshold (basis points of price).
    pub fn is_confidence_acceptable(&self, max_std_dev_bps: u16) -> bool {
        if self.value <= 0 {
            return false;
        }
        let price_abs = self.value.unsigned_abs();
        let std_dev_abs = self.std_dev.unsigned_abs();
        let bps = std_dev_abs.saturating_mul(10000) / price_abs;
        bps <= max_std_dev_bps as u128
    }
}

// ── Readers ──────────────────────────────────────────────────────────────────

#[inline(always)]
fn read_i128_le(data: &[u8], off: usize) -> i128 {
    let mut buf = [0u8; 16];
    buf.copy_from_slice(&data[off..off + 16]);
    i128::from_le_bytes(buf)
}

#[inline(always)]
fn read_i64_le(data: &[u8], off: usize) -> i64 {
    let mut buf = [0u8; 8];
    buf.copy_from_slice(&data[off..off + 8]);
    i64::from_le_bytes(buf)
}

#[inline(always)]
fn read_u64_le(data: &[u8], off: usize) -> u64 {
    let mut buf = [0u8; 8];
    buf.copy_from_slice(&data[off..off + 8]);
    u64::from_le_bytes(buf)
}

// ── Public API ───────────────────────────────────────────────────────────────

/// Validate the 8-byte Anchor discriminator.
#[inline]
pub fn validate_discriminator(data: &[u8]) -> Result<(), SwitchboardError> {
    if data.len() < 8 {
        return Err(SwitchboardError::InvalidAccountData);
    }
    if data[..8] != DISCRIMINATOR {
        return Err(SwitchboardError::InvalidDiscriminator);
    }
    Ok(())
}

/// Load Switchboard price from raw account data.
///
/// Validates discriminator, checks staleness against the result slot,
/// and extracts the median result.
///
/// The caller must verify the account is owned by the Switchboard on-demand program.
#[inline]
pub fn load_switchboard_price(
    data: &[u8],
    current_slot: u64,
    max_staleness_slots: u64,
) -> Result<SwitchboardPrice, SwitchboardError> {
    if data.len() < MIN_PULL_FEED_LEN {
        return Err(SwitchboardError::InvalidAccountData);
    }

    validate_discriminator(data)?;

    let result_slot = read_u64_le(data, OFF_RESULT_SLOT);

    if current_slot.saturating_sub(result_slot) > max_staleness_slots {
        return Err(SwitchboardError::StalePrice);
    }

    let value = read_i128_le(data, OFF_RESULT_VALUE);
    if value <= 0 {
        return Err(SwitchboardError::InvalidPrice);
    }

    Ok(SwitchboardPrice {
        value,
        std_dev: read_i128_le(data, OFF_RESULT_STD_DEV),
        result_slot,
        last_update_timestamp: read_i64_le(data, OFF_LAST_UPDATE_TS),
    })
}

/// Load Switchboard price with confidence (std_dev) check.
#[inline]
pub fn load_switchboard_price_with_confidence(
    data: &[u8],
    current_slot: u64,
    max_staleness_slots: u64,
    max_std_dev_bps: u16,
) -> Result<SwitchboardPrice, SwitchboardError> {
    let price = load_switchboard_price(data, current_slot, max_staleness_slots)?;

    if !price.is_confidence_acceptable(max_std_dev_bps) {
        return Err(SwitchboardError::ConfidenceTooWide);
    }

    Ok(price)
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn make_test_data(value: i128, std_dev: i128, result_slot: u64, timestamp: i64) -> Vec<u8> {
        let mut data = vec![0u8; MIN_PULL_FEED_LEN];
        // Write discriminator
        data[..8].copy_from_slice(&DISCRIMINATOR);
        // Write result.value
        data[OFF_RESULT_VALUE..OFF_RESULT_VALUE + 16].copy_from_slice(&value.to_le_bytes());
        // Write result.std_dev
        data[OFF_RESULT_STD_DEV..OFF_RESULT_STD_DEV + 16].copy_from_slice(&std_dev.to_le_bytes());
        // Write result.result_slot
        data[OFF_RESULT_SLOT..OFF_RESULT_SLOT + 8].copy_from_slice(&result_slot.to_le_bytes());
        // Write last_update_timestamp
        data[OFF_LAST_UPDATE_TS..OFF_LAST_UPDATE_TS + 8].copy_from_slice(&timestamp.to_le_bytes());
        data
    }

    #[test]
    fn test_offsets_are_consistent() {
        // Verify key offsets are what we calculated
        assert_eq!(OFF_SUBMISSIONS, 8);
        assert_eq!(OFF_AUTHORITY, 2056);
        assert_eq!(OFF_LAST_UPDATE_TS, 2216);
        assert_eq!(OFF_RESULT, 2264);
        assert_eq!(OFF_RESULT_VALUE, 2264);
        assert_eq!(OFF_RESULT_STD_DEV, 2280);
        assert_eq!(OFF_RESULT_SLOT, 2368);
        assert_eq!(OFF_MAX_STALENESS, 2392);
    }

    #[test]
    fn test_load_price_valid() {
        // Gold at $2650.50, scaled by 10^18
        let value: i128 = 2_650_500_000_000_000_000_000;
        let data = make_test_data(value, 1_000_000_000_000_000_000, 100, 1700000000);

        let price = load_switchboard_price(&data, 110, 50).unwrap();
        assert_eq!(price.value, value);
        assert_eq!(price.result_slot, 100);
    }

    #[test]
    fn test_load_price_stale() {
        let value: i128 = 2_650_500_000_000_000_000_000;
        let data = make_test_data(value, 0, 100, 1700000000);
        assert_eq!(
            load_switchboard_price(&data, 300, 50),
            Err(SwitchboardError::StalePrice)
        );
    }

    #[test]
    fn test_load_price_negative() {
        let data = make_test_data(-100, 0, 100, 1700000000);
        assert_eq!(
            load_switchboard_price(&data, 110, 50),
            Err(SwitchboardError::InvalidPrice)
        );
    }

    #[test]
    fn test_bad_discriminator() {
        let mut data = make_test_data(1000, 0, 100, 1700000000);
        data[0] = 0xFF;
        assert_eq!(
            load_switchboard_price(&data, 110, 50),
            Err(SwitchboardError::InvalidDiscriminator)
        );
    }

    #[test]
    fn test_price_to_usdc_decimals() {
        let price = SwitchboardPrice {
            value: 2_650_500_000_000_000_000_000, // $2650.50
            std_dev: 0,
            result_slot: 0,
            last_update_timestamp: 0,
        };
        // $2650.50 in USDC (6 decimals) = 2_650_500_000
        assert_eq!(price.get_price_in_decimals(6), Some(2_650_500_000));
    }

    #[test]
    fn test_confidence_check() {
        let price = SwitchboardPrice {
            value: 10_000_000_000_000_000_000_000, // $10000
            std_dev: 100_000_000_000_000_000_000,   // $100 = 1%
            result_slot: 0,
            last_update_timestamp: 0,
        };
        assert!(price.is_confidence_acceptable(100)); // 1% - at limit
        assert!(price.is_confidence_acceptable(200)); // 2% - within
        assert!(!price.is_confidence_acceptable(50)); // 0.5% - exceeds
    }

    #[test]
    fn test_data_too_short() {
        let data = vec![0u8; 100];
        assert_eq!(
            load_switchboard_price(&data, 100, 50),
            Err(SwitchboardError::InvalidAccountData)
        );
    }
}
