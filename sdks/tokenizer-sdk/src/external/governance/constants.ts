import { type Address, address } from "gill";

export const SPL_GOVERNANCE_PROGRAM_ID: Address = address(
  "GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw",
);

export const GOVERNANCE_SEED = "governance";
export const ACCOUNT_GOVERNANCE_SEED = "account-governance";
export const REALM_CONFIG_SEED = "realm-config";
export const NATIVE_TREASURY_SEED = "native-treasury";

export enum GovernanceAccountType {
  RealmV1 = 1,
  RealmV2 = 16,
  TokenOwnerRecordV1 = 2,
  TokenOwnerRecordV2 = 17,
  GovernanceV1 = 3,
  GovernanceV2 = 18,
  ProposalV1 = 5,
  ProposalV2 = 14,
  VoteRecordV2 = 19,
}

export enum ProposalState {
  Draft = 0,
  SigningOff = 1,
  Voting = 2,
  Succeeded = 3,
  Executing = 4,
  Completed = 5,
  Cancelled = 6,
  Defeated = 7,
  ExecutingWithErrors = 8,
  Vetoed = 9,
}

export enum GovTokenType {
  Liquid = 0,
  Membership = 1,
  Dormant = 2,
}

export enum VoteThresholdType {
  YesVotePercentage = 0,
  QuorumPercentage = 1,
  Disabled = 2,
}

export enum GovernanceInstruction {
  CreateRealm = 0,
  DepositGoverningTokens = 1,
  WithdrawGoverningTokens = 2,
  SetGovernanceDelegate = 3,
  CreateGovernance = 4,
  CreateProposal = 6,
  AddSignatory = 7,
  CancelProposal = 11,
  SignOffProposal = 12,
  CastVote = 13,
  FinalizeVote = 14,
  RelinquishVote = 15,
  InsertTransaction = 9,
  ExecuteTransaction = 16,
  CreateTokenOwnerRecord = 23,
  CreateNativeTreasury = 25,
}
