/**
 * DividendDistribution account deserializer.
 *
 * #[repr(C)] layout (144 bytes):
 *   0: account_key (u8)
 *   1: version (u8)
 *   2: asset ([u8;32])
 *  36: epoch (u32)              — padded from 34
 *  40: accepted_mint ([u8;32])
 *  72: total_amount (u64)
 *  80: total_shares (u64)
 *  88: shares_claimed (u64)
 *  96: escrow ([u8;32])
 * 128: created_at (i64)
 * 136: bump (u8)
 * 137: escrow_bump (u8)
 * 138: rent_payer ([u8;32])
 */
import { type Address, getStructDecoder, transformDecoder } from "gill";
import { AccountKey } from "../constants.js";
import { addr, i64d, pad, u8d, u32d, u64d } from "./decode.js";

export const DIVIDEND_DISTRIBUTION_SIZE = 176;
export const DIVIDEND_DISTRIBUTION_OFFSET_ASSET = 2;

export interface DividendDistribution {
  accountKey: number;
  version: number;
  asset: Address;
  epoch: number;
  acceptedMint: Address;
  totalAmount: bigint;
  totalShares: bigint;
  sharesClaimed: bigint;
  escrow: Address;
  createdAt: bigint;
  bump: number;
  escrowBump: number;
  rentPayer: Address;
}

const rawDecoder = getStructDecoder([
  ["accountKey", u8d],
  ["version", u8d],
  ["asset", addr],
  ["_p0", pad(2)],
  ["epoch", u32d],
  ["acceptedMint", addr],
  ["totalAmount", u64d],
  ["totalShares", u64d],
  ["sharesClaimed", u64d],
  ["escrow", addr],
  ["createdAt", i64d],
  ["bump", u8d],
  ["escrowBump", u8d],
  ["rentPayer", addr],
  ["_p1", pad(6)],
]);

export const dividendDistributionDecoder = transformDecoder(
  rawDecoder,
  ({ _p0, _p1, ...rest }) => rest,
);

export function decodeDividendDistribution(data: Uint8Array): DividendDistribution {
  if (data.length < DIVIDEND_DISTRIBUTION_SIZE) {
    throw new Error(
      `DividendDistribution: expected ${DIVIDEND_DISTRIBUTION_SIZE} bytes, got ${data.length}`,
    );
  }
  const accountKey = data[0];
  if (accountKey !== AccountKey.DividendDistribution) {
    throw new Error(`DividendDistribution: invalid account key ${accountKey}`);
  }
  return dividendDistributionDecoder.decode(data);
}
