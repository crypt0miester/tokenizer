import type { Address } from "gill";
import { SYSTEM_PROGRAM_ADDRESS } from "gill/programs";
import { InstructionType, MPL_CORE_PROGRAM_ID } from "../constants.js";
import { buildIx, concat, encAddr, encI64, encU8, encU32, encU64, ro, roS, wr, wrS } from "./shared.js";

const utf8 = new TextEncoder();

/** Discriminant 20 — Initialize a new asset with Metaplex Core collection. */
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
  name: string;
  uri: string;
  programId?: Address;
}) {
  const nameBytes = utf8.encode(p.name);
  const uriBytes = utf8.encode(p.uri);
  return buildIx(
    InstructionType.InitAsset,
    [
      ro(p.config),
      wr(p.orgAccount),
      wr(p.assetAccount),
      wrS(p.collection),
      ro(p.collectionAuthority),
      roS(p.authority),
      wrS(p.payer),
      ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
      ro(p.mplCoreProgram ?? MPL_CORE_PROGRAM_ID),
    ],
    concat(
      encU64(p.totalShares),
      encU64(p.pricePerShare),
      encAddr(p.acceptedMint),
      encI64(p.maturityDate),
      encI64(p.maturityGracePeriod),
      encI64(p.transferCooldown),
      encU32(p.maxHolders),
      encU8(p.transferPolicy ?? 0),
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
