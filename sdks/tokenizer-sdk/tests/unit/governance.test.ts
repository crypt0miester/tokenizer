import { describe, it, expect } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { address, type Address } from "gill";
import {
  SPL_GOVERNANCE_PROGRAM_ID,
  GovernanceAccountType,
  ProposalState,
  GovTokenType,
  VoteThresholdType,
  GovernanceInstruction,
} from "../../src/external/governance/constants.js";
import {
  decodeRealmV2,
  decodeTokenOwnerRecordV2,
  decodeGovernanceV2,
  decodeProposalV2,
} from "../../src/external/governance/accounts.js";
import {
  getRealmAddress,
  getTokenHoldingAddress,
  getTokenOwnerRecordAddress,
  getGovernanceAddress,
  getRealmConfigAddress,
  getNativeTreasuryAddress,
  getVoteRecordAddress,
  getSignatoryRecordAddress,
} from "../../src/external/governance/pdas.js";
import {
  createRealm,
  depositGoverningTokens,
  createGovernance,
  createTokenOwnerRecord,
  createNativeTreasury,
  createProposal,
  castVote,
  signOffProposal,
  cancelProposal,
  finalizeVote,
  relinquishVote,
  insertTransaction,
  executeTransaction,
  encodeGovernanceConfig,
  encodeInstructionData,
  VoteChoice,
  type GovernanceConfig,
} from "../../src/external/governance/instructions.js";
import {
  getProposalTransactionAddress,
} from "../../src/external/governance/pdas.js";

function randAddr(): Address {
  return address(Keypair.generate().publicKey.toBase58());
}

function writePubkey(buf: Uint8Array, offset: number, pk: PublicKey): void {
  buf.set(pk.toBytes(), offset);
}

function writeU64LE(buf: Uint8Array, offset: number, v: bigint): void {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  dv.setBigUint64(offset, v, true);
}

const customProgramId = randAddr();

// Constants─

describe("Governance Constants", () => {
  it("program ID is correct", () => {
    expect(SPL_GOVERNANCE_PROGRAM_ID).toBe("GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw");
  });

  it("GovernanceAccountType enum values", () => {
    expect(GovernanceAccountType.RealmV1).toBe(1);
    expect(GovernanceAccountType.RealmV2).toBe(16);
    expect(GovernanceAccountType.TokenOwnerRecordV1).toBe(2);
    expect(GovernanceAccountType.TokenOwnerRecordV2).toBe(17);
    expect(GovernanceAccountType.GovernanceV1).toBe(3);
    expect(GovernanceAccountType.GovernanceV2).toBe(18);
    expect(GovernanceAccountType.ProposalV1).toBe(5);
    expect(GovernanceAccountType.ProposalV2).toBe(14);
  });

  it("ProposalState enum values", () => {
    expect(ProposalState.Draft).toBe(0);
    expect(ProposalState.Voting).toBe(2);
    expect(ProposalState.Succeeded).toBe(3);
    expect(ProposalState.Completed).toBe(5);
    expect(ProposalState.Cancelled).toBe(6);
    expect(ProposalState.Defeated).toBe(7);
    expect(ProposalState.Vetoed).toBe(9);
  });

  it("GovTokenType enum values", () => {
    expect(GovTokenType.Liquid).toBe(0);
    expect(GovTokenType.Membership).toBe(1);
    expect(GovTokenType.Dormant).toBe(2);
  });

  it("VoteThresholdType enum values", () => {
    expect(VoteThresholdType.YesVotePercentage).toBe(0);
    expect(VoteThresholdType.QuorumPercentage).toBe(1);
    expect(VoteThresholdType.Disabled).toBe(2);
  });
});

// RealmV2 Decoder───

describe("decodeRealmV2", () => {
  it("decodes correctly", () => {
    const communityMint = Keypair.generate().publicKey;
    const data = new Uint8Array(64);
    data[0] = GovernanceAccountType.RealmV2;
    writePubkey(data, 1, communityMint);

    const realm = decodeRealmV2(data);
    expect(realm.accountType).toBe(GovernanceAccountType.RealmV2);
    expect(realm.communityMint).toBe(communityMint.toBase58());
  });

  it("throws on wrong account type", () => {
    const data = new Uint8Array(64);
    data[0] = GovernanceAccountType.GovernanceV2;
    expect(() => decodeRealmV2(data)).toThrow("invalid account type");
  });

  it("throws on short buffer", () => {
    const data = new Uint8Array(32);
    data[0] = GovernanceAccountType.RealmV2;
    expect(() => decodeRealmV2(data)).toThrow("expected at least 33");
  });
});

// TokenOwnerRecordV2 Decoder

describe("decodeTokenOwnerRecordV2", () => {
  it("decodes correctly", () => {
    const realm = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const owner = Keypair.generate().publicKey;
    const data = new Uint8Array(128);
    data[0] = GovernanceAccountType.TokenOwnerRecordV2;
    writePubkey(data, 1, realm);
    writePubkey(data, 33, mint);
    writePubkey(data, 65, owner);
    writeU64LE(data, 97, 1000000n);

    const record = decodeTokenOwnerRecordV2(data);
    expect(record.accountType).toBe(GovernanceAccountType.TokenOwnerRecordV2);
    expect(record.realm).toBe(realm.toBase58());
    expect(record.governingTokenMint).toBe(mint.toBase58());
    expect(record.governingTokenOwner).toBe(owner.toBase58());
    expect(record.governingTokenDepositAmount).toBe(1000000n);
  });

  it("throws on wrong account type", () => {
    const data = new Uint8Array(128);
    data[0] = GovernanceAccountType.RealmV2;
    expect(() => decodeTokenOwnerRecordV2(data)).toThrow("invalid account type");
  });

  it("throws on short buffer", () => {
    const data = new Uint8Array(100);
    data[0] = GovernanceAccountType.TokenOwnerRecordV2;
    expect(() => decodeTokenOwnerRecordV2(data)).toThrow("expected at least 105");
  });
});

// GovernanceV2 Decoder──

describe("decodeGovernanceV2", () => {
  it("decodes correctly", () => {
    const realm = Keypair.generate().publicKey;
    const seed = Keypair.generate().publicKey;
    const data = new Uint8Array(128);
    data[0] = GovernanceAccountType.GovernanceV2;
    writePubkey(data, 1, realm);
    writePubkey(data, 33, seed);

    const gov = decodeGovernanceV2(data);
    expect(gov.accountType).toBe(GovernanceAccountType.GovernanceV2);
    expect(gov.realm).toBe(realm.toBase58());
    expect(gov.governanceSeed).toBe(seed.toBase58());
  });

  it("throws on wrong account type", () => {
    const data = new Uint8Array(128);
    data[0] = GovernanceAccountType.ProposalV2;
    expect(() => decodeGovernanceV2(data)).toThrow("invalid account type");
  });

  it("throws on short buffer", () => {
    const data = new Uint8Array(60);
    data[0] = GovernanceAccountType.GovernanceV2;
    expect(() => decodeGovernanceV2(data)).toThrow("expected at least 65");
  });
});

// ProposalV2 Decoder

describe("decodeProposalV2", () => {
  it("decodes correctly", () => {
    const governance = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const tor = Keypair.generate().publicKey;
    const data = new Uint8Array(128);
    data[0] = GovernanceAccountType.ProposalV2;
    writePubkey(data, 1, governance);
    writePubkey(data, 33, mint);
    data[65] = ProposalState.Voting;
    writePubkey(data, 66, tor);

    const proposal = decodeProposalV2(data);
    expect(proposal.accountType).toBe(GovernanceAccountType.ProposalV2);
    expect(proposal.governance).toBe(governance.toBase58());
    expect(proposal.governingTokenMint).toBe(mint.toBase58());
    expect(proposal.state).toBe(ProposalState.Voting);
    expect(proposal.tokenOwnerRecord).toBe(tor.toBase58());
  });

  it("throws on wrong account type", () => {
    const data = new Uint8Array(128);
    data[0] = GovernanceAccountType.RealmV2;
    expect(() => decodeProposalV2(data)).toThrow("invalid account type");
  });

  it("throws on short buffer", () => {
    const data = new Uint8Array(90);
    data[0] = GovernanceAccountType.ProposalV2;
    expect(() => decodeProposalV2(data)).toThrow("expected at least 98");
  });
});

// Governance PDAs───

describe("getRealmAddress", () => {
  it("is deterministic", async () => {
    const [a1] = await getRealmAddress("test");
    const [a2] = await getRealmAddress("test");
    expect(a1).toBe(a2);
  });

  it("different input → different address", async () => {
    const [a1] = await getRealmAddress("test1");
    const [a2] = await getRealmAddress("test2");
    expect(a1).not.toBe(a2);
  });

  it("changes with custom programId", async () => {
    const [a1] = await getRealmAddress("test");
    const [a2] = await getRealmAddress("test", customProgramId);
    expect(a1).not.toBe(a2);
  });
});

describe("getTokenHoldingAddress", () => {
  const realm = randAddr();
  const mint = randAddr();
  it("is deterministic", async () => {
    const [a1] = await getTokenHoldingAddress(realm, mint);
    const [a2] = await getTokenHoldingAddress(realm, mint);
    expect(a1).toBe(a2);
  });

  it("different input → different address", async () => {
    const [a1] = await getTokenHoldingAddress(realm, mint);
    const [a2] = await getTokenHoldingAddress(realm, randAddr());
    expect(a1).not.toBe(a2);
  });

  it("changes with custom programId", async () => {
    const [a1] = await getTokenHoldingAddress(realm, mint);
    const [a2] = await getTokenHoldingAddress(realm, mint, customProgramId);
    expect(a1).not.toBe(a2);
  });
});

describe("getTokenOwnerRecordAddress", () => {
  const realm = randAddr();
  const mint = randAddr();
  const owner = randAddr();
  it("is deterministic", async () => {
    const [a1] = await getTokenOwnerRecordAddress(realm, mint, owner);
    const [a2] = await getTokenOwnerRecordAddress(realm, mint, owner);
    expect(a1).toBe(a2);
  });

  it("different input → different address", async () => {
    const [a1] = await getTokenOwnerRecordAddress(realm, mint, owner);
    const [a2] = await getTokenOwnerRecordAddress(realm, mint, randAddr());
    expect(a1).not.toBe(a2);
  });

  it("changes with custom programId", async () => {
    const [a1] = await getTokenOwnerRecordAddress(realm, mint, owner);
    const [a2] = await getTokenOwnerRecordAddress(realm, mint, owner, customProgramId);
    expect(a1).not.toBe(a2);
  });
});

describe("getGovernanceAddress", () => {
  const realm = randAddr();
  const seed = randAddr();
  it("is deterministic", async () => {
    const [a1] = await getGovernanceAddress(realm, seed);
    const [a2] = await getGovernanceAddress(realm, seed);
    expect(a1).toBe(a2);
  });

  it("different input → different address", async () => {
    const [a1] = await getGovernanceAddress(realm, seed);
    const [a2] = await getGovernanceAddress(realm, randAddr());
    expect(a1).not.toBe(a2);
  });

  it("changes with custom programId", async () => {
    const [a1] = await getGovernanceAddress(realm, seed);
    const [a2] = await getGovernanceAddress(realm, seed, customProgramId);
    expect(a1).not.toBe(a2);
  });
});

describe("getRealmConfigAddress", () => {
  const realm = randAddr();
  it("is deterministic", async () => {
    const [a1] = await getRealmConfigAddress(realm);
    const [a2] = await getRealmConfigAddress(realm);
    expect(a1).toBe(a2);
  });

  it("different input → different address", async () => {
    const [a1] = await getRealmConfigAddress(realm);
    const [a2] = await getRealmConfigAddress(randAddr());
    expect(a1).not.toBe(a2);
  });

  it("changes with custom programId", async () => {
    const [a1] = await getRealmConfigAddress(realm);
    const [a2] = await getRealmConfigAddress(realm, customProgramId);
    expect(a1).not.toBe(a2);
  });
});

describe("getNativeTreasuryAddress", () => {
  const gov = randAddr();
  it("is deterministic", async () => {
    const [a1] = await getNativeTreasuryAddress(gov);
    const [a2] = await getNativeTreasuryAddress(gov);
    expect(a1).toBe(a2);
  });

  it("different input → different address", async () => {
    const [a1] = await getNativeTreasuryAddress(gov);
    const [a2] = await getNativeTreasuryAddress(randAddr());
    expect(a1).not.toBe(a2);
  });

  it("changes with custom programId", async () => {
    const [a1] = await getNativeTreasuryAddress(gov);
    const [a2] = await getNativeTreasuryAddress(gov, customProgramId);
    expect(a1).not.toBe(a2);
  });
});

describe("getVoteRecordAddress", () => {
  const proposal = randAddr();
  const tor = randAddr();
  it("is deterministic", async () => {
    const [a1] = await getVoteRecordAddress(proposal, tor);
    const [a2] = await getVoteRecordAddress(proposal, tor);
    expect(a1).toBe(a2);
  });

  it("different input → different address", async () => {
    const [a1] = await getVoteRecordAddress(proposal, tor);
    const [a2] = await getVoteRecordAddress(proposal, randAddr());
    expect(a1).not.toBe(a2);
  });

  it("changes with custom programId", async () => {
    const [a1] = await getVoteRecordAddress(proposal, tor);
    const [a2] = await getVoteRecordAddress(proposal, tor, customProgramId);
    expect(a1).not.toBe(a2);
  });
});

describe("getSignatoryRecordAddress", () => {
  const proposal = randAddr();
  const signatory = randAddr();
  it("is deterministic", async () => {
    const [a1] = await getSignatoryRecordAddress(proposal, signatory);
    const [a2] = await getSignatoryRecordAddress(proposal, signatory);
    expect(a1).toBe(a2);
  });

  it("different input → different address", async () => {
    const [a1] = await getSignatoryRecordAddress(proposal, signatory);
    const [a2] = await getSignatoryRecordAddress(proposal, randAddr());
    expect(a1).not.toBe(a2);
  });

  it("changes with custom programId", async () => {
    const [a1] = await getSignatoryRecordAddress(proposal, signatory);
    const [a2] = await getSignatoryRecordAddress(proposal, signatory, customProgramId);
    expect(a1).not.toBe(a2);
  });
});

// Governance Instructions───

describe("createRealm", () => {
  it("disc=0, correct structure", () => {
    const ix = createRealm({
      realm: randAddr(),
      realmAuthority: randAddr(),
      communityMint: randAddr(),
      payer: randAddr(),
      splTokenProgram: randAddr(),
      rentSysvar: randAddr(),
      communityTokenHolding: randAddr(),
      realmConfig: randAddr(),
      communityTokenConfig: { tokenType: GovTokenType.Liquid },
      councilTokenConfig: { tokenType: GovTokenType.Liquid },
      name: "TestRealm",
      minCommunityWeight: 1n,
      communityVoteThreshold: { type: VoteThresholdType.YesVotePercentage, value: 60 },
    });
    expect(ix.programAddress).toBe(SPL_GOVERNANCE_PROGRAM_ID);
    expect(ix.data![0]).toBe(GovernanceInstruction.CreateRealm);
  });
});

describe("depositGoverningTokens", () => {
  it("disc=1", () => {
    const ix = depositGoverningTokens({
      realm: randAddr(),
      governingTokenHolding: randAddr(),
      governingTokenSource: randAddr(),
      governingTokenOwner: randAddr(),
      governingTokenTransferAuthority: randAddr(),
      tokenOwnerRecord: randAddr(),
      payer: randAddr(),
      splTokenProgram: randAddr(),
      realmConfig: randAddr(),
      amount: 1000n,
    });
    expect(ix.data![0]).toBe(GovernanceInstruction.DepositGoverningTokens);
    expect(ix.accounts!.length).toBe(10);
  });
});

describe("createGovernance", () => {
  it("disc=4, includes config data", () => {
    const config: GovernanceConfig = {
      communityVoteThreshold: { type: VoteThresholdType.YesVotePercentage, value: 60 },
      minCommunityWeightToCreateProposal: 1n,
      minTransactionHoldUpTime: 0,
      votingBaseTime: 3600,
      communityVoteTipping: 0,
      councilVoteThreshold: { type: VoteThresholdType.YesVotePercentage, value: 60 },
      councilVetoVoteThreshold: { type: VoteThresholdType.Disabled, value: 0 },
      minCouncilWeightToCreateProposal: 1n,
      councilVoteTipping: 0,
      communityVetoVoteThreshold: { type: VoteThresholdType.Disabled, value: 0 },
      votingCoolOffTime: 0,
      depositExemptProposalCount: 0,
    };
    const ix = createGovernance({
      realm: randAddr(),
      governance: randAddr(),
      governanceSeed: randAddr(),
      tokenOwnerRecord: randAddr(),
      payer: randAddr(),
      governanceAuthority: randAddr(),
      realmConfig: randAddr(),
      config,
    });
    expect(ix.data![0]).toBe(GovernanceInstruction.CreateGovernance);
    expect(ix.accounts!.length).toBe(8);
  });
});

describe("createTokenOwnerRecord", () => {
  it("disc=23, 6 accounts", () => {
    const ix = createTokenOwnerRecord({
      realm: randAddr(),
      governingTokenOwner: randAddr(),
      tokenOwnerRecord: randAddr(),
      governingTokenMint: randAddr(),
      payer: randAddr(),
    });
    expect(ix.data![0]).toBe(GovernanceInstruction.CreateTokenOwnerRecord);
    expect(ix.accounts!.length).toBe(6);
  });
});

describe("createNativeTreasury (governance)", () => {
  it("disc=25, 4 accounts", () => {
    const ix = createNativeTreasury({
      governance: randAddr(),
      nativeTreasury: randAddr(),
      payer: randAddr(),
    });
    expect(ix.data![0]).toBe(GovernanceInstruction.CreateNativeTreasury);
    expect(ix.accounts!.length).toBe(4);
  });
});

describe("createProposal", () => {
  it("disc=6, includes borsh-encoded args", () => {
    const ix = createProposal({
      realm: randAddr(),
      proposal: randAddr(),
      governance: randAddr(),
      tokenOwnerRecord: randAddr(),
      governingTokenMint: randAddr(),
      governanceAuthority: randAddr(),
      payer: randAddr(),
      realmConfig: randAddr(),
      name: "Proposal",
      descriptionLink: "https://example.com",
      options: [{ label: "Yes" }],
      useDenyOption: true,
      proposalSeed: randAddr(),
    });
    expect(ix.data![0]).toBe(GovernanceInstruction.CreateProposal);
    expect(ix.accounts!.length).toBeGreaterThanOrEqual(9);
  });
});

describe("castVote", () => {
  it("disc=13, approve vote data", () => {
    const ix = castVote({
      realm: randAddr(),
      governance: randAddr(),
      proposal: randAddr(),
      proposalTokenOwnerRecord: randAddr(),
      voterTokenOwnerRecord: randAddr(),
      governanceAuthority: randAddr(),
      voteRecord: randAddr(),
      governingTokenMint: randAddr(),
      payer: randAddr(),
      realmConfig: randAddr(),
      vote: VoteChoice.Approve,
    });
    expect(ix.data![0]).toBe(GovernanceInstruction.CastVote);
    // Vote data for Approve: [0, 1, 0, 0, 0, 0, 100]
    expect(ix.data![1]).toBe(0); // type = Approve
    expect(ix.accounts!.length).toBeGreaterThanOrEqual(11);
  });

  it("deny vote data", () => {
    const ix = castVote({
      realm: randAddr(),
      governance: randAddr(),
      proposal: randAddr(),
      proposalTokenOwnerRecord: randAddr(),
      voterTokenOwnerRecord: randAddr(),
      governanceAuthority: randAddr(),
      voteRecord: randAddr(),
      governingTokenMint: randAddr(),
      payer: randAddr(),
      realmConfig: randAddr(),
      vote: VoteChoice.Deny,
    });
    expect(ix.data![1]).toBe(1); // type = Deny
  });
});

describe("signOffProposal", () => {
  it("disc=12", () => {
    const ix = signOffProposal({
      realm: randAddr(),
      governance: randAddr(),
      proposal: randAddr(),
      signatory: randAddr(),
    });
    expect(ix.data![0]).toBe(GovernanceInstruction.SignOffProposal);
    expect(ix.accounts!.length).toBe(4);
  });
});

describe("cancelProposal", () => {
  it("disc=11, 5 accounts", () => {
    const ix = cancelProposal({
      realm: randAddr(),
      governance: randAddr(),
      proposal: randAddr(),
      tokenOwnerRecord: randAddr(),
      governanceAuthority: randAddr(),
    });
    expect(ix.data![0]).toBe(GovernanceInstruction.CancelProposal);
    expect(ix.accounts!.length).toBe(5);
  });
});

describe("finalizeVote", () => {
  it("disc=14, 6 base accounts", () => {
    const ix = finalizeVote({
      realm: randAddr(),
      governance: randAddr(),
      proposal: randAddr(),
      tokenOwnerRecord: randAddr(),
      governingTokenMint: randAddr(),
      realmConfig: randAddr(),
    });
    expect(ix.data![0]).toBe(GovernanceInstruction.FinalizeVote);
    expect(ix.accounts!.length).toBe(6);
  });
});

describe("relinquishVote", () => {
  it("disc=15, 6 base accounts", () => {
    const ix = relinquishVote({
      realm: randAddr(),
      governance: randAddr(),
      proposal: randAddr(),
      tokenOwnerRecord: randAddr(),
      voteRecord: randAddr(),
      governingTokenMint: randAddr(),
    });
    expect(ix.data![0]).toBe(GovernanceInstruction.RelinquishVote);
    expect(ix.accounts!.length).toBe(6);
  });
});

// encodeGovernanceConfig

describe("encodeGovernanceConfig", () => {
  const config: GovernanceConfig = {
    communityVoteThreshold: { type: VoteThresholdType.YesVotePercentage, value: 60 },
    minCommunityWeightToCreateProposal: 1n,
    minTransactionHoldUpTime: 0,
    votingBaseTime: 3600,
    communityVoteTipping: 0,
    councilVoteThreshold: { type: VoteThresholdType.YesVotePercentage, value: 60 },
    councilVetoVoteThreshold: { type: VoteThresholdType.Disabled, value: 0 },
    minCouncilWeightToCreateProposal: 1n,
    councilVoteTipping: 0,
    communityVetoVoteThreshold: { type: VoteThresholdType.Disabled, value: 0 },
    votingCoolOffTime: 0,
    depositExemptProposalCount: 0,
  };

  it("produces correct byte length", () => {
    const data = encodeGovernanceConfig(config);
    // 2 + 8 + 4 + 4 + 1 + 2 + 1 + 8 + 1 + 1 + 4 + 1 = 37 bytes
    // (Disabled variants encode as 1 byte, not 2)
    expect(data.length).toBe(37);
  });

  it("starts with community vote threshold", () => {
    const data = encodeGovernanceConfig(config);
    expect(data[0]).toBe(VoteThresholdType.YesVotePercentage);
    expect(data[1]).toBe(60);
  });
});

// insertTransaction──

describe("insertTransaction", () => {
  it("disc=9, 8 accounts, correct data structure", () => {
    const dummyIx = {
      programAddress: randAddr(),
      accounts: [
        { address: randAddr(), role: 0 /* READONLY */ },
        { address: randAddr(), role: 1 /* WRITABLE */ },
      ],
      data: new Uint8Array([1, 2, 3]),
    };
    const ix = insertTransaction({
      governance: randAddr(),
      proposal: randAddr(),
      tokenOwnerRecord: randAddr(),
      governanceAuthority: randAddr(),
      proposalTransaction: randAddr(),
      payer: randAddr(),
      optionIndex: 0,
      instructionIndex: 0,
      instructions: [dummyIx],
    });
    expect(ix.data![0]).toBe(GovernanceInstruction.InsertTransaction);
    expect(ix.accounts!.length).toBe(8);
    // option_index at byte 1
    expect(ix.data![1]).toBe(0);
    // instruction_index at bytes 2-3 (u16 LE)
    expect(ix.data![2]).toBe(0);
    expect(ix.data![3]).toBe(0);
  });
});

// executeTransaction─

describe("executeTransaction", () => {
  it("disc=16, 3 base accounts + instruction accounts", () => {
    const extraAccts = [
      { address: randAddr(), role: 0 },
      { address: randAddr(), role: 1 },
    ];
    const ix = executeTransaction({
      governance: randAddr(),
      proposal: randAddr(),
      proposalTransaction: randAddr(),
      instructionAccounts: extraAccts,
    });
    expect(ix.data![0]).toBe(GovernanceInstruction.ExecuteTransaction);
    expect(ix.accounts!.length).toBe(3 + extraAccts.length);
  });
});

// encodeInstructionData──

describe("encodeInstructionData", () => {
  it("encodes program_id + accounts vec + data vec", () => {
    const programAddr = randAddr();
    const acctAddr = randAddr();
    const ix = {
      programAddress: programAddr,
      accounts: [{ address: acctAddr, role: 3 /* WRITABLE_SIGNER */ }],
      data: new Uint8Array([0xAA, 0xBB]),
    };
    const encoded = encodeInstructionData(ix);
    // 32 (programId) + 4 (vec len) + 34 (1 account: 32+1+1) + 4 (data len) + 2 (data) = 76
    expect(encoded.length).toBe(76);
    // First 32 bytes = program_id
    // accounts vec length at byte 32 = 1
    expect(new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength).getUint32(32, true)).toBe(1);
    // After account entry: is_signer=1, is_writable=1 for WRITABLE_SIGNER
    expect(encoded[32 + 4 + 32]).toBe(1); // is_signer
    expect(encoded[32 + 4 + 33]).toBe(1); // is_writable
    // data vec length at byte 70
    expect(new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength).getUint32(70, true)).toBe(2);
    expect(encoded[74]).toBe(0xAA);
    expect(encoded[75]).toBe(0xBB);
  });
});

// getProposalTransactionAddress

describe("getProposalTransactionAddress", () => {
  const proposal = randAddr();
  it("is deterministic", async () => {
    const [a1] = await getProposalTransactionAddress(proposal, 0, 0);
    const [a2] = await getProposalTransactionAddress(proposal, 0, 0);
    expect(a1).toBe(a2);
  });

  it("different option_index → different address", async () => {
    const [a1] = await getProposalTransactionAddress(proposal, 0, 0);
    const [a2] = await getProposalTransactionAddress(proposal, 1, 0);
    expect(a1).not.toBe(a2);
  });

  it("different instruction_index → different address", async () => {
    const [a1] = await getProposalTransactionAddress(proposal, 0, 0);
    const [a2] = await getProposalTransactionAddress(proposal, 0, 1);
    expect(a1).not.toBe(a2);
  });

  it("changes with custom programId", async () => {
    const [a1] = await getProposalTransactionAddress(proposal, 0, 0);
    const [a2] = await getProposalTransactionAddress(proposal, 0, 0, customProgramId);
    expect(a1).not.toBe(a2);
  });
});
