/**
 * Registrar account deserializer.
 *
 * #[repr(C)] layout (131 bytes):
 *   0: account_key (u8)
 *   1: version (u8)
 *   2: governance_program_id ([u8;32])
 *  34: realm ([u8;32])
 *  66: governing_token_mint ([u8;32])
 *  98: asset ([u8;32])
 * 130: bump (u8)
 */
import { type Address, getStructDecoder } from "gill";
import { AccountKey } from "../constants.js";
import { addr, u8d } from "./decode.js";

export const REGISTRAR_SIZE = 131;

export interface Registrar {
  accountKey: number;
  version: number;
  governanceProgramId: Address;
  realm: Address;
  governingTokenMint: Address;
  asset: Address;
  bump: number;
}

const rawDecoder = getStructDecoder([
  ["accountKey", u8d],
  ["version", u8d],
  ["governanceProgramId", addr],
  ["realm", addr],
  ["governingTokenMint", addr],
  ["asset", addr],
  ["bump", u8d],
]);

export const registrarDecoder = rawDecoder;

export function decodeRegistrar(data: Uint8Array): Registrar {
  if (data.length < REGISTRAR_SIZE) {
    throw new Error(`Registrar: expected at least ${REGISTRAR_SIZE} bytes, got ${data.length}`);
  }
  const accountKey = data[0];
  if (accountKey !== AccountKey.Registrar) {
    throw new Error(`Registrar: invalid account key ${accountKey}`);
  }
  return registrarDecoder.decode(data);
}
