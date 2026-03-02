import type { Address } from "gill";
import { SYSTEM_PROGRAM_ADDRESS } from "gill/programs";
import { TOKEN_PROGRAM_ADDRESS } from "gill/programs/token";
import { InstructionType } from "../constants.js";
import { buildIx, concat, encAddr, encU8, encU32, ro, roS, wr, wrS } from "./shared.js";

const utf8 = new TextEncoder();

/** Discriminant 70 — Create a governance registrar for an asset. */
export function createRegistrar(p: {
  realm: Address;
  governingTokenMint: Address;
  assetAccount: Address;
  registrarAccount: Address;
  realmAuthority: Address;
  payer: Address;
  systemProgram?: Address;
  governanceProgramId: Address;
  programId?: Address;
}) {
  return buildIx(
    InstructionType.CreateRegistrar,
    [
      ro(p.realm),
      ro(p.governingTokenMint),
      ro(p.assetAccount),
      wr(p.registrarAccount),
      roS(p.realmAuthority),
      wrS(p.payer),
      ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
    ],
    encAddr(p.governanceProgramId),
    p.programId,
  );
}

/** Discriminant 71 — Create a voter weight record. */
export function createVoterWeightRecord(p: {
  registrarAccount: Address;
  voterWeightRecordAccount: Address;
  governingTokenOwner: Address;
  payer: Address;
  systemProgram?: Address;
  programId?: Address;
}) {
  return buildIx(
    InstructionType.CreateVoterWeightRecord,
    [
      ro(p.registrarAccount),
      wr(p.voterWeightRecordAccount),
      ro(p.governingTokenOwner),
      wrS(p.payer),
      ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
    ],
    undefined,
    p.programId,
  );
}

/** Discriminant 72 — Create a max voter weight record. */
export function createMaxVoterWeightRecord(p: {
  registrarAccount: Address;
  assetAccount: Address;
  maxVoterWeightRecordAccount: Address;
  realm: Address;
  payer: Address;
  systemProgram?: Address;
  programId?: Address;
}) {
  return buildIx(
    InstructionType.CreateMaxVoterWeightRecord,
    [
      ro(p.registrarAccount),
      ro(p.assetAccount),
      wr(p.maxVoterWeightRecordAccount),
      ro(p.realm),
      wrS(p.payer),
      ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
    ],
    undefined,
    p.programId,
  );
}

/** Discriminant 73 — Update voter weight record (cast vote / comment / survey). */
export function updateVoterWeightRecord(p: {
  registrarAccount: Address;
  voterWeightRecordAccount: Address;
  voterTokenOwnerRecord: Address;
  voterAuthority: Address;
  assetTokenAccounts: Address[];
  action: number;
  actionTarget: Address;
  programId?: Address;
}) {
  const accounts = [
    ro(p.registrarAccount),
    wr(p.voterWeightRecordAccount),
    ro(p.voterTokenOwnerRecord),
    roS(p.voterAuthority),
  ];
  for (const at of p.assetTokenAccounts) {
    accounts.push(wr(at));
  }
  return buildIx(
    InstructionType.UpdateVoterWeightRecord,
    accounts,
    concat(encU8(p.action), encAddr(p.actionTarget)),
    p.programId,
  );
}

/** Discriminant 74 — Relinquish voter weight after vote completes. */
export function relinquishVoterWeight(p: {
  registrarAccount: Address;
  governanceProgram: Address;
  proposal: Address;
  assetTokenAccounts: Address[];
  programId?: Address;
}) {
  const accounts = [ro(p.registrarAccount), ro(p.governanceProgram), ro(p.proposal)];
  for (const at of p.assetTokenAccounts) {
    accounts.push(wr(at));
  }
  return buildIx(InstructionType.RelinquishVoterWeight, accounts, undefined, p.programId);
}

/** Council member descriptor for realm creation. */
export interface CouncilMember {
  tokenSource: Address;
  wallet: Address;
  tokenOwnerRecord: Address;
}

/** Discriminant 75 — Create protocol realm + governance + native treasury via SPL Governance CPI. */
export function createProtocolRealm(p: {
  config: Address;
  realm: Address;
  realmAuthority: Address;
  communityMint: Address;
  communityHolding: Address;
  councilMint: Address;
  councilHolding: Address;
  realmConfig: Address;
  payer: Address;
  governanceProgram: Address;
  systemProgram?: Address;
  splTokenProgram?: Address;
  rentSysvar: Address;
  governance: Address;
  nativeTreasury: Address;
  realmName: string;
  governanceConfigData: Uint8Array;
  members?: CouncilMember[];
  programId?: Address;
}) {
  const nameBytes = utf8.encode(p.realmName);
  const members = p.members ?? [];
  const accounts = [
    wr(p.config),
    wr(p.realm),
    roS(p.realmAuthority),
    ro(p.communityMint),
    wr(p.communityHolding),
    ro(p.councilMint),
    wr(p.councilHolding),
    wr(p.realmConfig),
    wrS(p.payer),
    ro(p.governanceProgram),
    ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
    ro(p.splTokenProgram ?? TOKEN_PROGRAM_ADDRESS),
    ro(p.rentSysvar),
    wr(p.governance),
    wr(p.nativeTreasury),
  ];
  for (const m of members) {
    accounts.push(wr(m.tokenSource), roS(m.wallet), wr(m.tokenOwnerRecord));
  }
  return buildIx(
    InstructionType.CreateProtocolRealm,
    accounts,
    concat(encU32(nameBytes.length), nameBytes, p.governanceConfigData, encU8(members.length)),
    p.programId,
  );
}

/** Discriminant 76 — Create org realm + governance + native treasury via SPL Governance CPI. */
export function createOrgRealm(p: {
  config: Address;
  orgAccount: Address;
  realm: Address;
  realmAuthority: Address;
  councilMint: Address;
  councilHolding: Address;
  communityMint: Address;
  communityHolding: Address;
  realmConfig: Address;
  authority: Address;
  payer: Address;
  governanceProgram: Address;
  systemProgram?: Address;
  splTokenProgram?: Address;
  rentSysvar: Address;
  voterWeightAddin: Address;
  maxVoterWeightAddin: Address;
  governance: Address;
  nativeTreasury: Address;
  realmName: string;
  governanceConfigData: Uint8Array;
  members?: CouncilMember[];
  programId?: Address;
}) {
  const nameBytes = utf8.encode(p.realmName);
  const members = p.members ?? [];
  const accounts = [
    ro(p.config),
    wr(p.orgAccount),
    wr(p.realm),
    roS(p.realmAuthority),
    ro(p.councilMint),
    wr(p.councilHolding),
    ro(p.communityMint),
    wr(p.communityHolding),
    wr(p.realmConfig),
    roS(p.authority),
    wrS(p.payer),
    ro(p.governanceProgram),
    ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
    ro(p.splTokenProgram ?? TOKEN_PROGRAM_ADDRESS),
    ro(p.rentSysvar),
    ro(p.voterWeightAddin),
    ro(p.maxVoterWeightAddin),
    wr(p.governance),
    wr(p.nativeTreasury),
  ];
  for (const m of members) {
    accounts.push(wr(m.tokenSource), roS(m.wallet), wr(m.tokenOwnerRecord));
  }
  return buildIx(
    InstructionType.CreateOrgRealm,
    accounts,
    concat(encU32(nameBytes.length), nameBytes, p.governanceConfigData, encU8(members.length)),
    p.programId,
  );
}

/** Discriminant 77 — Create asset governance + native treasury via SPL Governance CPI.
 *
 * Validates authority (org authority or operator), asset ownership,
 * and that governanceConfigData's minCommunityWeightToCreateProposal
 * meets the protocol's min_proposal_weight_bps threshold.
 */
export function createAssetGovernance(p: {
  config: Address;
  organization: Address;
  asset: Address;
  authority: Address;
  realm: Address;
  governance: Address;
  tokenOwnerRecord: Address;
  governanceAuthority: Address;
  realmConfig: Address;
  payer: Address;
  governanceProgram: Address;
  systemProgram?: Address;
  nativeTreasury: Address;
  voterWeightRecord?: Address;
  governanceConfigData: Uint8Array;
  programId?: Address;
}) {
  const accounts = [
    ro(p.config),
    ro(p.organization),
    wr(p.asset),
    roS(p.authority),
    ro(p.realm),
    wr(p.governance),
    ro(p.tokenOwnerRecord),
    roS(p.governanceAuthority),
    ro(p.realmConfig),
    wrS(p.payer),
    ro(p.governanceProgram),
    ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
    wr(p.nativeTreasury),
  ];
  if (p.voterWeightRecord) {
    accounts.push(ro(p.voterWeightRecord));
  }
  return buildIx(
    InstructionType.CreateAssetGovernance,
    accounts,
    p.governanceConfigData,
    p.programId,
  );
}