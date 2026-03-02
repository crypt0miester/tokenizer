import type { Address } from "gill";
import { SYSTEM_PROGRAM_ADDRESS } from "gill/programs";
import { TOKEN_PROGRAM_ADDRESS } from "gill/programs/token";
import { InstructionType } from "../constants.js";
import { buildIx, concat, encAddr, encI64, encU8, encU16, encU64, ro, roS, wr, wrS } from "./shared.js";

/** Discriminant 85 — Create a buyout offer for an asset. */
export function createBuyoutOffer(p: {
  config: Address;
  org: Address;
  asset: Address;
  buyoutOffer: Address;
  acceptedMint: Address;
  buyer: Address;
  payer: Address;
  systemProgram?: Address;
  pricePerShare: bigint;
  isCouncilBuyout: boolean;
  treasuryDisposition: number;
  broker: Address;
  brokerBps: number;
  termsHash: Uint8Array;
  expiry: bigint;
  programId?: Address;
}) {
  return buildIx(
    InstructionType.CreateBuyoutOffer,
    [
      ro(p.config),
      ro(p.org),
      wr(p.asset),
      wr(p.buyoutOffer),
      ro(p.acceptedMint),
      roS(p.buyer),
      wrS(p.payer),
      ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
    ],
    concat(
      encU64(p.pricePerShare),
      encU8(p.isCouncilBuyout ? 1 : 0),
      encU8(p.treasuryDisposition),
      encAddr(p.broker),
      encU16(p.brokerBps),
      p.termsHash,
      encI64(p.expiry),
    ),
    p.programId,
  );
}

/** Discriminant 86 — Fund a pending buyout offer (external buyouts only). */
export function fundBuyoutOffer(p: {
  buyoutOffer: Address;
  asset: Address;
  escrow: Address;
  buyerTokenAcc: Address;
  acceptedMint: Address;
  buyer: Address;
  payer: Address;
  systemProgram?: Address;
  tokenProgram?: Address;
  programId?: Address;
}) {
  return buildIx(
    InstructionType.FundBuyoutOffer,
    [
      wr(p.buyoutOffer),
      ro(p.asset),
      wr(p.escrow),
      wr(p.buyerTokenAcc),
      ro(p.acceptedMint),
      roS(p.buyer),
      wrS(p.payer),
      ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
      ro(p.tokenProgram ?? TOKEN_PROGRAM_ADDRESS),
    ],
    undefined,
    p.programId,
  );
}

/** Discriminant 87 — Approve a funded buyout (org authority signs). */
export function approveBuyout(p: {
  buyoutOffer: Address;
  asset: Address;
  org: Address;
  authority: Address;
  programId?: Address;
}) {
  return buildIx(
    InstructionType.ApproveBuyout,
    [
      wr(p.buyoutOffer),
      ro(p.asset),
      ro(p.org),
      roS(p.authority),
    ],
    undefined,
    p.programId,
  );
}

/** Discriminant 88 — Settle buyout (pay holders, burn NFTs). */
export function settleBuyout(p: {
  buyoutOffer: Address;
  asset: Address;
  payer: Address;
  count: number;
  programId?: Address;
}) {
  return buildIx(
    InstructionType.SettleBuyout,
    [
      wr(p.buyoutOffer),
      ro(p.asset),
      wrS(p.payer),
    ],
    encU8(p.count),
    p.programId,
  );
}

/** Discriminant 89 — Complete a buyout after all holders settled. */
export function completeBuyout(p: {
  buyoutOffer: Address;
  asset: Address;
  buyer: Address;
  programId?: Address;
}) {
  return buildIx(
    InstructionType.CompleteBuyout,
    [
      wr(p.buyoutOffer),
      wr(p.asset),
      ro(p.buyer),
    ],
    undefined,
    p.programId,
  );
}

/** Discriminant 90 — Cancel a buyout offer. */
export function cancelBuyout(p: {
  buyoutOffer: Address;
  asset: Address;
  buyer: Address;
  /** If true, buyer is not required to sign (expired/permissionless cancel). */
  permissionless?: boolean;
  systemProgram?: Address;
  escrow?: Address;
  buyerTokenAcc?: Address;
  tokenProgram?: Address;
  programId?: Address;
}) {
  const accounts = [
    wr(p.buyoutOffer),
    wr(p.asset),
    p.permissionless ? wr(p.buyer) : wrS(p.buyer),
    ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
  ];
  if (p.escrow && p.buyerTokenAcc && p.tokenProgram) {
    accounts.push(wr(p.escrow), wr(p.buyerTokenAcc), ro(p.tokenProgram));
  }
  return buildIx(InstructionType.CancelBuyout, accounts, undefined, p.programId);
}
