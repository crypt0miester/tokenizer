import type { Address } from "gill";
import { SYSTEM_PROGRAM_ADDRESS } from "gill/programs";
import { TOKEN_PROGRAM_ADDRESS } from "gill/programs/token";
import { InstructionType } from "../constants.js";
import { buildIx, encU8, encU64, ro, roS, wr, wrS } from "./shared.js";

/** Discriminant 50 — Create a dividend distribution. */
export function createDistribution(p: {
  config: Address;
  orgAccount: Address;
  assetAccount: Address;
  distributionAccount: Address;
  escrow: Address;
  depositorTokenAcc: Address;
  acceptedMint: Address;
  authority: Address;
  payer: Address;
  systemProgram?: Address;
  tokenProgram?: Address;
  totalAmount: bigint;
  programId?: Address;
}) {
  return buildIx(
    InstructionType.CreateDistribution,
    [
      ro(p.config),
      ro(p.orgAccount),
      wr(p.assetAccount),
      wr(p.distributionAccount),
      wr(p.escrow),
      wr(p.depositorTokenAcc),
      ro(p.acceptedMint),
      roS(p.authority),
      wrS(p.payer),
      ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
      ro(p.tokenProgram ?? TOKEN_PROGRAM_ADDRESS),
    ],
    encU64(p.totalAmount),
    p.programId,
  );
}

/** Discriminant 51 — Batch-claim dividends for token holders. */
export function claimDistribution(p: {
  distributionAccount: Address;
  escrow: Address;
  assetAccount: Address;
  payer: Address;
  acceptedMint: Address;
  systemProgram?: Address;
  tokenProgram?: Address;
  ataProgram: Address;
  claims: Array<{
    assetTokenAccount: Address;
    holderTokenAcc: Address;
    holder: Address;
  }>;
  programId?: Address;
}) {
  const accounts = [
    wr(p.distributionAccount),
    wr(p.escrow),
    ro(p.assetAccount),
    wrS(p.payer),
    ro(p.acceptedMint),
    ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
    ro(p.tokenProgram ?? TOKEN_PROGRAM_ADDRESS),
    ro(p.ataProgram),
  ];
  for (const c of p.claims) {
    accounts.push(wr(c.assetTokenAccount), wr(c.holderTokenAcc), ro(c.holder));
  }
  return buildIx(InstructionType.ClaimDistribution, accounts, encU8(p.claims.length), p.programId);
}

/** Discriminant 52 — Close a fully-claimed distribution. */
export function closeDistribution(p: {
  distributionAccount: Address;
  escrow: Address;
  assetAccount: Address;
  orgAccount: Address;
  dustRecipient: Address;
  payer: Address;
  tokenProgram?: Address;
  programId?: Address;
}) {
  return buildIx(
    InstructionType.CloseDistribution,
    [
      wr(p.distributionAccount),
      wr(p.escrow),
      wr(p.assetAccount),
      ro(p.orgAccount),
      wr(p.dustRecipient),
      wrS(p.payer),
      ro(p.tokenProgram ?? TOKEN_PROGRAM_ADDRESS),
    ],
    undefined,
    p.programId,
  );
}
