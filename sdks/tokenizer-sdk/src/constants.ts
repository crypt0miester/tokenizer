import { type Address, address } from "gill";

// ── Program IDs ──────────────────────────────────────────────────────

/** Tokenizer program ID. Override per-function if using a different deployment. */
export const TOKENIZER_PROGRAM_ID: Address = address(
  "11111111111111111111111111111111", // TODO: replace with deployed program ID
);

export const MPL_CORE_PROGRAM_ID: Address = address("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");

// ── PDA Seeds ────────────────────────────────────────────────────────
// Mirrors programs/tokenizer/src/state/mod.rs

export const PROTOCOL_CONFIG_SEED = "protocol_config";
export const ORGANIZATION_SEED = "organization";
export const ASSET_SEED = "asset";
export const ASSET_TOKEN_SEED = "asset_token";
export const COLLECTION_AUTHORITY_SEED = "collection_authority";
export const FUNDRAISING_ROUND_SEED = "fundraising_round";
export const INVESTMENT_SEED = "investment";
export const ESCROW_SEED = "escrow";
export const LISTING_SEED = "listing";
export const OFFER_SEED = "offer";
export const OFFER_ESCROW_SEED = "offer_escrow";
export const DIVIDEND_DISTRIBUTION_SEED = "dividend_distribution";
export const DISTRIBUTION_ESCROW_SEED = "distribution_escrow";
export const EMERGENCY_RECORD_SEED = "emergency_record";
export const REGISTRAR_SEED = "registrar";
export const VOTER_WEIGHT_RECORD_SEED = "voter-weight-record";
export const MAX_VOTER_WEIGHT_RECORD_SEED = "max-voter-weight-record";
export const PROPOSAL_SEED = "proposal_seed";
export const VOTE_RECORD_SEED = "vote_record";
export const BUYOUT_OFFER_SEED = "buyout_offer";
export const BUYOUT_ESCROW_SEED = "buyout_escrow";

// ── Instruction Discriminants ────────────────────────────────────────
// u16 little-endian, first 2 bytes of instruction data.
// Mirrors the match in programs/tokenizer/src/lib.rs

export enum InstructionType {
  // Protocol
  Initialize = 0,
  UpdateConfig = 1,
  Pause = 2,
  Unpause = 3,
  // Organization
  Register = 10,
  Deregister = 11,
  UpdateOrg = 12,
  // Asset
  InitAsset = 20,
  MintToken = 21,
  UpdateMetadata = 22,
  // Fundraising
  CreateRound = 30,
  Invest = 31,
  FinalizeRound = 32,
  MintRoundTokens = 33,
  RefundInvestment = 34,
  CancelRound = 35,
  // Market
  ListForSale = 40,
  Delist = 41,
  BuyListedToken = 42,
  MakeOffer = 43,
  AcceptOffer = 44,
  RejectOffer = 45,
  CancelOffer = 46,
  Consolidate = 47,
  TransferToken = 48,
  // Distribution
  CreateDistribution = 50,
  ClaimDistribution = 51,
  CloseDistribution = 52,
  // Emergency
  BurnAndRemint = 60,
  SplitAndRemint = 61,
  // Governance
  CreateRegistrar = 70,
  CreateVoterWeightRecord = 71,
  CreateMaxVoterWeightRecord = 72,
  UpdateVoterWeightRecord = 73,
  RelinquishVoterWeight = 74,
  CreateProtocolRealm = 75,
  CreateOrgRealm = 76,
  CreateAssetGovernance = 77,
  // Buyout
  CreateBuyoutOffer = 85,
  FundBuyoutOffer = 86,
  ApproveBuyout = 87,
  SettleBuyout = 88,
  CompleteBuyout = 89,
  CancelBuyout = 90,
}

// ── On-chain Enums ───────────────────────────────────────────────────

export enum AssetStatus {
  Draft = 0,
  Fundraising = 1,
  Active = 2,
  Suspended = 3,
  Closed = 4,
}

export enum RoundStatus {
  Active = 0,
  Succeeded = 1,
  Failed = 2,
  Cancelled = 3,
}

export enum ListingStatus {
  Active = 0,
  Sold = 1,
  Cancelled = 2,
}

export enum OfferStatus {
  Active = 0,
  Accepted = 1,
  Rejected = 2,
  Cancelled = 3,
}

export enum AccountKey {
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
  VoteRecord = 13,
}

export enum TransferPolicy {
  NonTransferable = 0,
  Transferable = 1,
}

export enum BuyoutStatus {
  Pending = 0,
  Funded = 1,
  Approved = 2,
  Completed = 3,
  Cancelled = 4,
}

export enum TreasuryDisposition {
  ToHolders = 0,
  ToOrganization = 1,
  ToBuyer = 2,
  ToProtocol = 3,
}

export enum FeeMode {
  Bps = 0,
  Flat = 1,
}

export enum RecoveryReason {
  LostKeys = 0,
  CourtOrder = 1,
  EstateSettlement = 2,
  BankruptcySeizure = 3,
  RegulatoryOrder = 4,
  CorporateAction = 5,
}

// ── Size Constants ───────────────────────────────────────────────────

export const MAX_ACCEPTED_MINTS = 4;
export const MAX_ORG_ACCEPTED_MINTS = 4;
export const MAX_ORG_NAME_LEN = 64;
export const MAX_REG_NUMBER_LEN = 32;
export const SPL_TOKEN_ACCOUNT_LEN = 165;

// ── Helpers ──────────────────────────────────────────────────────────

/** Encode a u16 discriminant as 2-byte LE Uint8Array. */
export function encodeDiscriminant(ix: InstructionType): Uint8Array {
  const buf = new Uint8Array(2);
  buf[0] = ix & 0xff;
  buf[1] = (ix >> 8) & 0xff;
  return buf;
}

/** Encode a u32 as 4-byte LE Uint8Array (for PDA seeds). */
export function u32ToLeBytes(value: number): Uint8Array {
  const buf = new Uint8Array(4);
  const view = new DataView(buf.buffer);
  view.setUint32(0, value, true);
  return buf;
}
