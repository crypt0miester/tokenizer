/**
 * Shared helpers for building instruction data and account metas.
 */
import {
  type AccountMeta,
  AccountRole,
  type Address,
  getAddressEncoder,
  getI64Encoder,
  getU8Encoder,
  getU16Encoder,
  getU32Encoder,
  getU64Encoder,
  type Instruction,
  mergeBytes,
} from "gill";
import { encodeDiscriminant, type InstructionType, TOKENIZER_PROGRAM_ID } from "../constants.js";

// Shared codec instances

const u8Enc = getU8Encoder();
const u16Enc = getU16Encoder();
const u32Enc = getU32Encoder();
const u64Enc = getU64Encoder();
const i64Enc = getI64Encoder();
const addrEnc = getAddressEncoder();

// Data encoding helpers (codec-backed)

export function encAddr(address: Address): Uint8Array {
  return new Uint8Array(addrEnc.encode(address));
}

export function encU8(v: number): Uint8Array {
  return new Uint8Array(u8Enc.encode(v));
}

export function encU16(v: number): Uint8Array {
  return new Uint8Array(u16Enc.encode(v));
}

export function encU32(v: number): Uint8Array {
  return new Uint8Array(u32Enc.encode(v));
}

export function encU64(v: bigint): Uint8Array {
  return new Uint8Array(u64Enc.encode(v));
}

export function encI64(v: bigint): Uint8Array {
  return new Uint8Array(i64Enc.encode(v));
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  return new Uint8Array(mergeBytes(parts));
}

// Account meta helpers

export const ro = (address: Address): AccountMeta => ({ address, role: AccountRole.READONLY });
export const wr = (address: Address): AccountMeta => ({ address, role: AccountRole.WRITABLE });
export const roS = (address: Address): AccountMeta => ({
  address,
  role: AccountRole.READONLY_SIGNER,
});
export const wrS = (address: Address): AccountMeta => ({
  address,
  role: AccountRole.WRITABLE_SIGNER,
});

// Instruction builder

export function buildIx(
  disc: InstructionType,
  accounts: AccountMeta[],
  payload?: Uint8Array,
  programId: Address = TOKENIZER_PROGRAM_ID,
): Instruction {
  const d = encodeDiscriminant(disc);
  return {
    programAddress: programId,
    accounts,
    data: payload ? concat(d, payload) : d,
  };
}
