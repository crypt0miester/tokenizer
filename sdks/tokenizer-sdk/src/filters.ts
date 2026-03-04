/**
 * Memcmp filter types and helpers for building getProgramAccounts queries.
 */
import { type Address, getAddressEncoder } from "gill";
import type { AccountKey } from "./constants.js";

// Types─

/** A memcmp filter: match `bytes` at `offset` in account data. */
export interface MemcmpFilter {
  offset: number;
  bytes: Uint8Array;
}

/** An account returned by getProgramAccounts. */
export interface ProgramAccount<T = Uint8Array> {
  address: Address;
  data: T;
}

// Helpers───

const addrEnc = getAddressEncoder();

/** Encode a base58 address to 32 raw bytes. */
export function addressBytes(address: Address): Uint8Array {
  return new Uint8Array(addrEnc.encode(address));
}

/** Filter by account discriminant (first byte). */
export function accountKeyFilter(key: AccountKey): MemcmpFilter {
  return { offset: 0, bytes: new Uint8Array([key]) };
}

/** Filter by a pubkey field at the given byte offset. */
export function addressFilter(offset: number, address: Address): MemcmpFilter {
  return { offset, bytes: addressBytes(address) };
}

/** Filter by a u8 field at the given byte offset. */
export function u8Filter(offset: number, value: number): MemcmpFilter {
  return { offset, bytes: new Uint8Array([value]) };
}
