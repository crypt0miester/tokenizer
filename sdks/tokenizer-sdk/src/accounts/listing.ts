/**
 * Listing account deserializer.
 *
 * #[repr(C)] layout (184 bytes):
 *   0: account_key (u8)
 *   1: version (u8)
 *   2: asset_token ([u8;32])
 *  34: asset ([u8;32])
 *  66: seller ([u8;32])
 *  98: accepted_mint ([u8;32])
 * 136: shares_for_sale (u64)   — padded from 130
 * 144: price_per_share (u64)
 * 152: expiry (i64)
 * 160: status (u8)
 * 161: is_partial (u8)
 * 168: created_at (i64)        — padded from 162
 * 176: bump (u8)
 */
import { type Address, getStructDecoder, transformDecoder } from "gill";
import { AccountKey, type ListingStatus } from "../constants.js";
import { addr, bool, i64d, pad, u8d, u64d } from "./decode.js";

export const LISTING_SIZE = 184;
export const LISTING_OFFSET_ASSET_TOKEN = 2;
export const LISTING_OFFSET_ASSET = 34;
export const LISTING_OFFSET_SELLER = 66;
export const LISTING_OFFSET_STATUS = 160;

export interface Listing {
  accountKey: number;
  version: number;
  assetToken: Address;
  asset: Address;
  seller: Address;
  acceptedMint: Address;
  sharesForSale: bigint;
  pricePerShare: bigint;
  expiry: bigint;
  status: ListingStatus;
  isPartial: boolean;
  createdAt: bigint;
  bump: number;
}

const rawDecoder = getStructDecoder([
  ["accountKey", u8d],
  ["version", u8d],
  ["assetToken", addr],
  ["asset", addr],
  ["seller", addr],
  ["acceptedMint", addr],
  ["_p0", pad(6)],
  ["sharesForSale", u64d],
  ["pricePerShare", u64d],
  ["expiry", i64d],
  ["status", u8d],
  ["isPartial", bool],
  ["_p1", pad(6)],
  ["createdAt", i64d],
  ["bump", u8d],
  ["_p2", pad(7)],
]);

export const listingDecoder = transformDecoder(rawDecoder, ({ _p0, _p1, _p2, status, ...rest }) => ({
  ...rest,
  status: status as ListingStatus,
}));

export function decodeListing(data: Uint8Array): Listing {
  if (data.length < LISTING_SIZE) {
    throw new Error(`Listing: expected ${LISTING_SIZE} bytes, got ${data.length}`);
  }
  const accountKey = data[0];
  if (accountKey !== AccountKey.Listing) {
    throw new Error(`Listing: invalid account key ${accountKey}`);
  }
  return listingDecoder.decode(data);
}
