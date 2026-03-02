/**
 * FundraisingRound account deserializer.
 *
 * #[repr(C)] layout (328 bytes):
 *   0: account_key (u8)
 *   1: version (u8)
 *   4: round_index (u32)        — padded from 2
 *   8: asset ([u8;32])
 *  40: organization ([u8;32])
 *  72: shares_offered (u64)
 *  80: price_per_share (u64)
 *  88: accepted_mint ([u8;32])
 * 120: min_raise (u64)
 * 128: max_raise (u64)
 * 136: min_per_wallet (u64)
 * 144: max_per_wallet (u64)
 * 152: start_time (i64)
 * 160: end_time (i64)
 * 168: status (u8)
 * 169: escrow ([u8;32])
 * 208: total_raised (u64)       — padded from 201
 * 216: shares_sold (u64)
 * 224: investor_count (u32)
 * 228: investors_settled (u32)
 * 232: created_at (i64)
 * 240: updated_at (i64)
 * 248: bump (u8)
 * 249: escrow_bump (u8)
 * 250: treasury ([u8;32])
 * 288: lockup_end (i64)         — padded from 282
 * 296: terms_hash ([u8;32])
 */
import { type Address, getStructDecoder, transformDecoder } from "gill";
import { AccountKey, type RoundStatus } from "../constants.js";
import { addr, i64d, pad, u8d, u32d, u64d, bytes32 } from "./decode.js";

export const FUNDRAISING_ROUND_SIZE = 328;
export const FUNDRAISING_ROUND_OFFSET_ASSET = 8;
export const FUNDRAISING_ROUND_OFFSET_ORGANIZATION = 40;
export const FUNDRAISING_ROUND_OFFSET_STATUS = 168;

export interface FundraisingRound {
  accountKey: number;
  version: number;
  roundIndex: number;
  asset: Address;
  organization: Address;
  sharesOffered: bigint;
  pricePerShare: bigint;
  acceptedMint: Address;
  minRaise: bigint;
  maxRaise: bigint;
  minPerWallet: bigint;
  maxPerWallet: bigint;
  startTime: bigint;
  endTime: bigint;
  status: RoundStatus;
  escrow: Address;
  totalRaised: bigint;
  sharesSold: bigint;
  investorCount: number;
  investorsSettled: number;
  createdAt: bigint;
  updatedAt: bigint;
  bump: number;
  escrowBump: number;
  treasury: Address;
  lockupEnd: bigint;
  termsHash: Uint8Array;
}

const rawDecoder = getStructDecoder([
  ["accountKey", u8d],
  ["version", u8d],
  ["_p0", pad(2)],
  ["roundIndex", u32d],
  ["asset", addr],
  ["organization", addr],
  ["sharesOffered", u64d],
  ["pricePerShare", u64d],
  ["acceptedMint", addr],
  ["minRaise", u64d],
  ["maxRaise", u64d],
  ["minPerWallet", u64d],
  ["maxPerWallet", u64d],
  ["startTime", i64d],
  ["endTime", i64d],
  ["status", u8d],
  ["escrow", addr],
  ["_p1", pad(7)],
  ["totalRaised", u64d],
  ["sharesSold", u64d],
  ["investorCount", u32d],
  ["investorsSettled", u32d],
  ["createdAt", i64d],
  ["updatedAt", i64d],
  ["bump", u8d],
  ["escrowBump", u8d],
  ["treasury", addr],
  ["_p2", pad(6)],
  ["lockupEnd", i64d],
  ["termsHash", bytes32],
]);

export const fundraisingRoundDecoder = transformDecoder(
  rawDecoder,
  ({ _p0, _p1, _p2, status, ...rest }) => ({
    ...rest,
    status: status as RoundStatus,
  }),
);

export function decodeFundraisingRound(data: Uint8Array): FundraisingRound {
  if (data.length < FUNDRAISING_ROUND_SIZE) {
    throw new Error(
      `FundraisingRound: expected ${FUNDRAISING_ROUND_SIZE} bytes, got ${data.length}`,
    );
  }
  const accountKey = data[0];
  if (accountKey !== AccountKey.FundraisingRound) {
    throw new Error(`FundraisingRound: invalid account key ${accountKey}`);
  }
  return fundraisingRoundDecoder.decode(data);
}
