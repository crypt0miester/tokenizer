import type { Address } from "gill";
import { SYSTEM_PROGRAM_ADDRESS } from "gill/programs";
import { InstructionType, MPL_CORE_PROGRAM_ID } from "../constants.js";
import { buildIx, concat, encAddr, encU8, encU64, ro, roS, wr, wrS } from "./shared.js";

/** Discriminant 60 — Burn a lost token and remint to a new owner. */
export function burnAndRemint(p: {
  orgAccount: Address;
  assetAccount: Address;
  oldAssetTokenAccount: Address;
  oldNft: Address;
  collection: Address;
  collectionAuthority: Address;
  newNft: Address;
  newAssetTokenAccount: Address;
  newOwner: Address;
  emergencyRecordAccount: Address;
  orgAuthority: Address;
  payer: Address;
  systemProgram?: Address;
  mplCoreProgram?: Address;
  reason: number;
  sharesToTransfer: bigint;
  /** Required for partial transfers (sharesToTransfer > 0 and < total). */
  remainderNft?: Address;
  /** Required for partial transfers (sharesToTransfer > 0 and < total). */
  remainderAssetToken?: Address;
  /** Required for partial transfers — the old owner's pubkey for remainder NFT minting. */
  oldOwner?: Address;
  programId?: Address;
}) {
  const accounts = [
    ro(p.orgAccount),
    wr(p.assetAccount),
    wr(p.oldAssetTokenAccount),
    wr(p.oldNft),
    wr(p.collection),
    ro(p.collectionAuthority),
    wrS(p.newNft),
    wr(p.newAssetTokenAccount),
    ro(p.newOwner),
    wr(p.emergencyRecordAccount),
    roS(p.orgAuthority),
    wrS(p.payer),
    ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
    ro(p.mplCoreProgram ?? MPL_CORE_PROGRAM_ID),
  ];
  if (p.remainderNft && p.remainderAssetToken && p.oldOwner) {
    accounts.push(wrS(p.remainderNft), wr(p.remainderAssetToken), ro(p.oldOwner));
  }
  return buildIx(
    InstructionType.BurnAndRemint,
    accounts,
    concat(encAddr(p.newOwner), encU8(p.reason), encU64(p.sharesToTransfer)),
    p.programId,
  );
}

/** Discriminant 61 — Split a lost token and remint to multiple recipients. */
export function splitAndRemint(p: {
  orgAccount: Address;
  assetAccount: Address;
  oldAssetTokenAccount: Address;
  oldNft: Address;
  collection: Address;
  collectionAuthority: Address;
  emergencyRecordAccount: Address;
  orgAuthority: Address;
  payer: Address;
  systemProgram?: Address;
  mplCoreProgram?: Address;
  recipients: Array<{
    newNft: Address;
    newAssetTokenAccount: Address;
    recipient: Address;
    shares: bigint;
  }>;
  programId?: Address;
}) {
  const accounts = [
    ro(p.orgAccount),
    ro(p.assetAccount),
    wr(p.oldAssetTokenAccount),
    wr(p.oldNft),
    wr(p.collection),
    ro(p.collectionAuthority),
    wr(p.emergencyRecordAccount),
    roS(p.orgAuthority),
    wrS(p.payer),
    ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
    ro(p.mplCoreProgram ?? MPL_CORE_PROGRAM_ID),
  ];
  const dataParts: Uint8Array[] = [encU8(p.recipients.length)];
  for (const r of p.recipients) {
    accounts.push(wrS(r.newNft), wr(r.newAssetTokenAccount), ro(r.recipient));
    dataParts.push(encU64(r.shares));
  }
  return buildIx(InstructionType.SplitAndRemint, accounts, concat(...dataParts), p.programId);
}
