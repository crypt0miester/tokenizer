/**
 * BuyoutOffer account deserializer.
 *
 * #[repr(C)] layout (288 bytes):
 *   0: account_key (u8)
 *   1: version (u8)
 *   2: buyer ([u8;32])
 *  34: asset ([u8;32])
 *  66: padding (6 bytes)
 *  72: price_per_share (u64)
 *  80: accepted_mint ([u8;32])
 * 112: escrow ([u8;32])
 * 144: treasury_disposition (u8)
 * 145: terms_hash ([u8;32])
 * 177: broker ([u8;32])
 * 209: padding (1 byte)
 * 210: broker_bps (u16)
 * 212: padding (4 bytes)
 * 216: broker_amount (u64)
 * 224: minted_shares (u64)
 * 232: shares_settled (u64)
 * 240: treasury_amount (u64)
 * 248: status (u8)
 * 249: is_council_buyout (u8)
 * 250: padding (6 bytes)
 * 256: expires_at (i64)
 * 264: created_at (i64)
 * 272: updated_at (i64)
 * 280: bump (u8)
 * 281: rent_payer ([u8;32])
 */
import { type Address, getStructDecoder, transformDecoder } from "gill";
import { AccountKey } from "../constants.js";
import { addr, bytes32, i64d, pad, u8d, u16d, u64d } from "./decode.js";

export const BUYOUT_OFFER_SIZE = 320;

export interface BuyoutOffer {
  accountKey: number;
  version: number;
  buyer: Address;
  asset: Address;
  pricePerShare: bigint;
  acceptedMint: Address;
  escrow: Address;
  treasuryDisposition: number;
  termsHash: Uint8Array;
  broker: Address;
  brokerBps: number;
  brokerAmount: bigint;
  mintedShares: bigint;
  sharesSettled: bigint;
  treasuryAmount: bigint;
  status: number;
  isCouncilBuyout: boolean;
  expiresAt: bigint;
  createdAt: bigint;
  updatedAt: bigint;
  bump: number;
  rentPayer: Address;
}

const rawDecoder = getStructDecoder([
  ["accountKey", u8d],
  ["version", u8d],
  ["buyer", addr],
  ["asset", addr],
  ["_p0", pad(6)],
  ["pricePerShare", u64d],
  ["acceptedMint", addr],
  ["escrow", addr],
  ["treasuryDisposition", u8d],
  ["termsHash", bytes32],
  ["broker", addr],
  ["_p1", pad(1)],
  ["brokerBps", u16d],
  ["_p2", pad(4)],
  ["brokerAmount", u64d],
  ["mintedShares", u64d],
  ["sharesSettled", u64d],
  ["treasuryAmount", u64d],
  ["status", u8d],
  ["isCouncilBuyout", u8d],
  ["_p3", pad(6)],
  ["expiresAt", i64d],
  ["createdAt", i64d],
  ["updatedAt", i64d],
  ["bump", u8d],
  ["rentPayer", addr],
  ["_p4", pad(7)],
]);

export const buyoutOfferDecoder = transformDecoder(
  rawDecoder,
  ({ _p0, _p1, _p2, _p3, _p4, isCouncilBuyout, termsHash, ...rest }) => ({
    ...rest,
    isCouncilBuyout: isCouncilBuyout !== 0,
    termsHash: termsHash as Uint8Array,
  }),
);

export function decodeBuyoutOffer(data: Uint8Array): BuyoutOffer {
  if (data.length < BUYOUT_OFFER_SIZE) {
    throw new Error(`BuyoutOffer: expected ${BUYOUT_OFFER_SIZE} bytes, got ${data.length}`);
  }
  const accountKey = data[0];
  if (accountKey !== AccountKey.BuyoutOffer) {
    throw new Error(`BuyoutOffer: invalid account key ${accountKey}`);
  }
  return buyoutOfferDecoder.decode(data);
}
