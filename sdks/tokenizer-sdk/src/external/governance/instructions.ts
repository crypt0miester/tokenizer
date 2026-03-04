/**
 * SPL Governance instruction builders.
 *
 * Each instruction: 1-byte discriminant + Borsh-encoded args.
 */
import { AccountRole, type Address, type Instruction, address, mergeBytes } from "gill";
import { SYSTEM_PROGRAM_ADDRESS } from "gill/programs";
import { ro, wr, roS, wrS, encU8, encU16, encU32, encU64, encAddr } from "../../instructions/shared.js";
import { GovernanceInstruction, SPL_GOVERNANCE_PROGRAM_ID, VoteThresholdType } from "./constants.js";

// Helpers───

const utf8Enc = new TextEncoder();

/** Borsh string: u32LE(len) + UTF-8 bytes. */
function borshString(s: string): Uint8Array {
  const bytes = utf8Enc.encode(s);
  const buf = new Uint8Array(4 + bytes.length);
  new DataView(buf.buffer).setUint32(0, bytes.length, true);
  buf.set(bytes, 4);
  return buf;
}

/** Borsh bool: 1 byte. */
function borshBool(v: boolean): Uint8Array {
  return new Uint8Array([v ? 1 : 0]);
}

/** Borsh Option<T>: [0] for None, [1, ...data] for Some. */
function borshOptionAddress(addr: Address | undefined): Uint8Array {
  if (!addr) return new Uint8Array([0]);
  return new Uint8Array(mergeBytes([new Uint8Array([1]), encAddr(addr)]));
}

/** Borsh Vec<T>: u32LE(len) + elements. */
function borshVec(items: Uint8Array[]): Uint8Array {
  const len = encU32(items.length);
  return new Uint8Array(mergeBytes([len, ...items]));
}

function buildGovIx(
  disc: GovernanceInstruction,
  accounts: { address: Address; role: number }[],
  data: Uint8Array[],
  programId: Address,
): Instruction {
  return {
    programAddress: programId,
    accounts,
    data: new Uint8Array(mergeBytes([new Uint8Array([disc]), ...data])),
  };
}

// Governance Config─

export interface VoteThreshold {
  type: VoteThresholdType;
  value: number;
}

export interface GovernanceConfig {
  communityVoteThreshold: VoteThreshold;
  minCommunityWeightToCreateProposal: bigint;
  minTransactionHoldUpTime: number;
  votingBaseTime: number;
  communityVoteTipping: number;
  councilVoteThreshold: VoteThreshold;
  councilVetoVoteThreshold: VoteThreshold;
  minCouncilWeightToCreateProposal: bigint;
  councilVoteTipping: number;
  communityVetoVoteThreshold: VoteThreshold;
  votingCoolOffTime: number;
  depositExemptProposalCount: number;
}

function encodeVoteThreshold(t: VoteThreshold): Uint8Array {
  if (t.type === VoteThresholdType.Disabled) {
    return new Uint8Array([t.type]);
  }
  return new Uint8Array([t.type, t.value]);
}

/** Serialize GovernanceConfig to Borsh bytes. */
export function encodeGovernanceConfig(config: GovernanceConfig): Uint8Array {
  return new Uint8Array(
    mergeBytes([
      encodeVoteThreshold(config.communityVoteThreshold),
      encU64(config.minCommunityWeightToCreateProposal),
      encU32(config.minTransactionHoldUpTime),
      encU32(config.votingBaseTime),
      encU8(config.communityVoteTipping),
      encodeVoteThreshold(config.councilVoteThreshold),
      encodeVoteThreshold(config.councilVetoVoteThreshold),
      encU64(config.minCouncilWeightToCreateProposal),
      encU8(config.councilVoteTipping),
      encodeVoteThreshold(config.communityVetoVoteThreshold),
      encU32(config.votingCoolOffTime),
      encU8(config.depositExemptProposalCount),
    ]),
  );
}

// Token Config for createRealm

export interface GovTokenConfig {
  voterWeightAddin?: Address;
  maxVoterWeightAddin?: Address;
  tokenType: number;
}

function encodeTokenConfig(tc: GovTokenConfig): Uint8Array {
  return new Uint8Array(
    mergeBytes([
      borshOptionAddress(tc.voterWeightAddin),
      borshOptionAddress(tc.maxVoterWeightAddin),
      encU8(tc.tokenType),
    ]),
  );
}

// createRealm (disc=0)──

export function createRealm(p: {
  realm: Address;
  realmAuthority: Address;
  communityMint: Address;
  payer: Address;
  systemProgram?: Address;
  splTokenProgram: Address;
  rentSysvar: Address;
  councilMint?: Address;
  communityTokenHolding: Address;
  councilTokenHolding?: Address;
  realmConfig: Address;
  communityTokenConfig: GovTokenConfig;
  councilTokenConfig: GovTokenConfig;
  name: string;
  minCommunityWeight: bigint;
  communityVoteThreshold: VoteThreshold;
  programId?: Address;
}): Instruction {
  const accounts = [
    wr(p.realm),
    ro(p.realmAuthority),
    ro(p.communityMint),
    wr(p.communityTokenHolding),
    wrS(p.payer),
    ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
    ro(p.splTokenProgram),
    ro(p.rentSysvar),
    ...(p.councilMint ? [ro(p.councilMint)] : []),
    ...(p.councilTokenHolding ? [wr(p.councilTokenHolding)] : []),
    wr(p.realmConfig),
    ...(p.communityTokenConfig.voterWeightAddin
      ? [ro(p.communityTokenConfig.voterWeightAddin)]
      : []),
    ...(p.communityTokenConfig.maxVoterWeightAddin
      ? [ro(p.communityTokenConfig.maxVoterWeightAddin)]
      : []),
  ];
  const data = [
    borshString(p.name),
    borshBool(!!p.councilMint),
    encU64(p.minCommunityWeight),
    encodeVoteThreshold(p.communityVoteThreshold),
    encodeTokenConfig(p.communityTokenConfig),
    encodeTokenConfig(p.councilTokenConfig),
  ];
  return buildGovIx(
    GovernanceInstruction.CreateRealm,
    accounts,
    data,
    p.programId ?? SPL_GOVERNANCE_PROGRAM_ID,
  );
}

// depositGoverningTokens (disc=1)

export function depositGoverningTokens(p: {
  realm: Address;
  governingTokenHolding: Address;
  governingTokenSource: Address;
  governingTokenOwner: Address;
  governingTokenTransferAuthority: Address;
  tokenOwnerRecord: Address;
  payer: Address;
  systemProgram?: Address;
  splTokenProgram: Address;
  realmConfig: Address;
  amount: bigint;
  programId?: Address;
}): Instruction {
  const accounts = [
    ro(p.realm),
    wr(p.governingTokenHolding),
    wr(p.governingTokenSource),
    roS(p.governingTokenOwner),
    roS(p.governingTokenTransferAuthority),
    wr(p.tokenOwnerRecord),
    wrS(p.payer),
    ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
    ro(p.splTokenProgram),
    ro(p.realmConfig),
  ];
  return buildGovIx(
    GovernanceInstruction.DepositGoverningTokens,
    accounts,
    [encU64(p.amount)],
    p.programId ?? SPL_GOVERNANCE_PROGRAM_ID,
  );
}

// createGovernance (disc=4)─

export function createGovernance(p: {
  realm: Address;
  governance: Address;
  governanceSeed: Address;
  tokenOwnerRecord: Address;
  payer: Address;
  systemProgram?: Address;
  governanceAuthority: Address;
  realmConfig: Address;
  voterWeightRecord?: Address;
  config: GovernanceConfig;
  programId?: Address;
}): Instruction {
  const accounts = [
    ro(p.realm),
    wr(p.governance),
    ro(p.governanceSeed),
    ro(p.tokenOwnerRecord),
    wrS(p.payer),
    ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
    roS(p.governanceAuthority),
    ro(p.realmConfig),
    ...(p.voterWeightRecord ? [ro(p.voterWeightRecord)] : []),
  ];
  return buildGovIx(
    GovernanceInstruction.CreateGovernance,
    accounts,
    [encodeGovernanceConfig(p.config)],
    p.programId ?? SPL_GOVERNANCE_PROGRAM_ID,
  );
}

// createTokenOwnerRecord (disc=23)

export function createTokenOwnerRecord(p: {
  realm: Address;
  governingTokenOwner: Address;
  tokenOwnerRecord: Address;
  governingTokenMint: Address;
  payer: Address;
  systemProgram?: Address;
  programId?: Address;
}): Instruction {
  const accounts = [
    ro(p.realm),
    ro(p.governingTokenOwner),
    wr(p.tokenOwnerRecord),
    ro(p.governingTokenMint),
    wrS(p.payer),
    ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
  ];
  return buildGovIx(
    GovernanceInstruction.CreateTokenOwnerRecord,
    accounts,
    [],
    p.programId ?? SPL_GOVERNANCE_PROGRAM_ID,
  );
}

// createNativeTreasury (disc=25)─

export function createNativeTreasury(p: {
  governance: Address;
  nativeTreasury: Address;
  payer: Address;
  systemProgram?: Address;
  programId?: Address;
}): Instruction {
  const accounts = [
    ro(p.governance),
    wr(p.nativeTreasury),
    wrS(p.payer),
    ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
  ];
  return buildGovIx(
    GovernanceInstruction.CreateNativeTreasury,
    accounts,
    [],
    p.programId ?? SPL_GOVERNANCE_PROGRAM_ID,
  );
}

// createProposal (disc=6)───

export interface ProposalOption {
  label: string;
}

export function createProposal(p: {
  realm: Address;
  proposal: Address;
  governance: Address;
  tokenOwnerRecord: Address;
  governingTokenMint: Address;
  governanceAuthority: Address;
  payer: Address;
  systemProgram?: Address;
  realmConfig: Address;
  voterWeightRecord?: Address;
  proposalDeposit?: Address;
  name: string;
  descriptionLink: string;
  options: ProposalOption[];
  useDenyOption: boolean;
  proposalSeed: Address;
  programId?: Address;
}): Instruction {
  const accounts = [
    ro(p.realm),
    wr(p.proposal),
    wr(p.governance),
    wr(p.tokenOwnerRecord),
    ro(p.governingTokenMint),
    roS(p.governanceAuthority),
    wrS(p.payer),
    ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
    ro(p.realmConfig),
    ...(p.voterWeightRecord ? [ro(p.voterWeightRecord)] : []),
    ...(p.proposalDeposit ? [wr(p.proposalDeposit)] : []),
  ];
  // voteType: 0 = SingleChoice
  const voteType = new Uint8Array([0]);
  const optionEntries = p.options.map((o) => borshString(o.label));
  const data = [
    borshString(p.name),
    borshString(p.descriptionLink),
    voteType,
    borshVec(optionEntries),
    borshBool(p.useDenyOption),
    encAddr(p.proposalSeed),
  ];
  return buildGovIx(
    GovernanceInstruction.CreateProposal,
    accounts,
    data,
    p.programId ?? SPL_GOVERNANCE_PROGRAM_ID,
  );
}

// castVote (disc=13)

export enum VoteChoice {
  Approve = 0,
  Deny = 1,
  Abstain = 2,
  Veto = 3,
}

export function castVote(p: {
  realm: Address;
  governance: Address;
  proposal: Address;
  proposalTokenOwnerRecord: Address;
  voterTokenOwnerRecord: Address;
  governanceAuthority: Address;
  voteRecord: Address;
  governingTokenMint: Address;
  payer: Address;
  systemProgram?: Address;
  realmConfig: Address;
  voterWeightRecord?: Address;
  maxVoterWeightRecord?: Address;
  vote: VoteChoice;
  programId?: Address;
}): Instruction {
  const accounts = [
    ro(p.realm),
    wr(p.governance),
    wr(p.proposal),
    wr(p.proposalTokenOwnerRecord),
    wr(p.voterTokenOwnerRecord),
    roS(p.governanceAuthority),
    wr(p.voteRecord),
    ro(p.governingTokenMint),
    wrS(p.payer),
    ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
    ro(p.realmConfig),
    ...(p.voterWeightRecord ? [ro(p.voterWeightRecord)] : []),
    ...(p.maxVoterWeightRecord ? [ro(p.maxVoterWeightRecord)] : []),
  ];
  // Vote: Approve = { type: 0, choices: vec![{ rank: 0, weightPercentage: 100 }] }
  //        Deny = { type: 1 }
  let voteData: Uint8Array;
  if (p.vote === VoteChoice.Approve) {
    // Approve: type=0 + vec of 1 choice { rank: u8, weightPercentage: u8 }
    voteData = new Uint8Array([0, 1, 0, 0, 0, 0, 100]);
  } else if (p.vote === VoteChoice.Deny) {
    voteData = new Uint8Array([1]);
  } else if (p.vote === VoteChoice.Abstain) {
    voteData = new Uint8Array([2]);
  } else {
    // Veto
    voteData = new Uint8Array([3]);
  }
  return buildGovIx(
    GovernanceInstruction.CastVote,
    accounts,
    [voteData],
    p.programId ?? SPL_GOVERNANCE_PROGRAM_ID,
  );
}

// signOffProposal (disc=12)─

export function signOffProposal(p: {
  realm: Address;
  governance: Address;
  proposal: Address;
  signatory: Address;
  signatoryRecord?: Address;
  programId?: Address;
}): Instruction {
  const accounts = [
    ro(p.realm),
    ro(p.governance),
    wr(p.proposal),
    roS(p.signatory),
    ...(p.signatoryRecord ? [wr(p.signatoryRecord)] : []),
  ];
  return buildGovIx(
    GovernanceInstruction.SignOffProposal,
    accounts,
    [],
    p.programId ?? SPL_GOVERNANCE_PROGRAM_ID,
  );
}

// cancelProposal (disc=11)──

export function cancelProposal(p: {
  realm: Address;
  governance: Address;
  proposal: Address;
  tokenOwnerRecord: Address;
  governanceAuthority: Address;
  programId?: Address;
}): Instruction {
  const accounts = [
    ro(p.realm),
    wr(p.governance),
    wr(p.proposal),
    wr(p.tokenOwnerRecord),
    roS(p.governanceAuthority),
  ];
  return buildGovIx(
    GovernanceInstruction.CancelProposal,
    accounts,
    [],
    p.programId ?? SPL_GOVERNANCE_PROGRAM_ID,
  );
}

// finalizeVote (disc=14)

export function finalizeVote(p: {
  realm: Address;
  governance: Address;
  proposal: Address;
  tokenOwnerRecord: Address;
  governingTokenMint: Address;
  realmConfig: Address;
  maxVoterWeightRecord?: Address;
  programId?: Address;
}): Instruction {
  const accounts = [
    ro(p.realm),
    wr(p.governance),
    wr(p.proposal),
    wr(p.tokenOwnerRecord),
    ro(p.governingTokenMint),
    ro(p.realmConfig),
    ...(p.maxVoterWeightRecord ? [ro(p.maxVoterWeightRecord)] : []),
  ];
  return buildGovIx(
    GovernanceInstruction.FinalizeVote,
    accounts,
    [],
    p.programId ?? SPL_GOVERNANCE_PROGRAM_ID,
  );
}

// insertTransaction (disc=9)

/**
 * Encode a gill `Instruction` into SPL Governance's Borsh-encoded
 * `InstructionData` format (program_id + accounts vec + data vec).
 */
export function encodeInstructionData(ix: Instruction): Uint8Array {
  const programId = encAddr(ix.programAddress);
  const accts = ix.accounts ?? [];
  const acctLen = encU32(accts.length);
  const acctParts: Uint8Array[] = [];
  for (const a of accts) {
    const isSigner =
      a.role === AccountRole.READONLY_SIGNER || a.role === AccountRole.WRITABLE_SIGNER;
    const isWritable =
      a.role === AccountRole.WRITABLE || a.role === AccountRole.WRITABLE_SIGNER;
    acctParts.push(
      new Uint8Array(
        mergeBytes([encAddr(a.address), new Uint8Array([isSigner ? 1 : 0, isWritable ? 1 : 0])]),
      ),
    );
  }
  const ixData = ix.data ? new Uint8Array(ix.data) : new Uint8Array(0);
  const dataLen = encU32(ixData.length);
  return new Uint8Array(
    mergeBytes([programId, acctLen, ...acctParts, dataLen, ixData]),
  );
}

export function insertTransaction(p: {
  governance: Address;
  proposal: Address;
  tokenOwnerRecord: Address;
  governanceAuthority: Address;
  proposalTransaction: Address;
  payer: Address;
  systemProgram?: Address;
  rentSysvar?: Address;
  optionIndex: number;
  instructionIndex: number;
  instructions: Instruction[];
  programId?: Address;
}): Instruction {
  const RENT_SYSVAR = address("SysvarRent111111111111111111111111111111111");
  const accounts = [
    ro(p.governance),
    wr(p.proposal),
    ro(p.tokenOwnerRecord),
    roS(p.governanceAuthority),
    wr(p.proposalTransaction),
    wrS(p.payer),
    ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
    ro(p.rentSysvar ?? RENT_SYSVAR),
  ];
  // Data: option_index(u8) + index(u16 LE) + hold_up_time(u32 LE) + Vec<InstructionData>
  const encodedIxs = p.instructions.map(encodeInstructionData);
  const data = [
    encU8(p.optionIndex),
    encU16(p.instructionIndex),
    encU32(0), // hold_up_time = 0
    borshVec(encodedIxs),
  ];
  return buildGovIx(
    GovernanceInstruction.InsertTransaction,
    accounts,
    data,
    p.programId ?? SPL_GOVERNANCE_PROGRAM_ID,
  );
}

// executeTransaction (disc=16)

export function executeTransaction(p: {
  governance: Address;
  proposal: Address;
  proposalTransaction: Address;
  instructionAccounts: { address: Address; role: number }[];
  programId?: Address;
}): Instruction {
  const accounts = [
    ro(p.governance),
    wr(p.proposal),
    wr(p.proposalTransaction),
    ...p.instructionAccounts,
  ];
  return buildGovIx(
    GovernanceInstruction.ExecuteTransaction,
    accounts,
    [],
    p.programId ?? SPL_GOVERNANCE_PROGRAM_ID,
  );
}

// relinquishVote (disc=15)──

export function relinquishVote(p: {
  realm: Address;
  governance: Address;
  proposal: Address;
  tokenOwnerRecord: Address;
  voteRecord: Address;
  governingTokenMint: Address;
  governanceAuthority?: Address;
  beneficiary?: Address;
  programId?: Address;
}): Instruction {
  const accounts = [
    ro(p.realm),
    ro(p.governance),
    wr(p.proposal),
    wr(p.tokenOwnerRecord),
    wr(p.voteRecord),
    ro(p.governingTokenMint),
    ...(p.governanceAuthority ? [roS(p.governanceAuthority)] : []),
    ...(p.beneficiary ? [wr(p.beneficiary)] : []),
  ];
  return buildGovIx(
    GovernanceInstruction.RelinquishVote,
    accounts,
    [],
    p.programId ?? SPL_GOVERNANCE_PROGRAM_ID,
  );
}

// addCouncilMember helper──

/**
 * Returns [MintTo, DepositGoverningTokens] instructions for adding one
 * council member. Signers needed: mintAuthority + memberWallet + payer.
 */
export function addCouncilMember(p: {
  councilMint: Address;
  memberTokenAccount: Address;
  mintAuthority: Address;
  realm: Address;
  councilHolding: Address;
  memberWallet: Address;
  tokenOwnerRecord: Address;
  payer: Address;
  splTokenProgram: Address;
  realmConfig: Address;
  governanceProgram?: Address;
  amount?: bigint;
}): Instruction[] {
  const amount = p.amount ?? 1n;

  // SPL Token MintTo (disc=7): mint(w), destination(w), authority(s)
  const mintToData = new Uint8Array(9);
  mintToData[0] = 7;
  new DataView(mintToData.buffer).setBigUint64(1, amount, true);
  const mintToIx: Instruction = {
    programAddress: p.splTokenProgram,
    accounts: [
      wr(p.councilMint),
      wr(p.memberTokenAccount),
      roS(p.mintAuthority),
    ],
    data: mintToData,
  };

  // SPL Gov DepositGoverningTokens
  const depositIx = depositGoverningTokens({
    realm: p.realm,
    governingTokenHolding: p.councilHolding,
    governingTokenSource: p.memberTokenAccount,
    governingTokenOwner: p.memberWallet,
    governingTokenTransferAuthority: p.memberWallet,
    tokenOwnerRecord: p.tokenOwnerRecord,
    payer: p.payer,
    splTokenProgram: p.splTokenProgram,
    realmConfig: p.realmConfig,
    amount,
    programId: p.governanceProgram,
  });

  return [mintToIx, depositIx];
}
