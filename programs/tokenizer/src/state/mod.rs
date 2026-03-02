pub mod protocol_config;
pub mod organization;
pub mod asset;
pub mod asset_token;
pub mod fundraising_round;
pub mod investment;
pub mod listing;
pub mod offer;
pub mod dividend_distribution;
pub mod emergency_record;
pub mod registrar;
pub mod voter_weight_record;
pub mod max_voter_weight_record;
pub mod buyout_offer;

use pinocchio::error::ProgramError;

use crate::error::TokenizerError;

// PDA seeds
pub const PROTOCOL_CONFIG_SEED: &[u8] = b"protocol_config";
pub const ORGANIZATION_SEED: &[u8] = b"organization";
pub const ASSET_SEED: &[u8] = b"asset";
pub const ASSET_TOKEN_SEED: &[u8] = b"asset_token";
pub const COLLECTION_AUTHORITY_SEED: &[u8] = b"collection_authority";
pub const FUNDRAISING_ROUND_SEED: &[u8] = b"fundraising_round";
pub const INVESTMENT_SEED: &[u8] = b"investment";
pub const ESCROW_SEED: &[u8] = b"escrow";
pub const LISTING_SEED: &[u8] = b"listing";
pub const OFFER_SEED: &[u8] = b"offer";
pub const OFFER_ESCROW_SEED: &[u8] = b"offer_escrow";
pub const DIVIDEND_DISTRIBUTION_SEED: &[u8] = b"dividend_distribution";
pub const DISTRIBUTION_ESCROW_SEED: &[u8] = b"distribution_escrow";
pub const EMERGENCY_RECORD_SEED: &[u8] = b"emergency_record";
pub const REGISTRAR_SEED: &[u8] = b"registrar";
pub const VOTER_WEIGHT_RECORD_SEED: &[u8] = b"voter-weight-record";
pub const MAX_VOTER_WEIGHT_RECORD_SEED: &[u8] = b"max-voter-weight-record";
pub const BUYOUT_OFFER_SEED: &[u8] = b"buyout_offer";
pub const BUYOUT_ESCROW_SEED: &[u8] = b"buyout_escrow";

/// Account type discriminator — first byte of every account.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum AccountKey {
    Uninitialized = 0,
    ProtocolConfig = 1,
    Organization = 2,
    Asset = 3,
    AssetToken = 4,
    FundraisingRound = 5,
    Investment = 6,
    Listing = 7,
    Offer = 8,
    DividendDistribution = 9,
    EmergencyRecord = 10,
    Registrar = 11,
    BuyoutOffer = 12,
}

impl AccountKey {
    /// Minimum account data length for safe struct loads.
    pub fn min_data_len(&self) -> usize {
        match self {
            AccountKey::Uninitialized => 1,
            AccountKey::ProtocolConfig => protocol_config::ProtocolConfig::LEN,
            AccountKey::Organization => organization::Organization::LEN,
            AccountKey::Asset => asset::Asset::LEN,
            AccountKey::AssetToken => asset_token::AssetToken::LEN,
            AccountKey::FundraisingRound => fundraising_round::FundraisingRound::LEN,
            AccountKey::Investment => investment::Investment::LEN,
            AccountKey::Listing => listing::Listing::LEN,
            AccountKey::Offer => offer::Offer::LEN,
            AccountKey::DividendDistribution => dividend_distribution::DividendDistribution::LEN,
            AccountKey::EmergencyRecord => emergency_record::EmergencyRecord::LEN,
            AccountKey::Registrar => registrar::Registrar::LEN,
            AccountKey::BuyoutOffer => buyout_offer::BuyoutOffer::LEN,
        }
    }
}

/// Validate the account discriminator byte and minimum data length.
#[inline(always)]
pub fn validate_account_key(data: &[u8], expected: AccountKey) -> Result<(), ProgramError> {
    if data.len() < expected.min_data_len() || data[0] != expected as u8 {
        let got = if data.is_empty() { 255 } else { data[0] };
        pinocchio_log::log!("account_key: expected {}, got {} (len={})", expected as u8, got, data.len());
        return Err(TokenizerError::InvalidAccountKey.into());
    }
    Ok(())
}

/// Asset lifecycle status.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum AssetStatus {
    Draft = 0,
    Fundraising = 1,
    Active = 2,
    Suspended = 3,
    Closed = 4,
}

impl TryFrom<u8> for AssetStatus {
    type Error = ProgramError;
    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Self::Draft),
            1 => Ok(Self::Fundraising),
            2 => Ok(Self::Active),
            3 => Ok(Self::Suspended),
            4 => Ok(Self::Closed),
            _ => Err(TokenizerError::InvalidAssetStatus.into()),
        }
    }
}

/// Fundraising round lifecycle status.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum RoundStatus {
    Active = 0,
    Succeeded = 1,
    Failed = 2,
    Cancelled = 3,
}

impl TryFrom<u8> for RoundStatus {
    type Error = ProgramError;
    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Self::Active),
            1 => Ok(Self::Succeeded),
            2 => Ok(Self::Failed),
            3 => Ok(Self::Cancelled),
            _ => Err(TokenizerError::InvalidRoundStatus.into()),
        }
    }
}

/// Secondary market listing status.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ListingStatus {
    Active = 0,
    Sold = 1,
    Cancelled = 2,
}

impl TryFrom<u8> for ListingStatus {
    type Error = ProgramError;
    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Self::Active),
            1 => Ok(Self::Sold),
            2 => Ok(Self::Cancelled),
            _ => Err(TokenizerError::InvalidListingStatus.into()),
        }
    }
}

/// Recovery reason for emergency burn_and_remint operations.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum RecoveryReason {
    LostKeys = 0,
    CourtOrder = 1,
    EstateSettlement = 2,
    BankruptcySeizure = 3,
    RegulatoryOrder = 4,
    CorporateAction = 5,
}

/// Secondary market offer status.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum OfferStatus {
    Active = 0,
    Accepted = 1,
    Rejected = 2,
    Cancelled = 3,
}

impl TryFrom<u8> for OfferStatus {
    type Error = ProgramError;
    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Self::Active),
            1 => Ok(Self::Accepted),
            2 => Ok(Self::Rejected),
            3 => Ok(Self::Cancelled),
            _ => Err(TokenizerError::InvalidOfferStatus.into()),
        }
    }
}

/// Buyout offer lifecycle status.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum BuyoutStatus {
    Pending = 0,
    Funded = 1,
    Approved = 2,
    Completed = 3,
    Cancelled = 4,
}

impl TryFrom<u8> for BuyoutStatus {
    type Error = ProgramError;
    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Self::Pending),
            1 => Ok(Self::Funded),
            2 => Ok(Self::Approved),
            3 => Ok(Self::Completed),
            4 => Ok(Self::Cancelled),
            _ => Err(TokenizerError::InvalidAssetStatus.into()),
        }
    }
}

/// How to handle remaining treasury funds during buyout.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum TreasuryDisposition {
    ToHolders = 0,
    ToOrganization = 1,
    ToBuyer = 2,
    ToProtocol = 3,
}

impl TryFrom<u8> for TreasuryDisposition {
    type Error = ProgramError;
    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Self::ToHolders),
            1 => Ok(Self::ToOrganization),
            2 => Ok(Self::ToBuyer),
            3 => Ok(Self::ToProtocol),
            _ => Err(TokenizerError::InvalidAssetStatus.into()),
        }
    }
}

/// Fee calculation mode for organization fees.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum FeeMode {
    Bps = 0,
    Flat = 1,
}

impl TryFrom<u8> for FeeMode {
    type Error = ProgramError;
    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Self::Bps),
            1 => Ok(Self::Flat),
            _ => Err(TokenizerError::InvalidAssetStatus.into()),
        }
    }
}
