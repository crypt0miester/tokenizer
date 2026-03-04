/**
 * VoterWeightRecord account deserializer (tokenizer voter-weight plugin).
 *
 * Borsh-compatible layout (164 bytes):
 *   0..8     discriminator [46, 249, 155, 75, 153, 248, 116, 9]
 *   8..40    realm (Pubkey)
 *  40..72    governing_token_mint (Pubkey)
 *  72..104   governing_token_owner (Pubkey)
 * 104..112   voter_weight (u64 LE)
 * 112        Option tag (0x01 = Some)
 * 113..121   voter_weight_expiry (u64 LE slot)
 * 121        Option tag
 * 122        weight_action (u8 enum)
 * 123        Option tag
 * 124..156   weight_action_target (Pubkey)
 * 156..164   reserved [u8; 8]
 */
import type { Address } from "gill";

export const VOTER_WEIGHT_RECORD_SIZE = 164;
export const VOTER_WEIGHT_RECORD_DISCRIMINATOR = new Uint8Array([
  46, 249, 155, 75, 153, 248, 116, 9,
]);

export interface VoterWeightRecord {
  realm: Address;
  governingTokenMint: Address;
  governingTokenOwner: Address;
  voterWeight: bigint;
  voterWeightExpiry: bigint | null;
}

/**
 * Decode only the voter_weight u64 at offset 104 without full deserialization.
 * Returns 0n if account data is too short.
 */
export function readVoterWeight(data: Uint8Array): bigint {
  if (data.length < 112) return 0n;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getBigUint64(104, true);
}
