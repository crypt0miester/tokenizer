/**
 * Offer account deserializer.
 *
 * #[repr(C)] layout (224 bytes):
 *   0: account_key (u8)
 *   1: version (u8)
 *   2: asset_token ([u8;32])
 *  34: asset ([u8;32])
 *  66: buyer ([u8;32])
 *  98: accepted_mint ([u8;32])
 * 136: shares_requested (u64)  — padded from 130
 * 144: price_per_share (u64)
 * 152: expiry (i64)
 * 160: status (u8)
 * 161: escrow ([u8;32])
 * 200: total_deposited (u64)   — padded from 193
 * 208: created_at (i64)
 * 216: bump (u8)
 * 217: escrow_bump (u8)
 */
import { type Address, getStructDecoder, transformDecoder } from "gill";
import { AccountKey, type OfferStatus } from "../constants.js";
import { addr, i64d, pad, u8d, u64d } from "./decode.js";

export const OFFER_SIZE = 224;
export const OFFER_OFFSET_ASSET_TOKEN = 2;
export const OFFER_OFFSET_ASSET = 34;
export const OFFER_OFFSET_BUYER = 66;
export const OFFER_OFFSET_STATUS = 160;

export interface Offer {
  accountKey: number;
  version: number;
  assetToken: Address;
  asset: Address;
  buyer: Address;
  acceptedMint: Address;
  sharesRequested: bigint;
  pricePerShare: bigint;
  expiry: bigint;
  status: OfferStatus;
  escrow: Address;
  totalDeposited: bigint;
  createdAt: bigint;
  bump: number;
  escrowBump: number;
}

const rawDecoder = getStructDecoder([
  ["accountKey", u8d],
  ["version", u8d],
  ["assetToken", addr],
  ["asset", addr],
  ["buyer", addr],
  ["acceptedMint", addr],
  ["_p0", pad(6)],
  ["sharesRequested", u64d],
  ["pricePerShare", u64d],
  ["expiry", i64d],
  ["status", u8d],
  ["escrow", addr],
  ["_p1", pad(7)],
  ["totalDeposited", u64d],
  ["createdAt", i64d],
  ["bump", u8d],
  ["escrowBump", u8d],
  ["_p2", pad(6)],
]);

export const offerDecoder = transformDecoder(rawDecoder, ({ _p0, _p1, _p2, status, ...rest }) => ({
  ...rest,
  status: status as OfferStatus,
}));

export function decodeOffer(data: Uint8Array): Offer {
  if (data.length < OFFER_SIZE) {
    throw new Error(`Offer: expected ${OFFER_SIZE} bytes, got ${data.length}`);
  }
  const accountKey = data[0];
  if (accountKey !== AccountKey.Offer) {
    throw new Error(`Offer: invalid account key ${accountKey}`);
  }
  return offerDecoder.decode(data);
}
