/**
 * AssetToken account deserializer.
 *
 * #[repr(C)] layout (200 bytes):
 *   0: account_key (u8)
 *   1: version (u8)
 *   2: asset ([u8;32])
 *  34: nft ([u8;32])
 *  66: owner ([u8;32])
 * 104: shares (u64)           — padded from 98
 * 112: is_listed (u8)
 * 113: active_votes (u8)
 * 114: parent_token ([u8;32])
 * 148: last_claimed_epoch (u32) — padded from 146
 * 152: token_index (u32)
 * 160: created_at (i64)       — padded from 156
 * 168: bump (u8)
 * 176: lockup_end (i64)       — padded from 169
 * 184: last_transfer_at (i64)
 * 192: cost_basis_per_share (u64)
 */
import { type Address, getStructDecoder, transformDecoder } from "gill";
import { AccountKey } from "../constants.js";
import { addr, bool, i64d, pad, u8d, u32d, u64d } from "./decode.js";

export const ASSET_TOKEN_SIZE = 200;
export const ASSET_TOKEN_OFFSET_ASSET = 2;
export const ASSET_TOKEN_OFFSET_OWNER = 66;

export interface AssetToken {
  accountKey: number;
  version: number;
  asset: Address;
  nft: Address;
  owner: Address;
  shares: bigint;
  isListed: boolean;
  activeVotes: number;
  parentToken: Address;
  lastClaimedEpoch: number;
  tokenIndex: number;
  createdAt: bigint;
  bump: number;
  lockupEnd: bigint;
  lastTransferAt: bigint;
  costBasisPerShare: bigint;
}

const rawDecoder = getStructDecoder([
  ["accountKey", u8d],
  ["version", u8d],
  ["asset", addr],
  ["nft", addr],
  ["owner", addr],
  ["_p0", pad(6)],
  ["shares", u64d],
  ["isListed", bool],
  ["activeVotes", u8d],
  ["parentToken", addr],
  ["_p1", pad(2)],
  ["lastClaimedEpoch", u32d],
  ["tokenIndex", u32d],
  ["_p2", pad(4)],
  ["createdAt", i64d],
  ["bump", u8d],
  ["_p3", pad(7)],
  ["lockupEnd", i64d],
  ["lastTransferAt", i64d],
  ["costBasisPerShare", u64d],
]);

export const assetTokenDecoder = transformDecoder(
  rawDecoder,
  ({ _p0, _p1, _p2, _p3, ...rest }) => rest,
);

export function decodeAssetToken(data: Uint8Array): AssetToken {
  if (data.length < ASSET_TOKEN_SIZE) {
    throw new Error(`AssetToken: expected ${ASSET_TOKEN_SIZE} bytes, got ${data.length}`);
  }
  const accountKey = data[0];
  if (accountKey !== AccountKey.AssetToken) {
    throw new Error(`AssetToken: invalid account key ${accountKey}`);
  }
  return assetTokenDecoder.decode(data);
}
