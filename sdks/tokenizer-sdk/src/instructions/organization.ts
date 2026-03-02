import type { Address } from "gill";
import { SYSTEM_PROGRAM_ADDRESS } from "gill/programs";
import { InstructionType } from "../constants.js";
import { buildIx, concat, encAddr, encU8, encU32, ro, roS, wr, wrS } from "./shared.js";

const utf8 = new TextEncoder();

/** Discriminant 10 — Register a new organization. */
export function registerOrganization(p: {
  config: Address;
  orgAccount: Address;
  operator: Address;
  payer: Address;
  systemProgram?: Address;
  authority: Address;
  name: string;
  registrationNumber: string;
  country: string;
  programId?: Address;
}) {
  const nameBytes = utf8.encode(p.name);
  const regNumBytes = utf8.encode(p.registrationNumber);
  const countryBytes = new Uint8Array(4);
  countryBytes.set(utf8.encode(p.country));
  return buildIx(
    InstructionType.Register,
    [wr(p.config), wr(p.orgAccount), roS(p.operator), wrS(p.payer), ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS)],
    concat(
      encAddr(p.authority),
      encU8(nameBytes.length),
      nameBytes,
      encU8(regNumBytes.length),
      regNumBytes,
      countryBytes,
    ),
    p.programId,
  );
}

/** Discriminant 11 — Deregister an organization. */
export function deregisterOrganization(p: {
  config: Address;
  orgAccount: Address;
  operator: Address;
  orgId: number;
  programId?: Address;
}) {
  return buildIx(
    InstructionType.Deregister,
    [ro(p.config), wr(p.orgAccount), roS(p.operator)],
    encU32(p.orgId),
    p.programId,
  );
}

/** Discriminant 12 — Add accepted mint to organization. */
export function updateOrgAddMint(p: {
  config: Address;
  orgAccount: Address;
  authority: Address;
  systemProgram?: Address;
  mint: Address;
  programId?: Address;
}) {
  return buildIx(
    InstructionType.UpdateOrg,
    [ro(p.config), wr(p.orgAccount), roS(p.authority), ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS)],
    concat(new Uint8Array([0]), encAddr(p.mint)),
    p.programId,
  );
}

/** Discriminant 12 — Remove accepted mint from organization. */
export function updateOrgRemoveMint(p: {
  config: Address;
  orgAccount: Address;
  authority: Address;
  systemProgram?: Address;
  mint: Address;
  programId?: Address;
}) {
  return buildIx(
    InstructionType.UpdateOrg,
    [ro(p.config), wr(p.orgAccount), roS(p.authority), ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS)],
    concat(new Uint8Array([1]), encAddr(p.mint)),
    p.programId,
  );
}
