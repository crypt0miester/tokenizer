import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import { address, type Address, AccountRole } from "gill";
import { InstructionType, TOKENIZER_PROGRAM_ID } from "../../src/constants.js";
import {
  initializeProtocol,
  updateConfigFeeBps,
  updateConfigFeeTreasury,
  updateConfigAddMint,
  updateConfigRemoveMint,
  updateConfigSetOperator,
  pauseProtocol,
  unpauseProtocol,
} from "../../src/instructions/protocol.js";
import {
  registerOrganization,
  deregisterOrganization,
  updateOrgAddMint,
  updateOrgRemoveMint,
} from "../../src/instructions/organization.js";
import {
  initAsset,
  mintToken,
  updateMetadata,
} from "../../src/instructions/asset.js";
import {
  createRound,
  invest,
  finalizeRound,
  mintRoundTokens,
  refundInvestment,
  cancelRound,
} from "../../src/instructions/fundraising.js";
import {
  listForSale,
  delist,
  buyListedToken,
  makeOffer,
  acceptOffer,
  rejectOffer,
  cancelOffer,
  consolidateTokens,
} from "../../src/instructions/market.js";
import {
  createDistribution,
  claimDistribution,
  closeDistribution,
} from "../../src/instructions/distribution.js";
import {
  burnAndRemint,
  splitAndRemint,
} from "../../src/instructions/emergency.js";
import {
  createRegistrar,
  createVoterWeightRecord,
  createMaxVoterWeightRecord,
  updateVoterWeightRecord,
  relinquishVoterWeight,
  createProtocolRealm,
  createOrgRealm,
  createAssetGovernance,
} from "../../src/instructions/governance.js";
import {
  createBuyoutOffer,
  fundBuyoutOffer,
  approveBuyout,
  settleBuyout,
  completeBuyout,
  cancelBuyout,
} from "../../src/instructions/buyout.js";

// ── Helpers ──────────────────────────────────────────────────────────

function randAddr(): Address {
  return address(Keypair.generate().publicKey.toBase58());
}

function readU16LE(data: { readonly [index: number]: number }): number {
  return data[0] | (data[1] << 8);
}

function expectDisc(data: { readonly [index: number]: number }, disc: InstructionType): void {
  expect(readU16LE(data)).toBe(disc);
}

function expectProgramId(ix: { programAddress: Address }, id: Address = TOKENIZER_PROGRAM_ID): void {
  expect(ix.programAddress).toBe(id);
}

function expectRole(
  accounts: readonly { address: Address; role: AccountRole }[],
  index: number,
  expectedRole: AccountRole,
): void {
  expect(accounts[index].role).toBe(expectedRole);
}

// ── Protocol Instructions ────────────────────────────────────────────

describe("Protocol Instructions", () => {
  const config = randAddr();
  const operator = randAddr();
  const payer = randAddr();

  it("initializeProtocol — disc=0, 4 accounts, payload has fee+addresses", () => {
    const ix = initializeProtocol({
      config,
      operator,
      payer,
      feeBps: 200,
      feeTreasury: randAddr(),
      acceptedMint: randAddr(),
    });
    expectProgramId(ix);
    expectDisc(ix.data!, InstructionType.Initialize);
    expect(ix.accounts).toHaveLength(4);
    expectRole(ix.accounts!, 0, AccountRole.WRITABLE);        // config
    expectRole(ix.accounts!, 1, AccountRole.READONLY_SIGNER);  // operator
    expectRole(ix.accounts!, 2, AccountRole.WRITABLE_SIGNER);  // payer
    expectRole(ix.accounts!, 3, AccountRole.READONLY);          // system
    // payload: disc(2) + feeBps(2) + 2 addresses(64) = 68 bytes
    expect(ix.data!.length).toBe(2 + 2 + 32 + 32);
  });

  it("updateConfigFeeBps — disc=1, sub-discriminant=0", () => {
    const ix = updateConfigFeeBps({ config, operator, feeBps: 300 });
    expectDisc(ix.data!, InstructionType.UpdateConfig);
    expect(ix.data![2]).toBe(0); // sub-discriminant
    expect(ix.accounts).toHaveLength(2);
  });

  it("updateConfigFeeTreasury — disc=1, sub-discriminant=1", () => {
    const ix = updateConfigFeeTreasury({ config, operator, feeTreasury: randAddr() });
    expectDisc(ix.data!, InstructionType.UpdateConfig);
    expect(ix.data![2]).toBe(1);
  });

  it("updateConfigAddMint — disc=1, sub-discriminant=3", () => {
    const ix = updateConfigAddMint({ config, operator, mint: randAddr() });
    expect(ix.data![2]).toBe(3);
  });

  it("updateConfigRemoveMint — disc=1, sub-discriminant=4", () => {
    const ix = updateConfigRemoveMint({ config, operator, mint: randAddr() });
    expect(ix.data![2]).toBe(4);
  });

  it("updateConfigSetOperator — disc=1, sub-discriminant=5", () => {
    const ix = updateConfigSetOperator({ config, operator, newOperator: randAddr() });
    expect(ix.data![2]).toBe(5);
  });

  it("pauseProtocol — disc=2, no payload beyond disc", () => {
    const ix = pauseProtocol({ config, operator });
    expectDisc(ix.data!, InstructionType.Pause);
    expect(ix.data!.length).toBe(2); // only discriminant
    expect(ix.accounts).toHaveLength(2);
  });

  it("unpauseProtocol — disc=3", () => {
    const ix = unpauseProtocol({ config, operator });
    expectDisc(ix.data!, InstructionType.Unpause);
    expect(ix.data!.length).toBe(2);
  });
});

// ── Organization Instructions ────────────────────────────────────────

describe("Organization Instructions", () => {
  it("registerOrganization — disc=10, 5 accounts, payload has name/reg/country", () => {
    const ix = registerOrganization({
      config: randAddr(),
      orgAccount: randAddr(),
      operator: randAddr(),
      payer: randAddr(),
      authority: randAddr(),
      name: "Test",
      registrationNumber: "REG1",
      country: "US",
    });
    expectDisc(ix.data!, InstructionType.Register);
    expect(ix.accounts).toHaveLength(5);
    expectRole(ix.accounts!, 0, AccountRole.WRITABLE);        // config
    expectRole(ix.accounts!, 1, AccountRole.WRITABLE);        // org
    expectRole(ix.accounts!, 2, AccountRole.READONLY_SIGNER);  // operator
    expectRole(ix.accounts!, 3, AccountRole.WRITABLE_SIGNER);  // payer
  });

  it("deregisterOrganization — disc=11, 3 accounts", () => {
    const ix = deregisterOrganization({
      config: randAddr(),
      orgAccount: randAddr(),
      operator: randAddr(),
      orgId: 0,
    });
    expectDisc(ix.data!, InstructionType.Deregister);
    expect(ix.accounts).toHaveLength(3);
  });

  it("updateOrgAddMint — disc=12, sub-discriminant=0", () => {
    const ix = updateOrgAddMint({
      config: randAddr(),
      orgAccount: randAddr(),
      authority: randAddr(),
      mint: randAddr(),
    });
    expectDisc(ix.data!, InstructionType.UpdateOrg);
    expect(ix.data![2]).toBe(0);
    expect(ix.accounts).toHaveLength(4);
  });

  it("updateOrgRemoveMint — disc=12, sub-discriminant=1", () => {
    const ix = updateOrgRemoveMint({
      config: randAddr(),
      orgAccount: randAddr(),
      authority: randAddr(),
      mint: randAddr(),
    });
    expect(ix.data![2]).toBe(1);
  });
});

// ── Asset Instructions ───────────────────────────────────────────────

describe("Asset Instructions", () => {
  it("initAsset — disc=20, 9 accounts", () => {
    const ix = initAsset({
      config: randAddr(),
      orgAccount: randAddr(),
      assetAccount: randAddr(),
      collection: randAddr(),
      collectionAuthority: randAddr(),
      authority: randAddr(),
      payer: randAddr(),
      totalShares: 1000000n,
      pricePerShare: 1000000n,
      acceptedMint: randAddr(),
      maturityDate: 0n,
      maturityGracePeriod: 0n,
      transferCooldown: 0n,
      maxHolders: 0,
      name: "Asset1",
      uri: "https://example.com",
    });
    expectDisc(ix.data!, InstructionType.InitAsset);
    expect(ix.accounts).toHaveLength(9);
  });

  it("mintToken — disc=21, 12 accounts", () => {
    const ix = mintToken({
      config: randAddr(),
      orgAccount: randAddr(),
      assetAccount: randAddr(),
      assetTokenAccount: randAddr(),
      collection: randAddr(),
      collectionAuthority: randAddr(),
      nft: randAddr(),
      recipient: randAddr(),
      authority: randAddr(),
      payer: randAddr(),
      shares: 100n,
    });
    expectDisc(ix.data!, InstructionType.MintToken);
    expect(ix.accounts).toHaveLength(12);
  });

  it("updateMetadata — disc=22, 9 accounts", () => {
    const ix = updateMetadata({
      config: randAddr(),
      orgAccount: randAddr(),
      assetAccount: randAddr(),
      collection: randAddr(),
      collectionAuthority: randAddr(),
      authority: randAddr(),
      payer: randAddr(),
      orgId: 0,
      assetId: 0,
      newName: "New",
      newUri: "https://new.com",
    });
    expectDisc(ix.data!, InstructionType.UpdateMetadata);
    expect(ix.accounts).toHaveLength(9);
  });
});

// ── Fundraising Instructions ─────────────────────────────────────────

describe("Fundraising Instructions", () => {
  it("createRound — disc=30, 10 accounts, payload with lockup+terms", () => {
    const ix = createRound({
      config: randAddr(),
      orgAccount: randAddr(),
      assetAccount: randAddr(),
      roundAccount: randAddr(),
      escrow: randAddr(),
      acceptedMint: randAddr(),
      authority: randAddr(),
      payer: randAddr(),
      sharesOffered: 1000n,
      pricePerShare: 1000000n,
      minRaise: 100000000n,
      maxRaise: 1000000000n,
      minPerWallet: 1000000n,
      maxPerWallet: 100000000n,
      startTime: 1700000000n,
      endTime: 1700100000n,
      lockupEnd: 0n,
      termsHash: new Uint8Array(32),
    });
    expectDisc(ix.data!, InstructionType.CreateRound);
    expect(ix.accounts).toHaveLength(10);
    // disc(2) + 8×8(64) + i64(8) + hash(32) = 106
    expect(ix.data!.length).toBe(2 + 64 + 8 + 32);
  });

  it("invest — disc=31, 9 accounts, payload with termsHash", () => {
    const ix = invest({
      config: randAddr(),
      roundAccount: randAddr(),
      investmentAccount: randAddr(),
      escrow: randAddr(),
      investorTokenAccount: randAddr(),
      investor: randAddr(),
      payer: randAddr(),
      shares: 50n,
      termsHash: new Uint8Array(32),
    });
    expectDisc(ix.data!, InstructionType.Invest);
    expect(ix.accounts).toHaveLength(9);
    // disc(2) + u64(8) + hash(32) = 42
    expect(ix.data!.length).toBe(2 + 8 + 32);
  });

  it("finalizeRound — disc=32, 12 accounts, no extra payload", () => {
    const ix = finalizeRound({
      config: randAddr(),
      assetAccount: randAddr(),
      roundAccount: randAddr(),
      escrow: randAddr(),
      feeTreasuryToken: randAddr(),
      orgTreasuryToken: randAddr(),
      treasuryWallet: randAddr(),
      payer: randAddr(),
      acceptedMint: randAddr(),
      ataProgram: randAddr(),
    });
    expectDisc(ix.data!, InstructionType.FinalizeRound);
    expect(ix.accounts).toHaveLength(12);
    expect(ix.data!.length).toBe(2);
  });

  it("mintRoundTokens — disc=33, 7 + 4*N accounts", () => {
    const ix = mintRoundTokens({
      roundAccount: randAddr(),
      assetAccount: randAddr(),
      collection: randAddr(),
      collectionAuthority: randAddr(),
      payer: randAddr(),
      investors: [
        {
          investmentAccount: randAddr(),
          assetTokenAccount: randAddr(),
          nft: randAddr(),
          investor: randAddr(),
        },
      ],
    });
    expectDisc(ix.data!, InstructionType.MintRoundTokens);
    expect(ix.accounts).toHaveLength(7 + 4); // base + 1 investor * 4
    expect(ix.data![2]).toBe(1); // count
  });

  it("refundInvestment — disc=34, 7 + 3*N accounts", () => {
    const ix = refundInvestment({
      roundAccount: randAddr(),
      escrow: randAddr(),
      payer: randAddr(),
      acceptedMint: randAddr(),
      ataProgram: randAddr(),
      investors: [
        { investmentAccount: randAddr(), investorTokenAccount: randAddr(), investor: randAddr() },
        { investmentAccount: randAddr(), investorTokenAccount: randAddr(), investor: randAddr() },
      ],
    });
    expectDisc(ix.data!, InstructionType.RefundInvestment);
    expect(ix.accounts).toHaveLength(7 + 6); // base + 2 * 3
    expect(ix.data![2]).toBe(2);
  });

  it("cancelRound — disc=35, 5 accounts, no payload", () => {
    const ix = cancelRound({
      config: randAddr(),
      orgAccount: randAddr(),
      assetAccount: randAddr(),
      roundAccount: randAddr(),
      authority: randAddr(),
    });
    expectDisc(ix.data!, InstructionType.CancelRound);
    expect(ix.accounts).toHaveLength(5);
    expect(ix.data!.length).toBe(2);
  });
});

// ── Market Instructions ──────────────────────────────────────────────

describe("Market Instructions", () => {
  it("listForSale — disc=40, 7 accounts", () => {
    const ix = listForSale({
      config: randAddr(),
      assetAccount: randAddr(),
      assetTokenAccount: randAddr(),
      listingAccount: randAddr(),
      seller: randAddr(),
      payer: randAddr(),
      sharesForSale: 50n,
      pricePerShare: 2000000n,
      isPartial: true,
      expiry: 1700200000n,
    });
    expectDisc(ix.data!, InstructionType.ListForSale);
    expect(ix.accounts).toHaveLength(7);
    // disc(2) + u64(8) + u64(8) + u8(1) + i64(8) = 27
    expect(ix.data!.length).toBe(2 + 8 + 8 + 1 + 8);
  });

  it("delist — disc=41, 4 accounts, no payload", () => {
    const ix = delist({
      assetTokenAccount: randAddr(),
      listingAccount: randAddr(),
      seller: randAddr(),
    });
    expectDisc(ix.data!, InstructionType.Delist);
    expect(ix.accounts).toHaveLength(4);
    expect(ix.data!.length).toBe(2);
  });

  it("buyListedToken — disc=42, 17 base accounts (no partial)", () => {
    const ix = buyListedToken({
      config: randAddr(),
      asset: randAddr(),
      assetToken: randAddr(),
      listing: randAddr(),
      nft: randAddr(),
      collection: randAddr(),
      collectionAuthority: randAddr(),
      buyer: randAddr(),
      seller: randAddr(),
      buyerTokenAcc: randAddr(),
      sellerTokenAcc: randAddr(),
      feeTreasuryToken: randAddr(),
      payer: randAddr(),
      ataProgram: randAddr(),
      acceptedMint: randAddr(),
    });
    expectDisc(ix.data!, InstructionType.BuyListedToken);
    expect(ix.accounts).toHaveLength(18);
  });

  it("buyListedToken with partial — 21 accounts", () => {
    const ix = buyListedToken({
      config: randAddr(),
      asset: randAddr(),
      assetToken: randAddr(),
      listing: randAddr(),
      nft: randAddr(),
      collection: randAddr(),
      collectionAuthority: randAddr(),
      buyer: randAddr(),
      seller: randAddr(),
      buyerTokenAcc: randAddr(),
      sellerTokenAcc: randAddr(),
      feeTreasuryToken: randAddr(),
      payer: randAddr(),
      acceptedMint: randAddr(),
      ataProgram: randAddr(),
      partial: {
        newNftBuyer: randAddr(),
        buyerAssetToken: randAddr(),
        newNftSeller: randAddr(),
        sellerAssetToken: randAddr(),
      },
    });
    expect(ix.accounts).toHaveLength(22);
  });

  it("makeOffer — disc=43, 11 accounts", () => {
    const ix = makeOffer({
      config: randAddr(),
      assetAccount: randAddr(),
      assetTokenAccount: randAddr(),
      offerAccount: randAddr(),
      escrow: randAddr(),
      acceptedMint: randAddr(),
      buyerTokenAcc: randAddr(),
      buyer: randAddr(),
      payer: randAddr(),
      sharesRequested: 25n,
      pricePerShare: 3000000n,
      expiry: 1700300000n,
    });
    expectDisc(ix.data!, InstructionType.MakeOffer);
    expect(ix.accounts).toHaveLength(11);
    // disc(2) + u64(8) + u64(8) + i64(8) = 26
    expect(ix.data!.length).toBe(2 + 8 + 8 + 8);
  });

  it("acceptOffer — disc=44, 17 base accounts", () => {
    const ix = acceptOffer({
      config: randAddr(),
      asset: randAddr(),
      assetToken: randAddr(),
      offer: randAddr(),
      escrow: randAddr(),
      nft: randAddr(),
      collection: randAddr(),
      collectionAuthority: randAddr(),
      seller: randAddr(),
      buyer: randAddr(),
      sellerTokenAcc: randAddr(),
      feeTreasuryToken: randAddr(),
      ataProgram: randAddr(),
      payer: randAddr(),
      acceptedMint: randAddr(),
    });
    expectDisc(ix.data!, InstructionType.AcceptOffer);
    expect(ix.accounts).toHaveLength(18);
  });

  it("rejectOffer — disc=45, 10 accounts", () => {
    const ix = rejectOffer({
      assetTokenAccount: randAddr(),
      offerAccount: randAddr(),
      escrow: randAddr(),
      buyerTokenAcc: randAddr(),
      seller: randAddr(),
      buyer: randAddr(),
      acceptedMint: randAddr(),
      ataProgram: randAddr(),
    });
    expectDisc(ix.data!, InstructionType.RejectOffer);
    expect(ix.accounts).toHaveLength(10);
  });

  it("cancelOffer — disc=46, 8 accounts", () => {
    const ix = cancelOffer({
      offerAccount: randAddr(),
      escrow: randAddr(),
      buyerTokenAcc: randAddr(),
      buyer: randAddr(),
      acceptedMint: randAddr(),
      ataProgram: randAddr(),
    });
    expectDisc(ix.data!, InstructionType.CancelOffer);
    expect(ix.accounts).toHaveLength(8);
  });

  it("consolidateTokens — disc=47, 10 + 2*N accounts", () => {
    const ix = consolidateTokens({
      config: randAddr(),
      asset: randAddr(),
      collection: randAddr(),
      collectionAuthority: randAddr(),
      newNft: randAddr(),
      newAssetToken: randAddr(),
      owner: randAddr(),
      payer: randAddr(),
      tokens: [
        { assetToken: randAddr(), nft: randAddr() },
        { assetToken: randAddr(), nft: randAddr() },
      ],
    });
    expectDisc(ix.data!, InstructionType.Consolidate);
    expect(ix.accounts).toHaveLength(10 + 4); // base + 2 tokens * 2
    expect(ix.data![2]).toBe(2); // count
  });
});

// ── Distribution Instructions ────────────────────────────────────────

describe("Distribution Instructions", () => {
  it("createDistribution — disc=50, 11 accounts", () => {
    const ix = createDistribution({
      config: randAddr(),
      orgAccount: randAddr(),
      assetAccount: randAddr(),
      distributionAccount: randAddr(),
      escrow: randAddr(),
      depositorTokenAcc: randAddr(),
      acceptedMint: randAddr(),
      authority: randAddr(),
      payer: randAddr(),
      totalAmount: 10000000000n,
    });
    expectDisc(ix.data!, InstructionType.CreateDistribution);
    expect(ix.accounts).toHaveLength(11);
    expect(ix.data!.length).toBe(2 + 8); // disc + u64
  });

  it("claimDistribution — disc=51, 8 + 3*N accounts", () => {
    const ix = claimDistribution({
      distributionAccount: randAddr(),
      escrow: randAddr(),
      assetAccount: randAddr(),
      payer: randAddr(),
      acceptedMint: randAddr(),
      ataProgram: randAddr(),
      claims: [
        { assetTokenAccount: randAddr(), holderTokenAcc: randAddr(), holder: randAddr() },
      ],
    });
    expectDisc(ix.data!, InstructionType.ClaimDistribution);
    expect(ix.accounts).toHaveLength(8 + 3);
    expect(ix.data![2]).toBe(1); // count
  });

  it("closeDistribution — disc=52, 7 accounts", () => {
    const ix = closeDistribution({
      distributionAccount: randAddr(),
      escrow: randAddr(),
      assetAccount: randAddr(),
      orgAccount: randAddr(),
      dustRecipient: randAddr(),
      payer: randAddr(),
    });
    expectDisc(ix.data!, InstructionType.CloseDistribution);
    expect(ix.accounts).toHaveLength(7);
    expect(ix.data!.length).toBe(2);
  });
});

// ── Emergency Instructions ───────────────────────────────────────────

describe("Emergency Instructions", () => {
  it("burnAndRemint — disc=60, 14 accounts, payload=addr+reason+shares", () => {
    const newOwner = randAddr();
    const ix = burnAndRemint({
      orgAccount: randAddr(),
      assetAccount: randAddr(),
      oldAssetTokenAccount: randAddr(),
      oldNft: randAddr(),
      collection: randAddr(),
      collectionAuthority: randAddr(),
      newNft: randAddr(),
      newAssetTokenAccount: randAddr(),
      newOwner,
      emergencyRecordAccount: randAddr(),
      orgAuthority: randAddr(),
      payer: randAddr(),
      reason: 0,
      sharesToTransfer: 0n,
    });
    expectDisc(ix.data!, InstructionType.BurnAndRemint);
    expect(ix.accounts).toHaveLength(14);
    // disc(2) + addr(32) + u8(1) + u64(8) = 43
    expect(ix.data!.length).toBe(2 + 32 + 1 + 8);
  });

  it("burnAndRemint partial — 17 accounts", () => {
    const ix = burnAndRemint({
      orgAccount: randAddr(),
      assetAccount: randAddr(),
      oldAssetTokenAccount: randAddr(),
      oldNft: randAddr(),
      collection: randAddr(),
      collectionAuthority: randAddr(),
      newNft: randAddr(),
      newAssetTokenAccount: randAddr(),
      newOwner: randAddr(),
      emergencyRecordAccount: randAddr(),
      orgAuthority: randAddr(),
      payer: randAddr(),
      reason: 1,
      sharesToTransfer: 500n,
      remainderNft: randAddr(),
      remainderAssetToken: randAddr(),
      oldOwner: randAddr(),
    });
    expect(ix.accounts).toHaveLength(17);
  });

  it("splitAndRemint — disc=61, 11 + 3*N accounts, payload=count+shares", () => {
    const ix = splitAndRemint({
      orgAccount: randAddr(),
      assetAccount: randAddr(),
      oldAssetTokenAccount: randAddr(),
      oldNft: randAddr(),
      collection: randAddr(),
      collectionAuthority: randAddr(),
      emergencyRecordAccount: randAddr(),
      orgAuthority: randAddr(),
      payer: randAddr(),
      recipients: [
        { newNft: randAddr(), newAssetTokenAccount: randAddr(), recipient: randAddr(), shares: 50n },
        { newNft: randAddr(), newAssetTokenAccount: randAddr(), recipient: randAddr(), shares: 50n },
      ],
    });
    expectDisc(ix.data!, InstructionType.SplitAndRemint);
    expect(ix.accounts).toHaveLength(11 + 6); // base + 2 recipients * 3
    // disc(2) + count(1) + 2 * u64(8) = 19
    expect(ix.data!.length).toBe(2 + 1 + 16);
    expect(ix.data![2]).toBe(2); // count
  });
});

// ── Governance Instructions ──────────────────────────────────────────

describe("Governance Instructions", () => {
  it("createRegistrar — disc=70, 7 accounts, payload=address(32)", () => {
    const govProgram = randAddr();
    const ix = createRegistrar({
      realm: randAddr(),
      governingTokenMint: randAddr(),
      assetAccount: randAddr(),
      registrarAccount: randAddr(),
      realmAuthority: randAddr(),
      payer: randAddr(),
      governanceProgramId: govProgram,
    });
    expectDisc(ix.data!, InstructionType.CreateRegistrar);
    expect(ix.accounts).toHaveLength(7);
    expect(ix.data!.length).toBe(2 + 32);
  });

  it("createVoterWeightRecord — disc=71, 5 accounts, no payload", () => {
    const ix = createVoterWeightRecord({
      registrarAccount: randAddr(),
      voterWeightRecordAccount: randAddr(),
      governingTokenOwner: randAddr(),
      payer: randAddr(),
    });
    expectDisc(ix.data!, InstructionType.CreateVoterWeightRecord);
    expect(ix.accounts).toHaveLength(5);
    expect(ix.data!.length).toBe(2);
  });

  it("createMaxVoterWeightRecord — disc=72, 6 accounts", () => {
    const ix = createMaxVoterWeightRecord({
      registrarAccount: randAddr(),
      assetAccount: randAddr(),
      maxVoterWeightRecordAccount: randAddr(),
      realm: randAddr(),
      payer: randAddr(),
    });
    expectDisc(ix.data!, InstructionType.CreateMaxVoterWeightRecord);
    expect(ix.accounts).toHaveLength(6);
    expect(ix.data!.length).toBe(2);
  });

  it("updateVoterWeightRecord — disc=73, 4 + N accounts, payload=action+target", () => {
    const at1 = randAddr();
    const at2 = randAddr();
    const ix = updateVoterWeightRecord({
      registrarAccount: randAddr(),
      voterWeightRecordAccount: randAddr(),
      voterTokenOwnerRecord: randAddr(),
      voterAuthority: randAddr(),
      assetTokenAccounts: [at1, at2],
      action: 1,
      actionTarget: randAddr(),
    });
    expectDisc(ix.data!, InstructionType.UpdateVoterWeightRecord);
    expect(ix.accounts).toHaveLength(4 + 2);
    // disc(2) + u8(1) + address(32) = 35
    expect(ix.data!.length).toBe(2 + 1 + 32);
  });

  it("relinquishVoterWeight — disc=74, 3 + N accounts", () => {
    const ix = relinquishVoterWeight({
      registrarAccount: randAddr(),
      governanceProgram: randAddr(),
      proposal: randAddr(),
      assetTokenAccounts: [randAddr()],
    });
    expectDisc(ix.data!, InstructionType.RelinquishVoterWeight);
    expect(ix.accounts).toHaveLength(3 + 1);
    expect(ix.data!.length).toBe(2);
  });

  it("createProtocolRealm — disc=75, 15 accounts", () => {
    const ix = createProtocolRealm({
      config: randAddr(),
      realm: randAddr(),
      realmAuthority: randAddr(),
      communityMint: randAddr(),
      communityHolding: randAddr(),
      councilMint: randAddr(),
      councilHolding: randAddr(),
      realmConfig: randAddr(),
      payer: randAddr(),
      governanceProgram: randAddr(),
      rentSysvar: randAddr(),
      governance: randAddr(),
      nativeTreasury: randAddr(),
      realmName: "MyRealm",
      governanceConfigData: new Uint8Array([1, 2, 3]),
    });
    expectDisc(ix.data!, InstructionType.CreateProtocolRealm);
    expect(ix.accounts).toHaveLength(15);
  });

  it("createOrgRealm — disc=76, 19 base accounts", () => {
    const ix = createOrgRealm({
      config: randAddr(),
      orgAccount: randAddr(),
      realm: randAddr(),
      realmAuthority: randAddr(),
      councilMint: randAddr(),
      councilHolding: randAddr(),
      communityMint: randAddr(),
      communityHolding: randAddr(),
      realmConfig: randAddr(),
      authority: randAddr(),
      payer: randAddr(),
      governanceProgram: randAddr(),
      rentSysvar: randAddr(),
      voterWeightAddin: randAddr(),
      maxVoterWeightAddin: randAddr(),
      governance: randAddr(),
      nativeTreasury: randAddr(),
      realmName: "OrgRealm",
      governanceConfigData: new Uint8Array([1, 2, 3]),
    });
    expectDisc(ix.data!, InstructionType.CreateOrgRealm);
    expect(ix.accounts).toHaveLength(19);
  });

  it("createAssetGovernance — disc=77, 13 base accounts", () => {
    const ix = createAssetGovernance({
      config: randAddr(),
      organization: randAddr(),
      asset: randAddr(),
      authority: randAddr(),
      realm: randAddr(),
      governance: randAddr(),
      tokenOwnerRecord: randAddr(),
      governanceAuthority: randAddr(),
      realmConfig: randAddr(),
      payer: randAddr(),
      governanceProgram: randAddr(),
      nativeTreasury: randAddr(),
      governanceConfigData: new Uint8Array([1, 2, 3]),
    });
    expectDisc(ix.data!, InstructionType.CreateAssetGovernance);
    expect(ix.accounts).toHaveLength(13);
  });

  it("createAssetGovernance with voterWeightRecord — 14 accounts", () => {
    const ix = createAssetGovernance({
      config: randAddr(),
      organization: randAddr(),
      asset: randAddr(),
      authority: randAddr(),
      realm: randAddr(),
      governance: randAddr(),
      tokenOwnerRecord: randAddr(),
      governanceAuthority: randAddr(),
      realmConfig: randAddr(),
      payer: randAddr(),
      governanceProgram: randAddr(),
      nativeTreasury: randAddr(),
      voterWeightRecord: randAddr(),
      governanceConfigData: new Uint8Array([1, 2, 3]),
    });
    expect(ix.accounts).toHaveLength(14);
  });
});

// ── Buyout Instructions ─────────────────────────────────────────────

describe("Buyout Instructions", () => {
  it("createBuyoutOffer — disc=85, 8 accounts, payload=84 bytes", () => {
    const ix = createBuyoutOffer({
      config: randAddr(),
      org: randAddr(),
      asset: randAddr(),
      buyoutOffer: randAddr(),
      acceptedMint: randAddr(),
      buyer: randAddr(),
      payer: randAddr(),
      pricePerShare: 5000000n,
      isCouncilBuyout: false,
      treasuryDisposition: 0,
      broker: randAddr(),
      brokerBps: 200,
      termsHash: new Uint8Array(32),
      expiry: 1700200000n,
    });
    expectProgramId(ix);
    expectDisc(ix.data!, InstructionType.CreateBuyoutOffer);
    expect(ix.accounts).toHaveLength(8);
    expectRole(ix.accounts!, 0, AccountRole.READONLY);         // config
    expectRole(ix.accounts!, 1, AccountRole.READONLY);         // org
    expectRole(ix.accounts!, 2, AccountRole.WRITABLE);         // asset
    expectRole(ix.accounts!, 3, AccountRole.WRITABLE);         // buyoutOffer
    expectRole(ix.accounts!, 4, AccountRole.READONLY);         // acceptedMint
    expectRole(ix.accounts!, 5, AccountRole.READONLY_SIGNER);  // buyer
    expectRole(ix.accounts!, 6, AccountRole.WRITABLE_SIGNER);  // payer
    expectRole(ix.accounts!, 7, AccountRole.READONLY);         // system
    // disc(2) + u64(8) + u8(1) + u8(1) + addr(32) + u16(2) + hash(32) + i64(8) = 86
    expect(ix.data!.length).toBe(2 + 8 + 1 + 1 + 32 + 2 + 32 + 8);
  });

  it("fundBuyoutOffer — disc=86, 9 accounts, no extra payload", () => {
    const ix = fundBuyoutOffer({
      buyoutOffer: randAddr(),
      asset: randAddr(),
      escrow: randAddr(),
      buyerTokenAcc: randAddr(),
      acceptedMint: randAddr(),
      buyer: randAddr(),
      payer: randAddr(),
    });
    expectProgramId(ix);
    expectDisc(ix.data!, InstructionType.FundBuyoutOffer);
    expect(ix.accounts).toHaveLength(9);
    expectRole(ix.accounts!, 0, AccountRole.WRITABLE);         // buyoutOffer
    expectRole(ix.accounts!, 1, AccountRole.READONLY);         // asset
    expectRole(ix.accounts!, 2, AccountRole.WRITABLE);         // escrow
    expectRole(ix.accounts!, 3, AccountRole.WRITABLE);         // buyerTokenAcc
    expectRole(ix.accounts!, 5, AccountRole.READONLY_SIGNER);  // buyer
    expectRole(ix.accounts!, 6, AccountRole.WRITABLE_SIGNER);  // payer
    expect(ix.data!.length).toBe(2);
  });

  it("approveBuyout — disc=87, 4 accounts, no extra payload", () => {
    const ix = approveBuyout({
      buyoutOffer: randAddr(),
      asset: randAddr(),
      org: randAddr(),
      authority: randAddr(),
    });
    expectProgramId(ix);
    expectDisc(ix.data!, InstructionType.ApproveBuyout);
    expect(ix.accounts).toHaveLength(4);
    expectRole(ix.accounts!, 0, AccountRole.WRITABLE);         // buyoutOffer
    expectRole(ix.accounts!, 1, AccountRole.READONLY);         // asset
    expectRole(ix.accounts!, 2, AccountRole.READONLY);         // org
    expectRole(ix.accounts!, 3, AccountRole.READONLY_SIGNER);  // authority
    expect(ix.data!.length).toBe(2);
  });

  it("settleBuyout — disc=88, 3 accounts, payload=count(u8)", () => {
    const ix = settleBuyout({
      buyoutOffer: randAddr(),
      asset: randAddr(),
      payer: randAddr(),
      count: 5,
    });
    expectProgramId(ix);
    expectDisc(ix.data!, InstructionType.SettleBuyout);
    expect(ix.accounts).toHaveLength(3);
    expect(ix.data!.length).toBe(2 + 1); // disc + count
    expect(ix.data![2]).toBe(5);
  });

  it("completeBuyout — disc=89, 3 accounts, no extra payload", () => {
    const ix = completeBuyout({
      buyoutOffer: randAddr(),
      asset: randAddr(),
      buyer: randAddr(),
    });
    expectProgramId(ix);
    expectDisc(ix.data!, InstructionType.CompleteBuyout);
    expect(ix.accounts).toHaveLength(3);
    expectRole(ix.accounts!, 0, AccountRole.WRITABLE);  // buyoutOffer
    expectRole(ix.accounts!, 1, AccountRole.WRITABLE);  // asset
    expectRole(ix.accounts!, 2, AccountRole.READONLY);   // buyer
    expect(ix.data!.length).toBe(2);
  });

  it("cancelBuyout — disc=90, 4 base accounts (no escrow)", () => {
    const ix = cancelBuyout({
      buyoutOffer: randAddr(),
      asset: randAddr(),
      buyer: randAddr(),
    });
    expectProgramId(ix);
    expectDisc(ix.data!, InstructionType.CancelBuyout);
    expect(ix.accounts).toHaveLength(4);
    expectRole(ix.accounts!, 0, AccountRole.WRITABLE);         // buyoutOffer
    expectRole(ix.accounts!, 1, AccountRole.WRITABLE);         // asset
    expectRole(ix.accounts!, 2, AccountRole.WRITABLE_SIGNER);  // buyer
    expect(ix.data!.length).toBe(2);
  });

  it("cancelBuyout with escrow — 7 accounts", () => {
    const ix = cancelBuyout({
      buyoutOffer: randAddr(),
      asset: randAddr(),
      buyer: randAddr(),
      escrow: randAddr(),
      buyerTokenAcc: randAddr(),
      tokenProgram: randAddr(),
    });
    expect(ix.accounts).toHaveLength(7);
  });
});
