/**
 * PDA derivation for SPL Governance accounts.
 */
import {
  type Address,
  getAddressEncoder,
  getProgramDerivedAddress,
  getUtf8Encoder,
  type ProgramDerivedAddress,
} from "gill";
import {
  GOVERNANCE_SEED,
  ACCOUNT_GOVERNANCE_SEED,
  NATIVE_TREASURY_SEED,
  REALM_CONFIG_SEED,
  SPL_GOVERNANCE_PROGRAM_ID,
} from "./constants.js";

const utf8 = getUtf8Encoder();
const addrEnc = getAddressEncoder();

function seed(s: string) {
  return utf8.encode(s);
}

function addrSeed(a: Address) {
  return addrEnc.encode(a);
}

/** PDA: ["governance", utf8(name)] */
export function getRealmAddress(
  name: string,
  programId: Address = SPL_GOVERNANCE_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [seed(GOVERNANCE_SEED), seed(name)],
  });
}

/** PDA: ["governance", realm, governingTokenMint] */
export function getTokenHoldingAddress(
  realm: Address,
  governingTokenMint: Address,
  programId: Address = SPL_GOVERNANCE_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [seed(GOVERNANCE_SEED), addrSeed(realm), addrSeed(governingTokenMint)],
  });
}

/** PDA: ["governance", realm, governingTokenMint, governingTokenOwner] */
export function getTokenOwnerRecordAddress(
  realm: Address,
  governingTokenMint: Address,
  governingTokenOwner: Address,
  programId: Address = SPL_GOVERNANCE_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [
      seed(GOVERNANCE_SEED),
      addrSeed(realm),
      addrSeed(governingTokenMint),
      addrSeed(governingTokenOwner),
    ],
  });
}

/** PDA: ["account-governance", realm, configOrOrgOrAssetAddr] 
 * The configOrOrgOrAssetAddr can be any seed but in tokenizer
 * we deterministically use the org address for realm governing an org, and asset address for realm governing an asset. This is because in our current UX we only support creating a realm per org or per asset, but the PDA itself is agnostic to the type of the seed.
*/
export function getGovernanceAddress(
  realm: Address,
  configOrOrgOrAssetAddr: Address,
  programId: Address = SPL_GOVERNANCE_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [seed(ACCOUNT_GOVERNANCE_SEED), addrSeed(realm), addrSeed(configOrOrgOrAssetAddr)],
  });
}

/** PDA: ["realm-config", realm] */
export function getRealmConfigAddress(
  realm: Address,
  programId: Address = SPL_GOVERNANCE_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [seed(REALM_CONFIG_SEED), addrSeed(realm)],
  });
}

/** PDA: ["native-treasury", governance] */
export function getNativeTreasuryAddress(
  governance: Address,
  programId: Address = SPL_GOVERNANCE_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [seed(NATIVE_TREASURY_SEED), addrSeed(governance)],
  });
}

/** PDA: ["governance", proposal, tokenOwnerRecord] */
export function getVoteRecordAddress(
  proposal: Address,
  tokenOwnerRecord: Address,
  programId: Address = SPL_GOVERNANCE_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [seed(GOVERNANCE_SEED), addrSeed(proposal), addrSeed(tokenOwnerRecord)],
  });
}

/** PDA: ["governance", proposal, option_index(u8), instruction_index(u16 LE)] */
export function getProposalTransactionAddress(
  proposal: Address,
  optionIndex: number,
  instructionIndex: number,
  programId: Address = SPL_GOVERNANCE_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  const optionBuf = new Uint8Array([optionIndex]);
  const indexBuf = new Uint8Array(2);
  new DataView(indexBuf.buffer).setUint16(0, instructionIndex, true);
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [seed(GOVERNANCE_SEED), addrSeed(proposal), optionBuf, indexBuf],
  });
}

/** PDA: ["governance", proposal, signatory] */
export function getSignatoryRecordAddress(
  proposal: Address,
  signatory: Address,
  programId: Address = SPL_GOVERNANCE_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [seed(GOVERNANCE_SEED), addrSeed(proposal), addrSeed(signatory)],
  });
}

/** PDA: ["governance", governance, governingTokenMint, proposalSeed] */
export function getProposalAddress(
  governance: Address,
  governingTokenMint: Address,
  proposalSeed: Address,
  programId: Address = SPL_GOVERNANCE_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [
      seed(GOVERNANCE_SEED),
      addrSeed(governance),
      addrSeed(governingTokenMint),
      addrSeed(proposalSeed),
    ],
  });
}
