import {
  type Address,
  getAddressEncoder,
  getProgramDerivedAddress,
  getUtf8Encoder,
  type ProgramDerivedAddress,
} from "gill";
import {
  ASSET_SEED,
  ASSET_TOKEN_SEED,
  BUYOUT_ESCROW_SEED,
  BUYOUT_OFFER_SEED,
  COLLECTION_AUTHORITY_SEED,
  DISTRIBUTION_ESCROW_SEED,
  DIVIDEND_DISTRIBUTION_SEED,
  EMERGENCY_RECORD_SEED,
  ESCROW_SEED,
  FUNDRAISING_ROUND_SEED,
  INVESTMENT_SEED,
  LISTING_SEED,
  MAX_VOTER_WEIGHT_RECORD_SEED,
  OFFER_ESCROW_SEED,
  OFFER_SEED,
  ORGANIZATION_SEED,
  PROPOSAL_SEED,
  PROTOCOL_CONFIG_SEED,
  REGISTRAR_SEED,
  TOKENIZER_PROGRAM_ID,
  VOTE_RECORD_SEED,
  VOTER_WEIGHT_RECORD_SEED,
  u32ToLeBytes,
} from "./constants.js";

const utf8 = getUtf8Encoder();
const addr = getAddressEncoder();

function seed(s: string) {
  return utf8.encode(s);
}

function addrSeed(a: Address) {
  return addr.encode(a);
}

// ── PDA Derivation Functions ─────────────────────────────────────────
// Each returns Promise<ProgramDerivedAddress> which is [Address, bump].

/** PDA: ["protocol_config"] */
export function getProtocolConfigPda(
  programId: Address = TOKENIZER_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [seed(PROTOCOL_CONFIG_SEED)],
  });
}

/** PDA: ["organization", u32LE(orgId)] */
export function getOrganizationPda(
  orgId: number,
  programId: Address = TOKENIZER_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [seed(ORGANIZATION_SEED), u32ToLeBytes(orgId)],
  });
}

/** PDA: ["asset", orgKey, u32LE(assetId)] */
export function getAssetPda(
  orgKey: Address,
  assetId: number,
  programId: Address = TOKENIZER_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [seed(ASSET_SEED), addrSeed(orgKey), u32ToLeBytes(assetId)],
  });
}

/** PDA: ["asset_token", assetKey, u32LE(tokenIndex)] */
export function getAssetTokenPda(
  assetKey: Address,
  tokenIndex: number,
  programId: Address = TOKENIZER_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [seed(ASSET_TOKEN_SEED), addrSeed(assetKey), u32ToLeBytes(tokenIndex)],
  });
}

/** PDA: ["collection_authority", collectionKey] */
export function getCollectionAuthorityPda(
  collectionKey: Address,
  programId: Address = TOKENIZER_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [seed(COLLECTION_AUTHORITY_SEED), addrSeed(collectionKey)],
  });
}

/** PDA: ["fundraising_round", assetKey, u32LE(roundIndex)] */
export function getFundraisingRoundPda(
  assetKey: Address,
  roundIndex: number,
  programId: Address = TOKENIZER_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [seed(FUNDRAISING_ROUND_SEED), addrSeed(assetKey), u32ToLeBytes(roundIndex)],
  });
}

/** PDA: ["investment", roundKey, investorKey] */
export function getInvestmentPda(
  roundKey: Address,
  investorKey: Address,
  programId: Address = TOKENIZER_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [seed(INVESTMENT_SEED), addrSeed(roundKey), addrSeed(investorKey)],
  });
}

/** PDA: ["escrow", roundKey] */
export function getEscrowPda(
  roundKey: Address,
  programId: Address = TOKENIZER_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [seed(ESCROW_SEED), addrSeed(roundKey)],
  });
}

/** PDA: ["listing", assetTokenKey] */
export function getListingPda(
  assetTokenKey: Address,
  programId: Address = TOKENIZER_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [seed(LISTING_SEED), addrSeed(assetTokenKey)],
  });
}

/** PDA: ["offer", assetTokenKey, buyerKey] */
export function getOfferPda(
  assetTokenKey: Address,
  buyerKey: Address,
  programId: Address = TOKENIZER_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [seed(OFFER_SEED), addrSeed(assetTokenKey), addrSeed(buyerKey)],
  });
}

/** PDA: ["offer_escrow", offerKey] */
export function getOfferEscrowPda(
  offerKey: Address,
  programId: Address = TOKENIZER_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [seed(OFFER_ESCROW_SEED), addrSeed(offerKey)],
  });
}

/** PDA: ["dividend_distribution", assetKey, u32LE(epoch)] */
export function getDistributionPda(
  assetKey: Address,
  epoch: number,
  programId: Address = TOKENIZER_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [seed(DIVIDEND_DISTRIBUTION_SEED), addrSeed(assetKey), u32ToLeBytes(epoch)],
  });
}

/** PDA: ["distribution_escrow", distributionKey] */
export function getDistributionEscrowPda(
  distributionKey: Address,
  programId: Address = TOKENIZER_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [seed(DISTRIBUTION_ESCROW_SEED), addrSeed(distributionKey)],
  });
}

/** PDA: ["emergency_record", assetTokenKey] */
export function getEmergencyRecordPda(
  assetTokenKey: Address,
  programId: Address = TOKENIZER_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [seed(EMERGENCY_RECORD_SEED), addrSeed(assetTokenKey)],
  });
}

/** PDA: ["registrar", realm, governingTokenMint] */
export function getRegistrarPda(
  realm: Address,
  governingTokenMint: Address,
  programId: Address = TOKENIZER_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [seed(REGISTRAR_SEED), addrSeed(realm), addrSeed(governingTokenMint)],
  });
}

/** PDA: ["voter-weight-record", realm, governingTokenMint, owner] */
export function getVoterWeightRecordPda(
  realm: Address,
  governingTokenMint: Address,
  owner: Address,
  programId: Address = TOKENIZER_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [
      seed(VOTER_WEIGHT_RECORD_SEED),
      addrSeed(realm),
      addrSeed(governingTokenMint),
      addrSeed(owner),
    ],
  });
}

/** PDA: ["max-voter-weight-record", realm, governingTokenMint] */
export function getMaxVoterWeightRecordPda(
  realm: Address,
  governingTokenMint: Address,
  programId: Address = TOKENIZER_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [seed(MAX_VOTER_WEIGHT_RECORD_SEED), addrSeed(realm), addrSeed(governingTokenMint)],
  });
}

/**
 * Deterministic proposal seed derived from a sequential index.
 *
 * PDA: ["proposal_seed", governance, u32LE(index)]
 *
 * Use the resulting address as `proposalSeed` in `createProposal` instead
 * of a random keypair. This lets you enumerate all proposals by index and
 * fetch them via `getMultipleAccountsInfo` — no `getProgramAccounts` needed.
 */
export function getProposalSeedPda(
  governance: Address,
  index: number,
  programId: Address = TOKENIZER_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [seed(PROPOSAL_SEED), addrSeed(governance), u32ToLeBytes(index)],
  });
}

/** PDA: ["buyout_offer", assetKey, buyerKey] */
export function getBuyoutOfferPda(
  assetKey: Address,
  buyerKey: Address,
  programId: Address = TOKENIZER_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [seed(BUYOUT_OFFER_SEED), addrSeed(assetKey), addrSeed(buyerKey)],
  });
}

/** PDA: ["buyout_escrow", buyoutOfferKey] */
export function getBuyoutEscrowPda(
  buyoutOfferKey: Address,
  programId: Address = TOKENIZER_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [seed(BUYOUT_ESCROW_SEED), addrSeed(buyoutOfferKey)],
  });
}

/** PDA: ["vote_record", assetToken] */
export function getVoteRecordPda(
  assetToken: Address,
  programId: Address = TOKENIZER_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [seed(VOTE_RECORD_SEED), addrSeed(assetToken)],
  });
}
