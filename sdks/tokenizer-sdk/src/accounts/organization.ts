/**
 * Organization account deserializer.
 *
 * #[repr(C)] layout (336 bytes):
 *   0: account_key (u8)
 *   1: version (u8)
 *   4: id (u32)              — padded from 2
 *   8: authority ([u8;32])
 *  40: name ([u8;64])
 * 104: name_len (u8)
 * 105: registration_number ([u8;32])
 * 137: registration_number_len (u8)
 * 138: country ([u8;4])
 * 142: is_active (u8)
 * 144: asset_count (u32)     — padded from 143
 * 148: realm ([u8;32])
 * 180: accepted_mint_count (u8)
 * 181: accepted_mints ([[u8;32];4])
 * 312: created_at (i64)      — padded from 309
 * 320: updated_at (i64)
 * 328: bump (u8)
 */
import { type Address, getStructDecoder, transformDecoder } from "gill";
import { AccountKey } from "../constants.js";
import { addr, addrArray, bool, i64d, pad, rawBytes, u8d, u32d, u64d } from "./decode.js";

export const ORGANIZATION_SIZE = 368;

export interface Organization {
  accountKey: number;
  version: number;
  id: number;
  authority: Address;
  name: string;
  registrationNumber: string;
  country: string;
  isActive: boolean;
  assetCount: number;
  realm: Address;
  acceptedMintCount: number;
  acceptedMints: Address[];
  createdAt: bigint;
  updatedAt: bigint;
  bump: number;
  roundFeeMode: number;
  buyoutFeeMode: number;
  secondaryFeeMode: number;
  distributionFeeMode: number;
  roundFeeValue: bigint;
  buyoutFeeValue: bigint;
  secondaryFeeValue: bigint;
  distributionFeeValue: bigint;
}

const textDecoder = new TextDecoder();

const rawDecoder = getStructDecoder([
  ["accountKey", u8d],
  ["version", u8d],
  ["_p0", pad(2)],
  ["id", u32d],
  ["authority", addr],
  ["nameBytes", rawBytes(64)],
  ["nameLen", u8d],
  ["regNumBytes", rawBytes(32)],
  ["regNumLen", u8d],
  ["countryBytes", rawBytes(4)],
  ["isActive", bool],
  ["_p1", pad(1)],
  ["assetCount", u32d],
  ["realm", addr],
  ["acceptedMintCount", u8d],
  ["acceptedMints", addrArray(4)],
  ["_p2", pad(3)],
  ["createdAt", i64d],
  ["updatedAt", i64d],
  ["bump", u8d],
  ["roundFeeMode", u8d],
  ["buyoutFeeMode", u8d],
  ["secondaryFeeMode", u8d],
  ["distributionFeeMode", u8d],
  ["_pFee", pad(3)],
  ["roundFeeValue", u64d],
  ["buyoutFeeValue", u64d],
  ["secondaryFeeValue", u64d],
  ["distributionFeeValue", u64d],
]);

export const organizationDecoder = transformDecoder(
  rawDecoder,
  ({
    _p0,
    _p1,
    _p2,
    _pFee,
    nameBytes,
    nameLen,
    regNumBytes,
    regNumLen,
    countryBytes,
    acceptedMintCount,
    acceptedMints,
    isActive,
    ...rest
  }) => ({
    ...rest,
    name: textDecoder.decode(nameBytes.slice(0, nameLen)),
    registrationNumber: textDecoder.decode(regNumBytes.slice(0, regNumLen)),
    country: textDecoder.decode(countryBytes).replace(/\0+$/, ""),
    isActive,
    acceptedMintCount,
    acceptedMints: acceptedMints.slice(0, acceptedMintCount),
  }),
);

export function decodeOrganization(data: Uint8Array): Organization {
  if (data.length < ORGANIZATION_SIZE) {
    throw new Error(`Organization: expected ${ORGANIZATION_SIZE} bytes, got ${data.length}`);
  }
  const accountKey = data[0];
  if (accountKey !== AccountKey.Organization) {
    throw new Error(`Organization: invalid account key ${accountKey}`);
  }
  return organizationDecoder.decode(data);
}
