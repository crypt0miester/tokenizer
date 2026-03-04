/**
 * Account byte builders for unit testing decoders.
 *
 * Each builder creates a correctly-sized Uint8Array matching the #[repr(C)]
 * layout defined in the corresponding account module. Fields have sensible
 * defaults; pass overrides for the values you care about.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { AccountKey } from "../../src/constants.js";
import {
  MplCoreKey,
  UpdateAuthorityType,
} from "../../src/external/mpl-core/constants.js";

// Encoding Helpers──

function writeU8(buf: Uint8Array, offset: number, v: number): void {
  buf[offset] = v & 0xff;
}

function writeU16LE(buf: Uint8Array, offset: number, v: number): void {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  dv.setUint16(offset, v, true);
}

function writeU32LE(buf: Uint8Array, offset: number, v: number): void {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  dv.setUint32(offset, v, true);
}

function writeU64LE(buf: Uint8Array, offset: number, v: bigint): void {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  dv.setBigUint64(offset, v, true);
}

function writeI64LE(buf: Uint8Array, offset: number, v: bigint): void {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  dv.setBigInt64(offset, v, true);
}

function writePubkey(buf: Uint8Array, offset: number, pk: PublicKey | string): void {
  const key = typeof pk === "string" ? new PublicKey(pk) : pk;
  buf.set(key.toBytes(), offset);
}

function writeString(buf: Uint8Array, offset: number, s: string, maxLen: number): void {
  const encoded = new TextEncoder().encode(s);
  buf.set(encoded.subarray(0, maxLen), offset);
}

function randomPk(): PublicKey {
  return Keypair.generate().publicKey;
}

// ProtocolConfig (272 bytes)

export interface ProtocolConfigFields {
  accountKey?: number;
  version?: number;
  operator?: PublicKey;
  realm?: PublicKey;
  governance?: PublicKey;
  feeBps?: number;
  feeTreasury?: PublicKey;
  paused?: boolean;
  acceptedMintCount?: number;
  acceptedMints?: PublicKey[];
  totalOrganizations?: number;
  bump?: number;
}

export function buildProtocolConfigBytes(f: ProtocolConfigFields = {}): Uint8Array {
  const buf = new Uint8Array(272);
  writeU8(buf, 0, f.accountKey ?? AccountKey.ProtocolConfig);
  writeU8(buf, 1, f.version ?? 1);
  writePubkey(buf, 2, f.operator ?? randomPk());
  writePubkey(buf, 34, f.realm ?? randomPk());
  writePubkey(buf, 66, f.governance ?? randomPk());
  writeU16LE(buf, 98, f.feeBps ?? 100);
  writePubkey(buf, 100, f.feeTreasury ?? randomPk());
  writeU8(buf, 132, f.paused ? 1 : 0);
  const mintCount = f.acceptedMintCount ?? (f.acceptedMints?.length ?? 1);
  writeU8(buf, 133, mintCount);
  const mints = f.acceptedMints ?? [randomPk()];
  for (let i = 0; i < 4; i++) {
    if (i < mints.length) {
      writePubkey(buf, 134 + i * 32, mints[i]);
    }
  }
  // 262: 2 bytes padding, then totalOrganizations at 264
  writeU32LE(buf, 264, f.totalOrganizations ?? 0);
  writeU8(buf, 268, f.bump ?? 255);
  return buf;
}

// Organization (368 bytes)──

export interface OrganizationFields {
  accountKey?: number;
  version?: number;
  id?: number;
  authority?: PublicKey;
  name?: string;
  registrationNumber?: string;
  country?: string;
  isActive?: boolean;
  assetCount?: number;
  realm?: PublicKey;
  acceptedMintCount?: number;
  acceptedMints?: PublicKey[];
  createdAt?: bigint;
  updatedAt?: bigint;
  bump?: number;
  roundFeeMode?: number;
  buyoutFeeMode?: number;
  secondaryFeeMode?: number;
  distributionFeeMode?: number;
  roundFeeValue?: bigint;
  buyoutFeeValue?: bigint;
  secondaryFeeValue?: bigint;
  distributionFeeValue?: bigint;
}

export function buildOrganizationBytes(f: OrganizationFields = {}): Uint8Array {
  const buf = new Uint8Array(368);
  writeU8(buf, 0, f.accountKey ?? AccountKey.Organization);
  writeU8(buf, 1, f.version ?? 1);
  // 2-3: padding
  writeU32LE(buf, 4, f.id ?? 0);
  writePubkey(buf, 8, f.authority ?? randomPk());
  writeString(buf, 40, f.name ?? "TestOrg", 64);
  writeU8(buf, 104, new TextEncoder().encode(f.name ?? "TestOrg").length);
  writeString(buf, 105, f.registrationNumber ?? "REG001", 32);
  writeU8(buf, 137, new TextEncoder().encode(f.registrationNumber ?? "REG001").length);
  writeString(buf, 138, f.country ?? "US", 4);
  writeU8(buf, 142, (f.isActive ?? true) ? 1 : 0);
  // 143: 1 byte padding
  writeU32LE(buf, 144, f.assetCount ?? 0);
  writePubkey(buf, 148, f.realm ?? randomPk());
  const mintCount = f.acceptedMintCount ?? (f.acceptedMints?.length ?? 0);
  writeU8(buf, 180, mintCount);
  const mints = f.acceptedMints ?? [];
  for (let i = 0; i < 4; i++) {
    if (i < mints.length) {
      writePubkey(buf, 181 + i * 32, mints[i]);
    }
  }
  // 309: 3 bytes padding
  writeI64LE(buf, 312, f.createdAt ?? 1700000000n);
  writeI64LE(buf, 320, f.updatedAt ?? 1700000000n);
  writeU8(buf, 328, f.bump ?? 255);
  // Fee fields (offset 329+)
  writeU8(buf, 329, f.roundFeeMode ?? 0);
  writeU8(buf, 330, f.buyoutFeeMode ?? 0);
  writeU8(buf, 331, f.secondaryFeeMode ?? 0);
  writeU8(buf, 332, f.distributionFeeMode ?? 0);
  // 333-335: padding (3 bytes)
  writeU64LE(buf, 336, f.roundFeeValue ?? 0n);
  writeU64LE(buf, 344, f.buyoutFeeValue ?? 0n);
  writeU64LE(buf, 352, f.secondaryFeeValue ?? 0n);
  writeU64LE(buf, 360, f.distributionFeeValue ?? 0n);
  return buf;
}

// Asset (304 bytes)─

export interface AssetFields {
  accountKey?: number;
  version?: number;
  id?: number;
  organization?: PublicKey;
  collection?: PublicKey;
  totalShares?: bigint;
  mintedShares?: bigint;
  status?: number;
  pricePerShare?: bigint;
  acceptedMint?: PublicKey;
  dividendEpoch?: number;
  fundraisingRoundCount?: number;
  createdAt?: bigint;
  updatedAt?: bigint;
  bump?: number;
  collectionAuthorityBump?: number;
  nativeTreasury?: PublicKey;
  activeBuyout?: PublicKey;
  unmintedSucceededRounds?: number;
  openDistributions?: number;
  complianceProgram?: PublicKey;
  transferCooldown?: bigint;
  maxHolders?: number;
  currentHolders?: number;
  maturityDate?: bigint;
  maturityGracePeriod?: bigint;
}

export function buildAssetBytes(f: AssetFields = {}): Uint8Array {
  const buf = new Uint8Array(304);
  writeU8(buf, 0, f.accountKey ?? AccountKey.Asset);
  writeU8(buf, 1, f.version ?? 1);
  // 2-3: padding
  writeU32LE(buf, 4, f.id ?? 0);
  writePubkey(buf, 8, f.organization ?? randomPk());
  writePubkey(buf, 40, f.collection ?? randomPk());
  writeU64LE(buf, 72, f.totalShares ?? 1000000n);
  writeU64LE(buf, 80, f.mintedShares ?? 0n);
  writeU8(buf, 88, f.status ?? 0);
  // 89-95: padding
  writeU64LE(buf, 96, f.pricePerShare ?? 1000000n);
  writePubkey(buf, 104, f.acceptedMint ?? randomPk());
  writeU32LE(buf, 136, f.dividendEpoch ?? 0);
  writeU32LE(buf, 140, f.fundraisingRoundCount ?? 0);
  writeI64LE(buf, 144, f.createdAt ?? 1700000000n);
  writeI64LE(buf, 152, f.updatedAt ?? 1700000000n);
  writeU8(buf, 160, f.bump ?? 255);
  writeU8(buf, 161, f.collectionAuthorityBump ?? 254);
  writePubkey(buf, 162, f.nativeTreasury ?? PublicKey.default);
  writePubkey(buf, 194, f.activeBuyout ?? PublicKey.default);
  // 226-227: padding (2 bytes)
  writeU32LE(buf, 228, f.unmintedSucceededRounds ?? 0);
  writeU32LE(buf, 232, f.openDistributions ?? 0);
  writePubkey(buf, 236, f.complianceProgram ?? PublicKey.default);
  // 268-271: padding (4 bytes)
  writeI64LE(buf, 272, f.transferCooldown ?? 0n);
  writeU32LE(buf, 280, f.maxHolders ?? 0);
  writeU32LE(buf, 284, f.currentHolders ?? 0);
  writeI64LE(buf, 288, f.maturityDate ?? 0n);
  writeI64LE(buf, 296, f.maturityGracePeriod ?? 0n);
  return buf;
}

// AssetToken (200 bytes)

export interface AssetTokenFields {
  accountKey?: number;
  version?: number;
  asset?: PublicKey;
  nft?: PublicKey;
  owner?: PublicKey;
  shares?: bigint;
  isListed?: boolean;
  activeVotes?: number;
  parentToken?: PublicKey;
  lastClaimedEpoch?: number;
  tokenIndex?: number;
  createdAt?: bigint;
  bump?: number;
  lockupEnd?: bigint;
  lastTransferAt?: bigint;
  costBasisPerShare?: bigint;
}

export function buildAssetTokenBytes(f: AssetTokenFields = {}): Uint8Array {
  const buf = new Uint8Array(200);
  writeU8(buf, 0, f.accountKey ?? AccountKey.AssetToken);
  writeU8(buf, 1, f.version ?? 1);
  writePubkey(buf, 2, f.asset ?? randomPk());
  writePubkey(buf, 34, f.nft ?? randomPk());
  writePubkey(buf, 66, f.owner ?? randomPk());
  // 98-103: padding (6 bytes)
  writeU64LE(buf, 104, f.shares ?? 100n);
  writeU8(buf, 112, (f.isListed ?? false) ? 1 : 0);
  writeU8(buf, 113, f.activeVotes ?? 0);
  writePubkey(buf, 114, f.parentToken ?? PublicKey.default);
  // 146-147: padding (2 bytes)
  writeU32LE(buf, 148, f.lastClaimedEpoch ?? 0);
  writeU32LE(buf, 152, f.tokenIndex ?? 0);
  // 156-159: padding (4 bytes)
  writeI64LE(buf, 160, f.createdAt ?? 1700000000n);
  writeU8(buf, 168, f.bump ?? 255);
  // 169-175: padding (7 bytes)
  writeI64LE(buf, 176, f.lockupEnd ?? 0n);
  writeI64LE(buf, 184, f.lastTransferAt ?? 0n);
  writeU64LE(buf, 192, f.costBasisPerShare ?? 0n);
  return buf;
}

// FundraisingRound (328 bytes)

export interface FundraisingRoundFields {
  accountKey?: number;
  version?: number;
  roundIndex?: number;
  asset?: PublicKey;
  organization?: PublicKey;
  sharesOffered?: bigint;
  pricePerShare?: bigint;
  acceptedMint?: PublicKey;
  minRaise?: bigint;
  maxRaise?: bigint;
  minPerWallet?: bigint;
  maxPerWallet?: bigint;
  startTime?: bigint;
  endTime?: bigint;
  status?: number;
  escrow?: PublicKey;
  totalRaised?: bigint;
  sharesSold?: bigint;
  investorCount?: number;
  investorsSettled?: number;
  createdAt?: bigint;
  updatedAt?: bigint;
  bump?: number;
  escrowBump?: number;
  treasury?: PublicKey;
  lockupEnd?: bigint;
  termsHash?: Uint8Array;
}

export function buildFundraisingRoundBytes(f: FundraisingRoundFields = {}): Uint8Array {
  const buf = new Uint8Array(328);
  writeU8(buf, 0, f.accountKey ?? AccountKey.FundraisingRound);
  writeU8(buf, 1, f.version ?? 1);
  // 2-3: padding
  writeU32LE(buf, 4, f.roundIndex ?? 0);
  writePubkey(buf, 8, f.asset ?? randomPk());
  writePubkey(buf, 40, f.organization ?? randomPk());
  writeU64LE(buf, 72, f.sharesOffered ?? 1000n);
  writeU64LE(buf, 80, f.pricePerShare ?? 1000000n);
  writePubkey(buf, 88, f.acceptedMint ?? randomPk());
  writeU64LE(buf, 120, f.minRaise ?? 100000000n);
  writeU64LE(buf, 128, f.maxRaise ?? 1000000000n);
  writeU64LE(buf, 136, f.minPerWallet ?? 1000000n);
  writeU64LE(buf, 144, f.maxPerWallet ?? 100000000n);
  writeI64LE(buf, 152, f.startTime ?? 1700000000n);
  writeI64LE(buf, 160, f.endTime ?? 1700100000n);
  writeU8(buf, 168, f.status ?? 0);
  writePubkey(buf, 169, f.escrow ?? randomPk());
  // 201-207: padding (7 bytes)
  writeU64LE(buf, 208, f.totalRaised ?? 0n);
  writeU64LE(buf, 216, f.sharesSold ?? 0n);
  writeU32LE(buf, 224, f.investorCount ?? 0);
  writeU32LE(buf, 228, f.investorsSettled ?? 0);
  writeI64LE(buf, 232, f.createdAt ?? 1700000000n);
  writeI64LE(buf, 240, f.updatedAt ?? 1700000000n);
  writeU8(buf, 248, f.bump ?? 255);
  writeU8(buf, 249, f.escrowBump ?? 254);
  writePubkey(buf, 250, f.treasury ?? PublicKey.default);
  // 282-287: padding (6 bytes)
  writeI64LE(buf, 288, f.lockupEnd ?? 0n);
  if (f.termsHash) buf.set(f.termsHash.subarray(0, 32), 296);
  return buf;
}

// Investment (120 bytes)

export interface InvestmentFields {
  accountKey?: number;
  version?: number;
  round?: PublicKey;
  investor?: PublicKey;
  sharesReserved?: bigint;
  amountDeposited?: bigint;
  isMinted?: boolean;
  isRefunded?: boolean;
  createdAt?: bigint;
  updatedAt?: bigint;
  bump?: number;
}

export function buildInvestmentBytes(f: InvestmentFields = {}): Uint8Array {
  const buf = new Uint8Array(120);
  writeU8(buf, 0, f.accountKey ?? AccountKey.Investment);
  writeU8(buf, 1, f.version ?? 1);
  writePubkey(buf, 2, f.round ?? randomPk());
  writePubkey(buf, 34, f.investor ?? randomPk());
  // 66-71: padding (6 bytes)
  writeU64LE(buf, 72, f.sharesReserved ?? 100n);
  writeU64LE(buf, 80, f.amountDeposited ?? 100000000n);
  writeU8(buf, 88, (f.isMinted ?? false) ? 1 : 0);
  writeU8(buf, 89, (f.isRefunded ?? false) ? 1 : 0);
  // 90-95: padding (6 bytes)
  writeI64LE(buf, 96, f.createdAt ?? 1700000000n);
  writeI64LE(buf, 104, f.updatedAt ?? 1700000000n);
  writeU8(buf, 112, f.bump ?? 255);
  return buf;
}

// Listing (216 bytes)───

export interface ListingFields {
  accountKey?: number;
  version?: number;
  assetToken?: PublicKey;
  asset?: PublicKey;
  seller?: PublicKey;
  acceptedMint?: PublicKey;
  sharesForSale?: bigint;
  pricePerShare?: bigint;
  expiry?: bigint;
  status?: number;
  isPartial?: boolean;
  createdAt?: bigint;
  bump?: number;
  rentPayer?: PublicKey;
}

export function buildListingBytes(f: ListingFields = {}): Uint8Array {
  const buf = new Uint8Array(216);
  writeU8(buf, 0, f.accountKey ?? AccountKey.Listing);
  writeU8(buf, 1, f.version ?? 1);
  writePubkey(buf, 2, f.assetToken ?? randomPk());
  writePubkey(buf, 34, f.asset ?? randomPk());
  writePubkey(buf, 66, f.seller ?? randomPk());
  writePubkey(buf, 98, f.acceptedMint ?? randomPk());
  // 130-135: padding (6 bytes)
  writeU64LE(buf, 136, f.sharesForSale ?? 50n);
  writeU64LE(buf, 144, f.pricePerShare ?? 2000000n);
  writeI64LE(buf, 152, f.expiry ?? 1700200000n);
  writeU8(buf, 160, f.status ?? 0);
  writeU8(buf, 161, (f.isPartial ?? false) ? 1 : 0);
  // 162-167: padding (6 bytes)
  writeI64LE(buf, 168, f.createdAt ?? 1700000000n);
  writeU8(buf, 176, f.bump ?? 255);
  writePubkey(buf, 177, f.rentPayer ?? randomPk());
  // 209-215: padding (7 bytes)
  return buf;
}

// Offer (256 bytes)─

export interface OfferFields {
  accountKey?: number;
  version?: number;
  assetToken?: PublicKey;
  asset?: PublicKey;
  buyer?: PublicKey;
  acceptedMint?: PublicKey;
  sharesRequested?: bigint;
  pricePerShare?: bigint;
  expiry?: bigint;
  status?: number;
  escrow?: PublicKey;
  totalDeposited?: bigint;
  createdAt?: bigint;
  bump?: number;
  escrowBump?: number;
  rentPayer?: PublicKey;
}

export function buildOfferBytes(f: OfferFields = {}): Uint8Array {
  const buf = new Uint8Array(256);
  writeU8(buf, 0, f.accountKey ?? AccountKey.Offer);
  writeU8(buf, 1, f.version ?? 1);
  writePubkey(buf, 2, f.assetToken ?? randomPk());
  writePubkey(buf, 34, f.asset ?? randomPk());
  writePubkey(buf, 66, f.buyer ?? randomPk());
  writePubkey(buf, 98, f.acceptedMint ?? randomPk());
  // 130-135: padding (6 bytes)
  writeU64LE(buf, 136, f.sharesRequested ?? 25n);
  writeU64LE(buf, 144, f.pricePerShare ?? 2000000n);
  writeI64LE(buf, 152, f.expiry ?? 1700200000n);
  writeU8(buf, 160, f.status ?? 0);
  writePubkey(buf, 161, f.escrow ?? randomPk());
  // 193-199: padding (7 bytes)
  writeU64LE(buf, 200, f.totalDeposited ?? 50000000n);
  writeI64LE(buf, 208, f.createdAt ?? 1700000000n);
  writeU8(buf, 216, f.bump ?? 255);
  writeU8(buf, 217, f.escrowBump ?? 254);
  writePubkey(buf, 218, f.rentPayer ?? randomPk());
  // 250-255: padding (6 bytes)
  return buf;
}

// DividendDistribution (176 bytes)

export interface DistributionFields {
  accountKey?: number;
  version?: number;
  asset?: PublicKey;
  epoch?: number;
  acceptedMint?: PublicKey;
  totalAmount?: bigint;
  totalShares?: bigint;
  sharesClaimed?: bigint;
  escrow?: PublicKey;
  createdAt?: bigint;
  bump?: number;
  escrowBump?: number;
  rentPayer?: PublicKey;
}

export function buildDistributionBytes(f: DistributionFields = {}): Uint8Array {
  const buf = new Uint8Array(176);
  writeU8(buf, 0, f.accountKey ?? AccountKey.DividendDistribution);
  writeU8(buf, 1, f.version ?? 1);
  writePubkey(buf, 2, f.asset ?? randomPk());
  // 34-35: padding (2 bytes)
  writeU32LE(buf, 36, f.epoch ?? 0);
  writePubkey(buf, 40, f.acceptedMint ?? randomPk());
  writeU64LE(buf, 72, f.totalAmount ?? 10000000000n);
  writeU64LE(buf, 80, f.totalShares ?? 1000000n);
  writeU64LE(buf, 88, f.sharesClaimed ?? 0n);
  writePubkey(buf, 96, f.escrow ?? randomPk());
  writeI64LE(buf, 128, f.createdAt ?? 1700000000n);
  writeU8(buf, 136, f.bump ?? 255);
  writeU8(buf, 137, f.escrowBump ?? 254);
  writePubkey(buf, 138, f.rentPayer ?? randomPk());
  // 170-175: padding (6 bytes)
  return buf;
}

// EmergencyRecord (160 bytes)

export interface EmergencyRecordFields {
  accountKey?: number;
  version?: number;
  asset?: PublicKey;
  oldAssetToken?: PublicKey;
  oldOwner?: PublicKey;
  recoveryType?: number;
  createdAt?: bigint;
  bump?: number;
  reason?: number;
  sharesTransferred?: bigint;
  remainderToken?: PublicKey;
}

export function buildEmergencyRecordBytes(f: EmergencyRecordFields = {}): Uint8Array {
  const buf = new Uint8Array(160);
  writeU8(buf, 0, f.accountKey ?? AccountKey.EmergencyRecord);
  writeU8(buf, 1, f.version ?? 1);
  writePubkey(buf, 2, f.asset ?? randomPk());
  writePubkey(buf, 34, f.oldAssetToken ?? randomPk());
  writePubkey(buf, 66, f.oldOwner ?? randomPk());
  writeU8(buf, 98, f.recoveryType ?? 0);
  // 99-103: padding (5 bytes)
  writeI64LE(buf, 104, f.createdAt ?? 1700000000n);
  writeU8(buf, 112, f.bump ?? 255);
  writeU8(buf, 113, f.reason ?? 0);
  // 114-119: padding (6 bytes)
  writeU64LE(buf, 120, f.sharesTransferred ?? 0n);
  writePubkey(buf, 128, f.remainderToken ?? PublicKey.default);
  return buf;
}

// BuyoutOffer (320 bytes)───

export interface BuyoutOfferFields {
  accountKey?: number;
  version?: number;
  buyer?: PublicKey;
  asset?: PublicKey;
  pricePerShare?: bigint;
  acceptedMint?: PublicKey;
  escrow?: PublicKey;
  treasuryDisposition?: number;
  termsHash?: Uint8Array;
  broker?: PublicKey;
  brokerBps?: number;
  brokerAmount?: bigint;
  mintedShares?: bigint;
  sharesSettled?: bigint;
  treasuryAmount?: bigint;
  status?: number;
  isCouncilBuyout?: boolean;
  expiresAt?: bigint;
  createdAt?: bigint;
  updatedAt?: bigint;
  bump?: number;
  rentPayer?: PublicKey;
}

export function buildBuyoutOfferBytes(f: BuyoutOfferFields = {}): Uint8Array {
  const buf = new Uint8Array(320);
  writeU8(buf, 0, f.accountKey ?? AccountKey.BuyoutOffer);
  writeU8(buf, 1, f.version ?? 1);
  writePubkey(buf, 2, f.buyer ?? randomPk());
  writePubkey(buf, 34, f.asset ?? randomPk());
  // 66-71: padding (6 bytes)
  writeU64LE(buf, 72, f.pricePerShare ?? 2000000n);
  writePubkey(buf, 80, f.acceptedMint ?? randomPk());
  writePubkey(buf, 112, f.escrow ?? randomPk());
  writeU8(buf, 144, f.treasuryDisposition ?? 0);
  if (f.termsHash) buf.set(f.termsHash.subarray(0, 32), 145);
  writePubkey(buf, 177, f.broker ?? PublicKey.default);
  // 209: padding (1 byte)
  writeU16LE(buf, 210, f.brokerBps ?? 0);
  // 212-215: padding (4 bytes)
  writeU64LE(buf, 216, f.brokerAmount ?? 0n);
  writeU64LE(buf, 224, f.mintedShares ?? 1000000n);
  writeU64LE(buf, 232, f.sharesSettled ?? 0n);
  writeU64LE(buf, 240, f.treasuryAmount ?? 0n);
  writeU8(buf, 248, f.status ?? 0);
  writeU8(buf, 249, (f.isCouncilBuyout ?? false) ? 1 : 0);
  // 250-255: padding (6 bytes)
  writeI64LE(buf, 256, f.expiresAt ?? 1700200000n);
  writeI64LE(buf, 264, f.createdAt ?? 1700000000n);
  writeI64LE(buf, 272, f.updatedAt ?? 1700000000n);
  writeU8(buf, 280, f.bump ?? 255);
  writePubkey(buf, 281, f.rentPayer ?? randomPk());
  // 313-319: padding (7 bytes)
  return buf;
}

// CollectionV1 (Borsh, variable-length) — MPL Core
//
// Borsh layout: key(1) + ua(32) + name(4+N) + uri(4+M) + numMinted(4) + currentSize(4)

export interface CollectionV1Fields {
  key?: number;
  updateAuthorityAddress?: PublicKey;
  name?: string;
  uri?: string;
  numMinted?: number;
  currentSize?: number;
}

export function buildCollectionV1Bytes(f: CollectionV1Fields = {}): Uint8Array {
  const enc = new TextEncoder();
  const nameBytes = enc.encode(f.name ?? "TestCollection");
  const uriBytes = enc.encode(f.uri ?? "https://example.com/collection.json");
  const size = 1 + 32 + 4 + nameBytes.length + 4 + uriBytes.length + 4 + 4;
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  let offset = 0;

  buf[offset] = f.key ?? MplCoreKey.CollectionV1;
  offset += 1;

  writePubkey(buf, offset, f.updateAuthorityAddress ?? randomPk());
  offset += 32;

  dv.setUint32(offset, nameBytes.length, true);
  offset += 4;
  buf.set(nameBytes, offset);
  offset += nameBytes.length;

  dv.setUint32(offset, uriBytes.length, true);
  offset += 4;
  buf.set(uriBytes, offset);
  offset += uriBytes.length;

  dv.setUint32(offset, f.numMinted ?? 0, true);
  offset += 4;
  dv.setUint32(offset, f.currentSize ?? 0, true);

  return buf;
}

// AssetV1 (Borsh, variable-length) — MPL Core
//
// Borsh layout: key(1) + owner(32) + ua_disc(1) + [ua_pubkey(32)] + name(4+N) + uri(4+M) + [seq_option(1) + seq(8)]

export interface AssetV1Fields {
  key?: number;
  owner?: PublicKey;
  updateAuthorityType?: number;
  updateAuthorityAddress?: PublicKey;
  name?: string;
  uri?: string;
  seq?: bigint;
  hasSeq?: boolean;
}

export function buildAssetV1Bytes(f: AssetV1Fields = {}): Uint8Array {
  const enc = new TextEncoder();
  const nameBytes = enc.encode(f.name ?? "TestNFT");
  const uriBytes = enc.encode(f.uri ?? "https://example.com/nft.json");
  const uaType = f.updateAuthorityType ?? UpdateAuthorityType.Collection;
  const hasUaPubkey = uaType === UpdateAuthorityType.Address || uaType === UpdateAuthorityType.Collection;
  const hasSeq = f.hasSeq ?? true;

  const size =
    1 + 32 + 1 + (hasUaPubkey ? 32 : 0) +
    4 + nameBytes.length + 4 + uriBytes.length +
    1 + (hasSeq ? 8 : 0);
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  let offset = 0;

  buf[offset] = f.key ?? MplCoreKey.AssetV1;
  offset += 1;

  writePubkey(buf, offset, f.owner ?? randomPk());
  offset += 32;

  buf[offset] = uaType;
  offset += 1;
  if (hasUaPubkey) {
    writePubkey(buf, offset, f.updateAuthorityAddress ?? randomPk());
    offset += 32;
  }

  dv.setUint32(offset, nameBytes.length, true);
  offset += 4;
  buf.set(nameBytes, offset);
  offset += nameBytes.length;

  dv.setUint32(offset, uriBytes.length, true);
  offset += 4;
  buf.set(uriBytes, offset);
  offset += uriBytes.length;

  if (hasSeq) {
    buf[offset] = 1;
    offset += 1;
    dv.setBigUint64(offset, f.seq ?? 1n, true);
  } else {
    buf[offset] = 0;
  }

  return buf;
}
