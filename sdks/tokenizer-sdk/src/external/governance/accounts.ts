/**
 * Governance account decoders.
 *
 * Governance accounts use Borsh serialization. We decode only the commonly-needed
 * prefix fields for verification and display.
 */
import { type Address, getStructDecoder, transformDecoder } from "gill";
import { addr, u8d, u64d } from "../../accounts/decode.js";
import { GovernanceAccountType, type ProposalState } from "./constants.js";

// ── Types ────────────────────────────────────────────────────────────

export interface RealmV2 {
  accountType: number;
  communityMint: Address;
}

export interface TokenOwnerRecordV2 {
  accountType: number;
  realm: Address;
  governingTokenMint: Address;
  governingTokenOwner: Address;
  governingTokenDepositAmount: bigint;
}

export interface GovernanceV2 {
  accountType: number;
  realm: Address;
  governanceSeed: Address;
}

export interface ProposalV2 {
  accountType: number;
  governance: Address;
  governingTokenMint: Address;
  state: ProposalState;
  tokenOwnerRecord: Address;
}

// ── RealmV2 decoder ──────────────────────────────────────────────────

const rawRealmDecoder = getStructDecoder([
  ["accountType", u8d],
  ["communityMint", addr],
]);

export const realmV2Decoder = rawRealmDecoder;

export function decodeRealmV2(data: Uint8Array): RealmV2 {
  if (data.length < 33) {
    throw new Error(`RealmV2: expected at least 33 bytes, got ${data.length}`);
  }
  if (data[0] !== GovernanceAccountType.RealmV2) {
    throw new Error(`RealmV2: invalid account type ${data[0]}`);
  }
  return realmV2Decoder.decode(data);
}

// ── TokenOwnerRecordV2 decoder ───────────────────────────────────────

const rawTokenOwnerRecordDecoder = getStructDecoder([
  ["accountType", u8d],
  ["realm", addr],
  ["governingTokenMint", addr],
  ["governingTokenOwner", addr],
  ["governingTokenDepositAmount", u64d],
]);

export const tokenOwnerRecordV2Decoder = rawTokenOwnerRecordDecoder;

export function decodeTokenOwnerRecordV2(data: Uint8Array): TokenOwnerRecordV2 {
  if (data.length < 105) {
    throw new Error(`TokenOwnerRecordV2: expected at least 105 bytes, got ${data.length}`);
  }
  if (data[0] !== GovernanceAccountType.TokenOwnerRecordV2) {
    throw new Error(`TokenOwnerRecordV2: invalid account type ${data[0]}`);
  }
  return tokenOwnerRecordV2Decoder.decode(data);
}

// ── GovernanceV2 decoder ─────────────────────────────────────────────

const rawGovernanceDecoder = getStructDecoder([
  ["accountType", u8d],
  ["realm", addr],
  ["governanceSeed", addr],
]);

export const governanceV2Decoder = rawGovernanceDecoder;

export function decodeGovernanceV2(data: Uint8Array): GovernanceV2 {
  if (data.length < 65) {
    throw new Error(`GovernanceV2: expected at least 65 bytes, got ${data.length}`);
  }
  if (data[0] !== GovernanceAccountType.GovernanceV2) {
    throw new Error(`GovernanceV2: invalid account type ${data[0]}`);
  }
  return governanceV2Decoder.decode(data);
}

// ── ProposalV2 decoder ───────────────────────────────────────────────

const rawProposalDecoder = getStructDecoder([
  ["accountType", u8d],
  ["governance", addr],
  ["governingTokenMint", addr],
  ["state", u8d],
  ["tokenOwnerRecord", addr],
]);

export const proposalV2Decoder = transformDecoder(
  rawProposalDecoder,
  (raw) => ({ ...raw, state: raw.state as unknown as ProposalState }),
);

export function decodeProposalV2(data: Uint8Array): ProposalV2 {
  if (data.length < 98) {
    throw new Error(`ProposalV2: expected at least 98 bytes, got ${data.length}`);
  }
  if (data[0] !== GovernanceAccountType.ProposalV2) {
    throw new Error(`ProposalV2: invalid account type ${data[0]}`);
  }
  return proposalV2Decoder.decode(data);
}

// ── VoteRecordV2 decoder ────────────────────────────────────────────

export interface VoteRecordV2 {
  accountType: number;
  proposal: Address;
  governingTokenOwner: Address;
  isRelinquished: boolean;
  voterWeight: bigint;
}

const rawVoteRecordDecoder = getStructDecoder([
  ["accountType", u8d],
  ["proposal", addr],
  ["governingTokenOwner", addr],
  ["isRelinquished", u8d],
  ["voterWeight", u64d],
]);

export const voteRecordV2Decoder = transformDecoder(
  rawVoteRecordDecoder,
  (raw) => ({ ...raw, isRelinquished: raw.isRelinquished !== 0 }),
);

export function decodeVoteRecordV2(data: Uint8Array): VoteRecordV2 {
  if (data.length < 74) {
    throw new Error(`VoteRecordV2: expected at least 74 bytes, got ${data.length}`);
  }
  if (data[0] !== GovernanceAccountType.VoteRecordV2) {
    throw new Error(`VoteRecordV2: invalid account type ${data[0]}`);
  }
  return voteRecordV2Decoder.decode(data);
}
