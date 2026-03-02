import type { Address } from "gill";
import { SYSTEM_PROGRAM_ADDRESS } from "gill/programs";
import { TOKEN_PROGRAM_ADDRESS } from "gill/programs/token";
import { InstructionType, MPL_CORE_PROGRAM_ID } from "../constants.js";
import { buildIx, concat, encAddr, encI64, encU8, encU64, ro, roS, wr, wrS } from "./shared.js";

/** Discriminant 30 — Create a fundraising round. */
export function createRound(p: {
  config: Address;
  orgAccount: Address;
  assetAccount: Address;
  roundAccount: Address;
  escrow: Address;
  acceptedMint: Address;
  authority: Address;
  payer: Address;
  systemProgram?: Address;
  tokenProgram?: Address;
  sharesOffered: bigint;
  pricePerShare: bigint;
  minRaise: bigint;
  maxRaise: bigint;
  minPerWallet: bigint;
  maxPerWallet: bigint;
  startTime: bigint;
  endTime: bigint;
  lockupEnd: bigint;
  termsHash: Uint8Array;
  programId?: Address;
}) {
  return buildIx(
    InstructionType.CreateRound,
    [
      ro(p.config),
      ro(p.orgAccount),
      wr(p.assetAccount),
      wr(p.roundAccount),
      wr(p.escrow),
      ro(p.acceptedMint),
      roS(p.authority),
      wrS(p.payer),
      ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
      ro(p.tokenProgram ?? TOKEN_PROGRAM_ADDRESS),
    ],
    concat(
      encU64(p.sharesOffered),
      encU64(p.pricePerShare),
      encU64(p.minRaise),
      encU64(p.maxRaise),
      encU64(p.minPerWallet),
      encU64(p.maxPerWallet),
      encI64(p.startTime),
      encI64(p.endTime),
      encI64(p.lockupEnd),
      p.termsHash,
    ),
    p.programId,
  );
}

/** Discriminant 31 — Invest in a fundraising round. */
export function invest(p: {
  config: Address;
  roundAccount: Address;
  investmentAccount: Address;
  escrow: Address;
  investorTokenAccount: Address;
  investor: Address;
  payer: Address;
  systemProgram?: Address;
  tokenProgram?: Address;
  shares: bigint;
  termsHash: Uint8Array;
  programId?: Address;
}) {
  return buildIx(
    InstructionType.Invest,
    [
      ro(p.config),
      wr(p.roundAccount),
      wr(p.investmentAccount),
      wr(p.escrow),
      wr(p.investorTokenAccount),
      roS(p.investor),
      wrS(p.payer),
      ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
      ro(p.tokenProgram ?? TOKEN_PROGRAM_ADDRESS),
    ],
    concat(encU64(p.shares), p.termsHash),
    p.programId,
  );
}

/** Discriminant 32 — Finalize a succeeded round: transfer funds to org + fees. */
export function finalizeRound(p: {
  config: Address;
  assetAccount: Address;
  roundAccount: Address;
  escrow: Address;
  feeTreasuryToken: Address;
  orgTreasuryToken: Address;
  treasuryWallet: Address;
  payer: Address;
  acceptedMint: Address;
  systemProgram?: Address;
  tokenProgram?: Address;
  ataProgram: Address;
  programId?: Address;
}) {
  return buildIx(
    InstructionType.FinalizeRound,
    [
      ro(p.config),
      wr(p.assetAccount),
      wr(p.roundAccount),
      wr(p.escrow),
      wr(p.feeTreasuryToken),
      wr(p.orgTreasuryToken),
      ro(p.treasuryWallet),
      wrS(p.payer),
      ro(p.acceptedMint),
      ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
      ro(p.tokenProgram ?? TOKEN_PROGRAM_ADDRESS),
      ro(p.ataProgram),
    ],
    undefined,
    p.programId,
  );
}

/** Discriminant 33 — Batch-mint NFTs for investors after round succeeds. */
export function mintRoundTokens(p: {
  roundAccount: Address;
  assetAccount: Address;
  collection: Address;
  collectionAuthority: Address;
  payer: Address;
  systemProgram?: Address;
  mplCoreProgram?: Address;
  investors: Array<{
    investmentAccount: Address;
    assetTokenAccount: Address;
    nft: Address;
    investor: Address;
  }>;
  programId?: Address;
}) {
  const accounts = [
    wr(p.roundAccount),
    wr(p.assetAccount),
    wr(p.collection),
    ro(p.collectionAuthority),
    wrS(p.payer),
    ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
    ro(p.mplCoreProgram ?? MPL_CORE_PROGRAM_ID),
  ];
  for (const inv of p.investors) {
    accounts.push(
      wr(inv.investmentAccount),
      wr(inv.assetTokenAccount),
      wrS(inv.nft),
      ro(inv.investor),
    );
  }
  return buildIx(InstructionType.MintRoundTokens, accounts, encU8(p.investors.length), p.programId);
}

/** Discriminant 34 — Batch-refund investors after round fails/cancelled. */
export function refundInvestment(p: {
  roundAccount: Address;
  escrow: Address;
  payer: Address;
  acceptedMint: Address;
  systemProgram?: Address;
  tokenProgram?: Address;
  ataProgram: Address;
  investors: Array<{
    investmentAccount: Address;
    investorTokenAccount: Address;
    investor: Address;
  }>;
  programId?: Address;
}) {
  const accounts = [
    wr(p.roundAccount),
    wr(p.escrow),
    wrS(p.payer),
    ro(p.acceptedMint),
    ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
    ro(p.tokenProgram ?? TOKEN_PROGRAM_ADDRESS),
    ro(p.ataProgram),
  ];
  for (const inv of p.investors) {
    accounts.push(wr(inv.investmentAccount), wr(inv.investorTokenAccount), ro(inv.investor));
  }
  return buildIx(
    InstructionType.RefundInvestment,
    accounts,
    encU8(p.investors.length),
    p.programId,
  );
}

/** Discriminant 35 — Cancel a fundraising round. */
export function cancelRound(p: {
  config: Address;
  orgAccount: Address;
  assetAccount: Address;
  roundAccount: Address;
  authority: Address;
  programId?: Address;
}) {
  return buildIx(
    InstructionType.CancelRound,
    [ro(p.config), ro(p.orgAccount), wr(p.assetAccount), wr(p.roundAccount), roS(p.authority)],
    undefined,
    p.programId,
  );
}
