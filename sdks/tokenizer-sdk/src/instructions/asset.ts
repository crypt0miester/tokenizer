import type { Address } from "gill";
import { SYSTEM_PROGRAM_ADDRESS } from "gill/programs";
import { InstructionType, MPL_CORE_PROGRAM_ID } from "../constants.js";
import {
  buildIx,
  concat,
  encAddr,
  encI64,
  encU8,
  encU16,
  encU32,
  encU64,
  ro,
  roS,
  wr,
  wrS,
} from "./shared.js";

const utf8 = new TextEncoder();

const NULL_ADDRESS = SYSTEM_PROGRAM_ADDRESS;

/**
 * Discriminant 20 — Initialize a new asset with Metaplex Core collection.
 *
 * Instruction data layout:
 * [0..8]    totalShares: u64
 * [8..16]   pricePerShare: u64
 * [16..48]  acceptedMint: Pubkey
 * [48..56]  maturityDate: i64
 * [56..64]  maturityGracePeriod: i64
 * [64..72]  transferCooldown: i64
 * [72..76]  maxHolders: u32
 * [76]      transferPolicy: u8
 * [77]      oracleSource: u8
 * [78..82]  oracleMaxStaleness: u32
 * [82..84]  oracleMaxConfidenceBps: u16
 * [84]      acceptedMintDecimals: u8
 * [85..93]  sharesPerUnit: u64
 * [93..125] oracleFeed: Pubkey
 * [125]     nameLen: u8
 * [126..]   name bytes
 * then:     uriLen: u8
 * then:     uri bytes
 */
export function initAsset(p: {
  config: Address;
  orgAccount: Address;
  assetAccount: Address;
  collection: Address;
  collectionAuthority: Address;
  authority: Address;
  payer: Address;
  systemProgram?: Address;
  mplCoreProgram?: Address;
  totalShares: bigint;
  pricePerShare: bigint;
  acceptedMint: Address;
  maturityDate: bigint;
  maturityGracePeriod: bigint;
  transferCooldown: bigint;
  maxHolders: number;
  transferPolicy?: number;
  oracleSource?: number;
  oracleMaxStaleness?: number;
  oracleMaxConfidenceBps?: number;
  acceptedMintDecimals?: number;
  sharesPerUnit?: bigint;
  /** Oracle feed account — required when oracleSource != 0. Used in both accounts array and data payload. */
  oracleFeed?: Address;
  name: string;
  uri: string;
  programId?: Address;
}) {
  const nameBytes = utf8.encode(p.name);
  const uriBytes = utf8.encode(p.uri);

  const accounts = [
    ro(p.config),
    wr(p.orgAccount),
    wr(p.assetAccount),
    wrS(p.collection),
    ro(p.collectionAuthority),
    roS(p.authority),
    wrS(p.payer),
    ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
    ro(p.mplCoreProgram ?? MPL_CORE_PROGRAM_ID),
  ];

  // Optional 10th account: oracle feed
  if (p.oracleFeed) {
    accounts.push(ro(p.oracleFeed));
  }

  return buildIx(
    InstructionType.InitAsset,
    accounts,
    concat(
      encU64(p.totalShares),
      encU64(p.pricePerShare),
      encAddr(p.acceptedMint),
      encI64(p.maturityDate),
      encI64(p.maturityGracePeriod),
      encI64(p.transferCooldown),
      encU32(p.maxHolders),
      encU8(p.transferPolicy ?? 0),
      encU8(p.oracleSource ?? 0),
      encU32(p.oracleMaxStaleness ?? 0),
      encU16(p.oracleMaxConfidenceBps ?? 0),
      encU8(p.acceptedMintDecimals ?? 0),
      encU64(p.sharesPerUnit ?? 0n),
      encAddr(p.oracleFeed ?? NULL_ADDRESS),
      encU8(nameBytes.length),
      nameBytes,
      encU8(uriBytes.length),
      uriBytes,
    ),
    p.programId,
  );
}

/** Discriminant 21 — Mint a token (NFT + AssetToken) for an asset. */
export function mintToken(p: {
  config: Address;
  orgAccount: Address;
  assetAccount: Address;
  assetTokenAccount: Address;
  collection: Address;
  collectionAuthority: Address;
  nft: Address;
  recipient: Address;
  authority: Address;
  payer: Address;
  systemProgram?: Address;
  mplCoreProgram?: Address;
  shares: bigint;
  programId?: Address;
}) {
  return buildIx(
    InstructionType.MintToken,
    [
      ro(p.config),
      ro(p.orgAccount),
      wr(p.assetAccount),
      wr(p.assetTokenAccount),
      wr(p.collection),
      ro(p.collectionAuthority),
      wrS(p.nft),
      ro(p.recipient),
      roS(p.authority),
      wrS(p.payer),
      ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
      ro(p.mplCoreProgram ?? MPL_CORE_PROGRAM_ID),
    ],
    concat(encU64(p.shares), encAddr(p.recipient)),
    p.programId,
  );
}

/** Discriminant 22 — Update asset metadata (collection name/URI). */
export function updateMetadata(p: {
  config: Address;
  orgAccount: Address;
  assetAccount: Address;
  collection: Address;
  collectionAuthority: Address;
  authority: Address;
  payer: Address;
  systemProgram?: Address;
  mplCoreProgram?: Address;
  orgId: number;
  assetId: number;
  newName: string;
  newUri: string;
  programId?: Address;
}) {
  const nameBytes = utf8.encode(p.newName);
  const uriBytes = utf8.encode(p.newUri);
  return buildIx(
    InstructionType.UpdateMetadata,
    [
      ro(p.config),
      ro(p.orgAccount),
      ro(p.assetAccount),
      wr(p.collection),
      ro(p.collectionAuthority),
      roS(p.authority),
      wrS(p.payer),
      wr(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
      ro(p.mplCoreProgram ?? MPL_CORE_PROGRAM_ID),
    ],
    concat(
      encU32(p.orgId),
      encU32(p.assetId),
      encU8(nameBytes.length),
      nameBytes,
      encU8(uriBytes.length),
      uriBytes,
    ),
    p.programId,
  );
}

/**
 * Discriminant 23 — Refresh oracle price (permissionless crank).
 *
 * Accounts:
 *   0. asset (wr)
 *   1. oracle_feed (ro)
 */
export function refreshOraclePrice(p: {
  assetAccount: Address;
  oracleFeed: Address;
  programId?: Address;
}) {
  return buildIx(
    InstructionType.RefreshOraclePrice,
    [wr(p.assetAccount), ro(p.oracleFeed)],
    undefined,
    p.programId,
  );
}

/**
 * Discriminant 24 — Configure or update oracle pricing on an asset.
 *
 * Instruction data layout (48 bytes):
 * [0]      oracleSource: u8
 * [1..5]   oracleMaxStaleness: u32
 * [5..7]   oracleMaxConfidenceBps: u16
 * [7]      acceptedMintDecimals: u8
 * [8..16]  sharesPerUnit: u64
 * [16..48] oracleFeed: Pubkey
 *
 * Accounts:
 *   0. org (ro)
 *   1. asset (wr)
 *   2. oracle_feed (ro)
 *   3. authority (signer)
 */
export function configureOracle(p: {
  orgAccount: Address;
  assetAccount: Address;
  oracleFeed: Address;
  authority: Address;
  oracleSource: number;
  oracleMaxStaleness: number;
  oracleMaxConfidenceBps: number;
  acceptedMintDecimals: number;
  sharesPerUnit: bigint;
  programId?: Address;
}) {
  return buildIx(
    InstructionType.ConfigureOracle,
    [
      ro(p.orgAccount),
      wr(p.assetAccount),
      ro(p.oracleFeed),
      roS(p.authority),
    ],
    concat(
      encU8(p.oracleSource),
      encU32(p.oracleMaxStaleness),
      encU16(p.oracleMaxConfidenceBps),
      encU8(p.acceptedMintDecimals),
      encU64(p.sharesPerUnit),
      encAddr(p.oracleFeed),
    ),
    p.programId,
  );
}
