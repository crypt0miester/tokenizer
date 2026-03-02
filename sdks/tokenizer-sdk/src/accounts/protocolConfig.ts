/**
 * ProtocolConfig account deserializer.
 *
 * #[repr(C)] layout (272 bytes):
 *   0: account_key (u8)
 *   1: version (u8)
 *   2: operator ([u8;32])
 *  34: realm ([u8;32])
 *  66: governance ([u8;32])
 *  98: fee_bps (u16)
 * 100: fee_treasury ([u8;32])
 * 132: paused (u8)
 * 133: accepted_mint_count (u8)
 * 134: accepted_mints ([[u8;32];4])
 * 264: total_organizations (u32)  — padded from 262
 * 268: bump (u8)
 * 270: min_proposal_weight_bps (u16) — padded from 269
 */
import { type Address, getStructDecoder, transformDecoder } from "gill";
import { AccountKey } from "../constants.js";
import { addr, addrArray, bool, pad, u8d, u16d, u32d } from "./decode.js";

export const PROTOCOL_CONFIG_SIZE = 272;

export interface ProtocolConfig {
  accountKey: number;
  version: number;
  operator: Address;
  realm: Address;
  governance: Address;
  feeBps: number;
  feeTreasury: Address;
  paused: boolean;
  acceptedMintCount: number;
  acceptedMints: Address[];
  totalOrganizations: number;
  bump: number;
  minProposalWeightBps: number;
}

const rawDecoder = getStructDecoder([
  ["accountKey", u8d],
  ["version", u8d],
  ["operator", addr],
  ["realm", addr],
  ["governance", addr],
  ["feeBps", u16d],
  ["feeTreasury", addr],
  ["paused", bool],
  ["acceptedMintCount", u8d],
  ["acceptedMints", addrArray(4)],
  ["_p0", pad(2)],
  ["totalOrganizations", u32d],
  ["bump", u8d],
  ["_p1", pad(1)],
  ["minProposalWeightBps", u16d],
]);

export const protocolConfigDecoder = transformDecoder(
  rawDecoder,
  ({ _p0, _p1, acceptedMintCount, acceptedMints, ...rest }) => ({
    ...rest,
    acceptedMintCount,
    acceptedMints: (acceptedMints as Address[]).slice(0, acceptedMintCount as number),
  }),
);

export function decodeProtocolConfig(data: Uint8Array): ProtocolConfig {
  if (data.length < PROTOCOL_CONFIG_SIZE) {
    throw new Error(`ProtocolConfig: expected ${PROTOCOL_CONFIG_SIZE} bytes, got ${data.length}`);
  }
  const accountKey = data[0];
  if (accountKey !== AccountKey.ProtocolConfig) {
    throw new Error(`ProtocolConfig: invalid account key ${accountKey}`);
  }
  return protocolConfigDecoder.decode(data);
}
