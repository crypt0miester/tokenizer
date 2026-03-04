/**
 * MPL Core instruction builders.
 *
 * All use 1-byte discriminators. Instruction data uses Borsh string encoding
 * (u32 LE length prefix + UTF-8 bytes) for name/uri.
 */
import { type Address, type Instruction, mergeBytes } from "gill";
import { SYSTEM_PROGRAM_ADDRESS } from "gill/programs";
import { ro, roS, wr, wrS } from "../../instructions/shared.js";
import { MPL_CORE_PROGRAM_ID } from "./constants.js";

// Helpers

const utf8Enc = new TextEncoder();

/** Borsh string: u32LE(len) + UTF-8 bytes. */
export function borshString(s: string): Uint8Array {
  const bytes = utf8Enc.encode(s);
  const buf = new Uint8Array(4 + bytes.length);
  new DataView(buf.buffer).setUint32(0, bytes.length, true);
  buf.set(bytes, 4);
  return buf;
}

function ix(
  disc: number,
  accounts: Parameters<typeof mergeBytes>[0] extends never
    ? never
    : { address: Address; role: number }[],
  data: Uint8Array[],
  programId: Address,
): Instruction {
  return {
    programAddress: programId,
    accounts,
    data: new Uint8Array(mergeBytes([new Uint8Array([disc]), ...data])),
  };
}

// createCollectionV1 (disc=1)

export function createCollectionV1(p: {
  collection: Address;
  updateAuthority?: Address;
  payer: Address;
  systemProgram?: Address;
  name: string;
  uri: string;
  programId?: Address;
}): Instruction {
  const accounts = [
    wrS(p.collection),
    ...(p.updateAuthority ? [ro(p.updateAuthority)] : []),
    wrS(p.payer),
    ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
  ];
  return ix(
    1,
    accounts,
    [borshString(p.name), borshString(p.uri), new Uint8Array([0])],
    p.programId ?? MPL_CORE_PROGRAM_ID,
  );
}

// createV1 (disc=0)

export function createV1(p: {
  asset: Address;
  collection?: Address;
  authority?: Address;
  payer: Address;
  owner?: Address;
  updateAuthority?: Address;
  systemProgram?: Address;
  logWrapper?: Address;
  name: string;
  uri: string;
  programId?: Address;
}): Instruction {
  const accounts = [
    wrS(p.asset),
    ...(p.collection ? [wr(p.collection)] : []),
    ...(p.authority ? [roS(p.authority)] : []),
    wrS(p.payer),
    ...(p.owner ? [ro(p.owner)] : []),
    ...(p.updateAuthority ? [ro(p.updateAuthority)] : []),
    ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
    ...(p.logWrapper ? [ro(p.logWrapper)] : []),
  ];
  // dataState=0 (AccountState)
  return ix(
    0,
    accounts,
    [new Uint8Array([0]), borshString(p.name), borshString(p.uri), new Uint8Array([0])],
    p.programId ?? MPL_CORE_PROGRAM_ID,
  );
}

// transferV1 (disc=14)

export function transferV1(p: {
  asset: Address;
  collection?: Address;
  payer: Address;
  authority?: Address;
  newOwner: Address;
  systemProgram?: Address;
  programId?: Address;
}): Instruction {
  const accounts = [
    wr(p.asset),
    ...(p.collection ? [ro(p.collection)] : []),
    wrS(p.payer),
    ...(p.authority ? [roS(p.authority)] : []),
    ro(p.newOwner),
    ...(p.systemProgram ? [ro(p.systemProgram)] : []),
  ];
  return ix(14, accounts, [new Uint8Array([0])], p.programId ?? MPL_CORE_PROGRAM_ID);
}

// burnV1 (disc=12)

export function burnV1(p: {
  asset: Address;
  collection?: Address;
  payer: Address;
  authority?: Address;
  systemProgram?: Address;
  programId?: Address;
}): Instruction {
  const accounts = [
    wr(p.asset),
    ...(p.collection ? [wr(p.collection)] : []),
    wrS(p.payer),
    ...(p.authority ? [roS(p.authority)] : []),
    ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
  ];
  return ix(12, accounts, [new Uint8Array([0])], p.programId ?? MPL_CORE_PROGRAM_ID);
}
