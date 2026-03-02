/**
 * Investment account deserializer.
 *
 * #[repr(C)] layout (120 bytes):
 *   0: account_key (u8)
 *   1: version (u8)
 *   2: round ([u8;32])
 *  34: investor ([u8;32])
 *  72: shares_reserved (u64)   — padded from 66
 *  80: amount_deposited (u64)
 *  88: is_minted (u8)
 *  89: is_refunded (u8)
 *  96: created_at (i64)        — padded from 90
 * 104: updated_at (i64)
 * 112: bump (u8)
 */
import { type Address, getStructDecoder, transformDecoder } from "gill";
import { AccountKey } from "../constants.js";
import { addr, bool, i64d, pad, u8d, u64d } from "./decode.js";

export const INVESTMENT_SIZE = 120;
export const INVESTMENT_OFFSET_ROUND = 2;
export const INVESTMENT_OFFSET_INVESTOR = 34;

export interface Investment {
  accountKey: number;
  version: number;
  round: Address;
  investor: Address;
  sharesReserved: bigint;
  amountDeposited: bigint;
  isMinted: boolean;
  isRefunded: boolean;
  createdAt: bigint;
  updatedAt: bigint;
  bump: number;
}

const rawDecoder = getStructDecoder([
  ["accountKey", u8d],
  ["version", u8d],
  ["round", addr],
  ["investor", addr],
  ["_p0", pad(6)],
  ["sharesReserved", u64d],
  ["amountDeposited", u64d],
  ["isMinted", bool],
  ["isRefunded", bool],
  ["_p1", pad(6)],
  ["createdAt", i64d],
  ["updatedAt", i64d],
  ["bump", u8d],
  ["_p2", pad(7)],
]);

export const investmentDecoder = transformDecoder(rawDecoder, ({ _p0, _p1, _p2, ...rest }) => rest);

export function decodeInvestment(data: Uint8Array): Investment {
  if (data.length < INVESTMENT_SIZE) {
    throw new Error(`Investment: expected ${INVESTMENT_SIZE} bytes, got ${data.length}`);
  }
  const accountKey = data[0];
  if (accountKey !== AccountKey.Investment) {
    throw new Error(`Investment: invalid account key ${accountKey}`);
  }
  return investmentDecoder.decode(data);
}
