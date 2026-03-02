/**
 * Asset account deserializer.
 *
 * #[repr(C)] layout (304 bytes):
 *   0: account_key (u8)
 *   1: version (u8)
 *   4: id (u32)                    — padded from 2
 *   8: organization ([u8;32])
 *  40: collection ([u8;32])
 *  72: total_shares (u64)
 *  80: minted_shares (u64)
 *  88: status (u8)
 *  96: price_per_share (u64)       — padded from 89
 * 104: accepted_mint ([u8;32])
 * 136: dividend_epoch (u32)
 * 140: fundraising_round_count (u32)
 * 144: created_at (i64)
 * 152: updated_at (i64)
 * 160: bump (u8)
 * 161: collection_authority_bump (u8)
 * 162: native_treasury ([u8;32])
 * 194: active_buyout ([u8;32])
 * 228: unminted_succeeded_rounds (u32) — padded from 226
 * 232: open_distributions (u32)
 * 236: compliance_program ([u8;32])
 * 272: transfer_cooldown (i64)     — padded from 268
 * 280: max_holders (u32)
 * 284: current_holders (u32)
 * 288: maturity_date (i64)
 * 296: maturity_grace_period (i64)
 */
import { type Address, getStructDecoder, transformDecoder } from "gill";
import { AccountKey, type AssetStatus } from "../constants.js";
import { addr, i64d, pad, u8d, u32d, u64d } from "./decode.js";

export const ASSET_SIZE = 304;
export const ASSET_OFFSET_ORGANIZATION = 8;

export interface Asset {
  accountKey: number;
  version: number;
  id: number;
  organization: Address;
  collection: Address;
  totalShares: bigint;
  mintedShares: bigint;
  status: AssetStatus;
  pricePerShare: bigint;
  acceptedMint: Address;
  dividendEpoch: number;
  fundraisingRoundCount: number;
  createdAt: bigint;
  updatedAt: bigint;
  bump: number;
  collectionAuthorityBump: number;
  nativeTreasury: Address;
  activeBuyout: Address;
  unmintedSucceededRounds: number;
  openDistributions: number;
  complianceProgram: Address;
  transferCooldown: bigint;
  maxHolders: number;
  currentHolders: number;
  maturityDate: bigint;
  maturityGracePeriod: bigint;
}

const rawDecoder = getStructDecoder([
  ["accountKey", u8d],
  ["version", u8d],
  ["_p0", pad(2)],
  ["id", u32d],
  ["organization", addr],
  ["collection", addr],
  ["totalShares", u64d],
  ["mintedShares", u64d],
  ["status", u8d],
  ["_p1", pad(7)],
  ["pricePerShare", u64d],
  ["acceptedMint", addr],
  ["dividendEpoch", u32d],
  ["fundraisingRoundCount", u32d],
  ["createdAt", i64d],
  ["updatedAt", i64d],
  ["bump", u8d],
  ["collectionAuthorityBump", u8d],
  ["nativeTreasury", addr],
  ["activeBuyout", addr],
  ["_p2", pad(2)],
  ["unmintedSucceededRounds", u32d],
  ["openDistributions", u32d],
  ["complianceProgram", addr],
  ["_p3", pad(4)],
  ["transferCooldown", i64d],
  ["maxHolders", u32d],
  ["currentHolders", u32d],
  ["maturityDate", i64d],
  ["maturityGracePeriod", i64d],
]);

export const assetDecoder = transformDecoder(rawDecoder, ({ _p0, _p1, _p2, _p3, status, ...rest }) => ({
  ...rest,
  status: status as AssetStatus,
}));

export function decodeAsset(data: Uint8Array): Asset {
  if (data.length < ASSET_SIZE) {
    throw new Error(`Asset: expected ${ASSET_SIZE} bytes, got ${data.length}`);
  }
  const accountKey = data[0];
  if (accountKey !== AccountKey.Asset) {
    throw new Error(`Asset: invalid account key ${accountKey}`);
  }
  return assetDecoder.decode(data);
}
