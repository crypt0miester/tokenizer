/**
 * Tokenizer program error codes and decoder.
 *
 * Mirrors programs/tokenizer/src/error.rs — TokenizerError #[repr(u32)].
 * On-chain these surface as ProgramError::Custom(code).
 */

export enum TokenizerError {
  // Protocol (9000-9019)
  ProtocolAlreadyInitialized = 9000,
  ProtocolPaused = 9001,
  ProtocolNotPaused = 9002,
  InvalidFee = 9003,
  InvalidMint = 9004,
  MintAlreadyAccepted = 9005,
  MintNotAccepted = 9006,
  MaxMintsReached = 9007,
  RealmAlreadySet = 9008,
  RealmNotSet = 9009,

  // Authorization (9020-9039)
  Unauthorized = 9020,
  InvalidOperator = 9021,
  InvalidAuthority = 9022,
  MissingRequiredSignature = 9023,
  InvalidPDA = 9024,
  InvalidAccountOwner = 9025,
  InvalidAccountKey = 9026,

  // Organization (9040-9059)
  OrganizationNotActive = 9040,
  OrganizationAlreadyActive = 9041,
  OrgMintAlreadyAccepted = 9042,
  OrgMintNotAccepted = 9043,
  OrgMaxMintsReached = 9044,

  // Asset (9060-9079)
  InvalidAssetStatus = 9060,
  InvalidShareCount = 9061,
  SharesExceedTotal = 9062,
  AssetNotActive = 9063,
  InvalidMetadataUri = 9064,

  // Token (9080-9099)
  TokenNotFrozen = 9080,
  TokenAlreadyFrozen = 9081,
  InvalidTokenOwner = 9082,

  // General (9100-9119)
  MathOverflow = 9100,
  InstructionDataTooShort = 9101,
  AccountNotWritable = 9102,
  InvalidNameLength = 9104,
  InvalidRegistrationNumber = 9105,
  InvalidFieldSelector = 9106,
  NoFieldsToUpdate = 9107,
  TokenAccountDataTooShort = 9108,

  // Fundraising (9120-9149)
  RoundNotActive = 9120,
  RoundNotStarted = 9121,
  RoundEnded = 9122,
  RoundNotEnded = 9123,
  RoundNotSucceeded = 9124,
  RoundNotFailedOrCancelled = 9125,
  InvestmentAlreadyMinted = 9126,
  InvestmentAlreadyRefunded = 9127,
  InvestmentBelowMinimum = 9128,
  InvestmentAboveMaximum = 9129,
  SharesExceedOffered = 9130,
  RaiseExceedsMaximum = 9131,
  InvalidTimeRange = 9132,
  InvalidRoundConfig = 9133,
  AssetNotDraftOrActive = 9134,
  InvalidRoundStatus = 9135,
  RoundAssetMismatch = 9136,
  InvestmentRoundMismatch = 9137,
  InvestorMismatch = 9138,
  EscrowMismatch = 9139,
  InsufficientEscrowDeposit = 9140,

  // Secondary Market (9150-9189)
  TokenAlreadyListed = 9150,
  TokenNotListed = 9151,
  ListingNotActive = 9152,
  ListingExpired = 9153,
  InvalidListingPrice = 9154,
  InvalidSharesForSale = 9155,
  SharesExceedOwned = 9156,
  InvalidBuyer = 9157,
  OfferNotActive = 9158,
  OfferExpired = 9159,
  InvalidOfferPrice = 9160,
  InvalidOfferShares = 9161,
  NotTokenOwner = 9163,
  ConsolidateMinTokens = 9165,
  ConsolidateMaxTokens = 9166,
  ConsolidateAssetMismatch = 9167,
  ConsolidateOwnerMismatch = 9168,
  TokenIsListed = 9169,
  InvalidListingStatus = 9170,
  AssetNotActiveForTrading = 9171,
  InvalidFeeTreasury = 9172,
  InvalidOfferStatus = 9173,
  ListingTokenMismatch = 9174,
  OfferTokenMismatch = 9175,
  BuyerMismatch = 9176,
  TokenAssetMismatch = 9177,
  NftMismatch = 9178,
  CollectionMismatch = 9179,
  PartialBuyNotAllowed = 9180,

  // Distribution (9190-9209)
  DistributionAlreadyExists = 9190,
  AlreadyClaimed = 9191,
  NoSharesToClaim = 9192,
  DistributionAssetMismatch = 9193,
  AssetNotActiveForDistribution = 9194,
  InvalidDistributionAmount = 9195,
  InvalidDistributionEpoch = 9196,
  DistributionNotFullyClaimed = 9197,

  // Emergency (9210-9229)
  EmergencyRecordAlreadyExists = 9210,
  TokenAlreadyRecovered = 9211,
  InvalidRecipientCount = 9212,
  SharesSumMismatch = 9213,

  // Governance (9230-9259)
  GovernanceTokenLocked = 9230,
  VoterWeightRecordAlreadyExists = 9231,
  InvalidVoterWeightAction = 9232,
  ProposalNotTerminal = 9233,
  InvalidGovernanceProgram = 9234,
  InvalidRealmAuthority = 9235,
  AssetRegistrarMismatch = 9236,
  TokenAssetRegistrarMismatch = 9237,
  MinProposalWeightTooLow = 9238,
  InvalidGovernanceConfig = 9239,
  DuplicateAssetToken = 9240,

  // Buyout (9260-9289)
  BuyoutAlreadyExists = 9260,
  BuyoutPriceTooLow = 9261,
  BuyoutNotPending = 9262,
  BuyoutNotApproved = 9263,
  BuyoutNotComplete = 9264,
  BuyoutProposalNotSucceeded = 9265,
  BuyoutCouncilProposalRequired = 9266,
  BuyoutNotFunded = 9267,
  BuyoutAssetNotActive = 9268,
  BuyoutNotBuyer = 9269,
  BuyoutAlreadyApproved = 9270,
  BuyoutTreasuryNotDrained = 9271,
  BuyoutExpired = 9272,
  BuyoutUnmintedSharesExist = 9273,
  BuyoutOpenDistributions = 9274,
  BuyoutNoGovernance = 9275,
  BuyoutInvalidTreasuryDisposition = 9276,
  BuyoutBrokerBpsTooHigh = 9277,
  BuyoutBrokerIsBuyer = 9278,
  BuyoutBrokerMismatch = 9279,
  BuyoutInvalidFeeMode = 9280,
  BuyoutNotGovernanceExecuted = 9281,
  BuyoutActiveBuyoutExists = 9282,

  // Oracle (9320-9327)
  InvalidOracleSource = 9320,
  OracleNotConfigured = 9321,
  OracleFeedMismatch = 9322,
  OraclePriceStale = 9323,
  OraclePriceInvalid = 9324,
  OracleConfidenceTooWide = 9325,
  OracleConversionOverflow = 9326,
  InvalidOracleProgram = 9327,

  // Terms & Conditions (9300-9312)
  TermsHashMismatch = 9300,
  TokenLocked = 9301,
  TransferCooldownActive = 9302,
  MaxHoldersReached = 9303,
  AssetMatured = 9304,
  AssetExpired = 9305,
  InvalidRecoveryReason = 9306,
  InvalidSharesAmount = 9307,
  TokenNotTransferable = 9308,
  MaturityExtensionInvalid = 9309,
  ComplianceCheckFailed = 9310,
  ComplianceProgramMissing = 9311,
  SelfTransferNotAllowed = 9312,
  RentPayerMismatch = 9313,
}

// Error messages

const ERROR_MESSAGES: Record<number, string> = {
  // Protocol
  [TokenizerError.ProtocolAlreadyInitialized]: "Protocol config is already initialized",
  [TokenizerError.ProtocolPaused]: "Protocol is paused",
  [TokenizerError.ProtocolNotPaused]: "Protocol is not paused",
  [TokenizerError.InvalidFee]: "Fee basis points out of range",
  [TokenizerError.InvalidMint]: "Mint is not accepted by the protocol",
  [TokenizerError.MintAlreadyAccepted]: "Mint is already in the accepted list",
  [TokenizerError.MintNotAccepted]: "Mint is not in the accepted list",
  [TokenizerError.MaxMintsReached]: "Maximum accepted mints reached",
  [TokenizerError.RealmAlreadySet]: "Protocol realm is already configured",
  [TokenizerError.RealmNotSet]: "Protocol realm is not configured",

  // Authorization
  [TokenizerError.Unauthorized]: "Unauthorized",
  [TokenizerError.InvalidOperator]: "Invalid operator",
  [TokenizerError.InvalidAuthority]: "Invalid authority",
  [TokenizerError.MissingRequiredSignature]: "Missing required signature",
  [TokenizerError.InvalidPDA]: "Invalid PDA derivation",
  [TokenizerError.InvalidAccountOwner]: "Invalid account owner",
  [TokenizerError.InvalidAccountKey]: "Invalid account key discriminant",

  // Organization
  [TokenizerError.OrganizationNotActive]: "Organization is not active",
  [TokenizerError.OrganizationAlreadyActive]: "Organization is already active",
  [TokenizerError.OrgMintAlreadyAccepted]: "Mint is already accepted by the organization",
  [TokenizerError.OrgMintNotAccepted]: "Mint is not accepted by the organization",
  [TokenizerError.OrgMaxMintsReached]: "Organization maximum accepted mints reached",

  // Asset
  [TokenizerError.InvalidAssetStatus]: "Invalid asset status for this operation",
  [TokenizerError.InvalidShareCount]: "Invalid share count",
  [TokenizerError.SharesExceedTotal]: "Shares exceed total supply",
  [TokenizerError.AssetNotActive]: "Asset is not active",
  [TokenizerError.InvalidMetadataUri]: "Invalid metadata URI",

  // Token
  [TokenizerError.TokenNotFrozen]: "Token is not frozen",
  [TokenizerError.TokenAlreadyFrozen]: "Token is already frozen",
  [TokenizerError.InvalidTokenOwner]: "Invalid token owner",

  // General
  [TokenizerError.MathOverflow]: "Math overflow",
  [TokenizerError.InstructionDataTooShort]: "Instruction data too short",
  [TokenizerError.AccountNotWritable]: "Account is not writable",
  [TokenizerError.InvalidNameLength]: "Name exceeds maximum length",
  [TokenizerError.InvalidRegistrationNumber]: "Registration number exceeds maximum length",
  [TokenizerError.InvalidFieldSelector]: "Invalid field selector",
  [TokenizerError.NoFieldsToUpdate]: "No fields to update",
  [TokenizerError.TokenAccountDataTooShort]: "Token account data too short",

  // Fundraising
  [TokenizerError.RoundNotActive]: "Fundraising round is not active",
  [TokenizerError.RoundNotStarted]: "Fundraising round has not started yet",
  [TokenizerError.RoundEnded]: "Fundraising round has ended",
  [TokenizerError.RoundNotEnded]: "Fundraising round has not ended yet",
  [TokenizerError.RoundNotSucceeded]: "Fundraising round did not succeed",
  [TokenizerError.RoundNotFailedOrCancelled]: "Round is not in failed or cancelled state",
  [TokenizerError.InvestmentAlreadyMinted]: "Investment tokens already minted",
  [TokenizerError.InvestmentAlreadyRefunded]: "Investment already refunded",
  [TokenizerError.InvestmentBelowMinimum]: "Investment below minimum per wallet",
  [TokenizerError.InvestmentAboveMaximum]: "Investment above maximum per wallet",
  [TokenizerError.SharesExceedOffered]: "Shares exceed amount offered in round",
  [TokenizerError.RaiseExceedsMaximum]: "Raise exceeds maximum target",
  [TokenizerError.InvalidTimeRange]: "Invalid start/end time range",
  [TokenizerError.InvalidRoundConfig]: "Invalid round configuration",
  [TokenizerError.AssetNotDraftOrActive]: "Asset must be in draft or active status",
  [TokenizerError.InvalidRoundStatus]: "Invalid round status for this operation",
  [TokenizerError.RoundAssetMismatch]: "Round does not belong to this asset",
  [TokenizerError.InvestmentRoundMismatch]: "Investment does not belong to this round",
  [TokenizerError.InvestorMismatch]: "Investor does not match investment record",
  [TokenizerError.EscrowMismatch]: "Escrow account mismatch",
  [TokenizerError.InsufficientEscrowDeposit]: "Insufficient funds in escrow",

  // Secondary Market
  [TokenizerError.TokenAlreadyListed]: "Token is already listed for sale",
  [TokenizerError.TokenNotListed]: "Token is not listed",
  [TokenizerError.ListingNotActive]: "Listing is not active",
  [TokenizerError.ListingExpired]: "Listing has expired",
  [TokenizerError.InvalidListingPrice]: "Invalid listing price",
  [TokenizerError.InvalidSharesForSale]: "Invalid shares for sale",
  [TokenizerError.SharesExceedOwned]: "Shares exceed owned amount",
  [TokenizerError.InvalidBuyer]: "Seller cannot buy their own listing",
  [TokenizerError.OfferNotActive]: "Offer is not active",
  [TokenizerError.OfferExpired]: "Offer has expired",
  [TokenizerError.InvalidOfferPrice]: "Invalid offer price",
  [TokenizerError.InvalidOfferShares]: "Invalid offer share amount",
  [TokenizerError.NotTokenOwner]: "Not the token owner",
  [TokenizerError.ConsolidateMinTokens]: "Need at least 2 tokens to consolidate",
  [TokenizerError.ConsolidateMaxTokens]: "Too many tokens to consolidate in one transaction",
  [TokenizerError.ConsolidateAssetMismatch]: "Tokens belong to different assets",
  [TokenizerError.ConsolidateOwnerMismatch]: "Tokens belong to different owners",
  [TokenizerError.TokenIsListed]: "Cannot modify a token that is listed for sale",
  [TokenizerError.InvalidListingStatus]: "Invalid listing status for this operation",
  [TokenizerError.AssetNotActiveForTrading]: "Asset is not active for trading",
  [TokenizerError.InvalidFeeTreasury]: "Invalid fee treasury account",
  [TokenizerError.InvalidOfferStatus]: "Invalid offer status for this operation",
  [TokenizerError.ListingTokenMismatch]: "Listing does not match this token",
  [TokenizerError.OfferTokenMismatch]: "Offer does not match this token",
  [TokenizerError.BuyerMismatch]: "Buyer does not match offer",
  [TokenizerError.TokenAssetMismatch]: "Token does not belong to this asset",
  [TokenizerError.NftMismatch]: "NFT does not match asset token",
  [TokenizerError.CollectionMismatch]: "Collection does not match asset",
  [TokenizerError.PartialBuyNotAllowed]: "Partial buy not allowed on this listing",

  // Distribution
  [TokenizerError.DistributionAlreadyExists]: "Distribution already exists for this epoch",
  [TokenizerError.AlreadyClaimed]: "Distribution already claimed",
  [TokenizerError.NoSharesToClaim]: "No shares to claim distribution for",
  [TokenizerError.DistributionAssetMismatch]: "Distribution does not belong to this asset",
  [TokenizerError.AssetNotActiveForDistribution]: "Asset is not active for distribution",
  [TokenizerError.InvalidDistributionAmount]: "Invalid distribution amount",
  [TokenizerError.InvalidDistributionEpoch]: "Invalid distribution epoch",
  [TokenizerError.DistributionNotFullyClaimed]: "Distribution has not been fully claimed",

  // Emergency
  [TokenizerError.EmergencyRecordAlreadyExists]: "Emergency record already exists for this token",
  [TokenizerError.TokenAlreadyRecovered]: "Token has already been recovered",
  [TokenizerError.InvalidRecipientCount]: "Invalid recipient count",
  [TokenizerError.SharesSumMismatch]: "Recipient shares do not sum to original amount",

  // Governance
  [TokenizerError.GovernanceTokenLocked]: "Governance token is locked by an active proposal",
  [TokenizerError.VoterWeightRecordAlreadyExists]: "Voter weight record already exists",
  [TokenizerError.InvalidVoterWeightAction]: "Invalid voter weight action",
  [TokenizerError.ProposalNotTerminal]: "Proposal is not in a terminal state",
  [TokenizerError.InvalidGovernanceProgram]: "Invalid governance program",
  [TokenizerError.InvalidRealmAuthority]: "Invalid realm authority",
  [TokenizerError.AssetRegistrarMismatch]: "Asset does not match registrar",
  [TokenizerError.TokenAssetRegistrarMismatch]: "Token asset does not match registrar asset",
  [TokenizerError.MinProposalWeightTooLow]: "Minimum proposal weight below protocol threshold",
  [TokenizerError.InvalidGovernanceConfig]: "Invalid governance configuration",
  [TokenizerError.DuplicateAssetToken]: "Duplicate asset token in voter weight update",

  // Buyout
  [TokenizerError.BuyoutAlreadyExists]: "Buyout offer already exists for this asset",
  [TokenizerError.BuyoutPriceTooLow]: "Buyout price is below the minimum floor",
  [TokenizerError.BuyoutNotPending]: "Buyout offer is not in pending status",
  [TokenizerError.BuyoutNotApproved]: "Buyout offer is not approved",
  [TokenizerError.BuyoutNotComplete]: "Buyout is not complete",
  [TokenizerError.BuyoutProposalNotSucceeded]: "Buyout governance proposal did not succeed",
  [TokenizerError.BuyoutCouncilProposalRequired]: "Council buyout requires governance proposal",
  [TokenizerError.BuyoutNotFunded]: "Buyout offer is not funded",
  [TokenizerError.BuyoutAssetNotActive]: "Asset is not active for buyout",
  [TokenizerError.BuyoutNotBuyer]: "Caller is not the buyout buyer",
  [TokenizerError.BuyoutAlreadyApproved]: "Buyout is already approved",
  [TokenizerError.BuyoutTreasuryNotDrained]: "Buyout treasury has not been drained",
  [TokenizerError.BuyoutExpired]: "Buyout offer has expired",
  [TokenizerError.BuyoutUnmintedSharesExist]: "Unminted succeeded rounds exist",
  [TokenizerError.BuyoutOpenDistributions]: "Open distributions exist",
  [TokenizerError.BuyoutNoGovernance]: "Asset has no governance configured",
  [TokenizerError.BuyoutInvalidTreasuryDisposition]: "Invalid treasury disposition",
  [TokenizerError.BuyoutBrokerBpsTooHigh]: "Broker basis points too high",
  [TokenizerError.BuyoutBrokerIsBuyer]: "Broker cannot be the buyer",
  [TokenizerError.BuyoutBrokerMismatch]: "Broker account mismatch",
  [TokenizerError.BuyoutInvalidFeeMode]: "Invalid fee mode",
  [TokenizerError.BuyoutNotGovernanceExecuted]: "Buyout not executed through governance",
  [TokenizerError.BuyoutActiveBuyoutExists]: "An active buyout already exists for this asset",

  // Oracle
  [TokenizerError.InvalidOracleSource]: "Invalid oracle source value",
  [TokenizerError.OracleNotConfigured]: "Oracle feed is not configured",
  [TokenizerError.OracleFeedMismatch]: "Oracle feed account does not match instruction data",
  [TokenizerError.OraclePriceStale]: "Oracle price is stale",
  [TokenizerError.OraclePriceInvalid]: "Oracle price is invalid or negative",
  [TokenizerError.OracleConfidenceTooWide]: "Oracle confidence interval is too wide",
  [TokenizerError.OracleConversionOverflow]: "Oracle price conversion overflow",
  [TokenizerError.InvalidOracleProgram]: "Oracle feed account is not owned by the expected oracle program",

  // Terms & Conditions
  [TokenizerError.TermsHashMismatch]: "Terms hash does not match the round's terms",
  [TokenizerError.TokenLocked]: "Token is locked until lockup period ends",
  [TokenizerError.TransferCooldownActive]: "Transfer cooldown period has not elapsed",
  [TokenizerError.MaxHoldersReached]: "Maximum number of holders reached",
  [TokenizerError.AssetMatured]: "Asset has reached its maturity date",
  [TokenizerError.AssetExpired]: "Asset has expired past maturity + grace period",
  [TokenizerError.InvalidRecoveryReason]: "Invalid recovery reason code",
  [TokenizerError.InvalidSharesAmount]: "Invalid shares amount for transfer",
  [TokenizerError.TokenNotTransferable]: "Token is not transferable",
  [TokenizerError.MaturityExtensionInvalid]: "Invalid maturity date extension",
  [TokenizerError.ComplianceCheckFailed]: "Compliance check failed",
  [TokenizerError.ComplianceProgramMissing]: "Compliance program is not set",
  [TokenizerError.SelfTransferNotAllowed]: "Self-transfer is not allowed",
  [TokenizerError.RentPayerMismatch]: "Rent destination does not match the original rent payer",
};

// Decoded error type

export interface DecodedError {
  code: number;
  name: string;
  message: string;
}

// Decoder

/** Build a reverse lookup: code → enum name. */
const ERROR_NAMES: Record<number, string> = {};
for (const key of Object.keys(TokenizerError)) {
  const code = TokenizerError[key as keyof typeof TokenizerError];
  if (typeof code === "number") {
    ERROR_NAMES[code] = key;
  }
}

/**
 * Decode a custom program error code into a typed error object.
 * Returns null if the code is not a known TokenizerError.
 */
export function decodeError(code: number): DecodedError | null {
  const name = ERROR_NAMES[code];
  if (!name) return null;
  return { code, name, message: ERROR_MESSAGES[code] ?? name };
}

/**
 * Check whether a custom error code belongs to the tokenizer program.
 */
export function isTokenizerError(code: number): boolean {
  return code in ERROR_NAMES;
}
