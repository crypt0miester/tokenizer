import type { Address } from "gill";
import { SYSTEM_PROGRAM_ADDRESS } from "gill/programs";
import { InstructionType } from "../constants.js";
import { buildIx, concat, encAddr, encU16, ro, roS, wr, wrS } from "./shared.js";

/** Discriminant 0 — Initialize protocol config. */
export function initializeProtocol(p: {
  config: Address;
  operator: Address;
  payer: Address;
  systemProgram?: Address;
  feeBps: number;
  feeTreasury: Address;
  acceptedMint: Address;
  programId?: Address;
}) {
  return buildIx(
    InstructionType.Initialize,
    [wr(p.config), roS(p.operator), wrS(p.payer), ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS)],
    concat(encU16(p.feeBps), encAddr(p.feeTreasury), encAddr(p.acceptedMint)),
    p.programId,
  );
}

/** Discriminant 1 — Update fee_bps. */
export function updateConfigFeeBps(p: {
  config: Address;
  operator: Address;
  feeBps: number;
  programId?: Address;
}) {
  return buildIx(
    InstructionType.UpdateConfig,
    [wr(p.config), roS(p.operator)],
    concat(new Uint8Array([0]), encU16(p.feeBps)),
    p.programId,
  );
}

/** Discriminant 1 — Update fee treasury. */
export function updateConfigFeeTreasury(p: {
  config: Address;
  operator: Address;
  feeTreasury: Address;
  programId?: Address;
}) {
  return buildIx(
    InstructionType.UpdateConfig,
    [wr(p.config), roS(p.operator)],
    concat(new Uint8Array([1]), encAddr(p.feeTreasury)),
    p.programId,
  );
}

/** Discriminant 1 — Add accepted mint. */
export function updateConfigAddMint(p: {
  config: Address;
  operator: Address;
  mint: Address;
  programId?: Address;
}) {
  return buildIx(
    InstructionType.UpdateConfig,
    [wr(p.config), roS(p.operator)],
    concat(new Uint8Array([3]), encAddr(p.mint)),
    p.programId,
  );
}

/** Discriminant 1 — Remove accepted mint. */
export function updateConfigRemoveMint(p: {
  config: Address;
  operator: Address;
  mint: Address;
  programId?: Address;
}) {
  return buildIx(
    InstructionType.UpdateConfig,
    [wr(p.config), roS(p.operator)],
    concat(new Uint8Array([4]), encAddr(p.mint)),
    p.programId,
  );
}

/** Discriminant 1 — Set new operator. */
export function updateConfigSetOperator(p: {
  config: Address;
  operator: Address;
  newOperator: Address;
  programId?: Address;
}) {
  return buildIx(
    InstructionType.UpdateConfig,
    [wr(p.config), roS(p.operator)],
    concat(new Uint8Array([5]), encAddr(p.newOperator)),
    p.programId,
  );
}

/** Discriminant 1 — Set min proposal weight bps. */
export function updateConfigMinProposalWeightBps(p: {
  config: Address;
  operator: Address;
  minProposalWeightBps: number;
  programId?: Address;
}) {
  return buildIx(
    InstructionType.UpdateConfig,
    [wr(p.config), roS(p.operator)],
    concat(new Uint8Array([6]), encU16(p.minProposalWeightBps)),
    p.programId,
  );
}

/** Discriminant 2 — Pause protocol. */
export function pauseProtocol(p: { config: Address; operator: Address; programId?: Address }) {
  return buildIx(InstructionType.Pause, [wr(p.config), roS(p.operator)], undefined, p.programId);
}

/** Discriminant 3 — Unpause protocol. */
export function unpauseProtocol(p: { config: Address; operator: Address; programId?: Address }) {
  return buildIx(InstructionType.Unpause, [wr(p.config), roS(p.operator)], undefined, p.programId);
}
