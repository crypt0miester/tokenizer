/**
 * EmergencyRecord account deserializer.
 *
 * #[repr(C)] layout (160 bytes):
 *   0: account_key (u8)
 *   1: version (u8)
 *   2: asset ([u8;32])
 *  34: old_asset_token ([u8;32])
 *  66: old_owner ([u8;32])
 *  98: recovery_type (u8)
 * 104: created_at (i64)        — padded from 99
 * 112: bump (u8)
 * 113: reason (u8)
 * 120: shares_transferred (u64) — padded from 114
 * 128: remainder_token ([u8;32])
 */
import { type Address, getStructDecoder, transformDecoder } from "gill";
import { AccountKey } from "../constants.js";
import { addr, i64d, pad, u8d, u64d } from "./decode.js";

export const EMERGENCY_RECORD_SIZE = 160;
export const EMERGENCY_RECORD_OFFSET_ASSET = 2;

export interface EmergencyRecord {
  accountKey: number;
  version: number;
  asset: Address;
  oldAssetToken: Address;
  oldOwner: Address;
  recoveryType: number;
  createdAt: bigint;
  bump: number;
  reason: number;
  sharesTransferred: bigint;
  remainderToken: Address;
}

const rawDecoder = getStructDecoder([
  ["accountKey", u8d],
  ["version", u8d],
  ["asset", addr],
  ["oldAssetToken", addr],
  ["oldOwner", addr],
  ["recoveryType", u8d],
  ["_p0", pad(5)],
  ["createdAt", i64d],
  ["bump", u8d],
  ["reason", u8d],
  ["_p1", pad(6)],
  ["sharesTransferred", u64d],
  ["remainderToken", addr],
]);

export const emergencyRecordDecoder = transformDecoder(rawDecoder, ({ _p0, _p1, ...rest }) => rest);

export function decodeEmergencyRecord(data: Uint8Array): EmergencyRecord {
  if (data.length < EMERGENCY_RECORD_SIZE) {
    throw new Error(`EmergencyRecord: expected ${EMERGENCY_RECORD_SIZE} bytes, got ${data.length}`);
  }
  const accountKey = data[0];
  if (accountKey !== AccountKey.EmergencyRecord) {
    throw new Error(`EmergencyRecord: invalid account key ${accountKey}`);
  }
  return emergencyRecordDecoder.decode(data);
}
