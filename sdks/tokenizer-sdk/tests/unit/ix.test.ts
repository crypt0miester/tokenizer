import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import { address, type Address } from "gill";
import { createIxNamespace } from "../../src/ix.js";
import {
  getProtocolConfigPda,
  getOrganizationPda,
  getCollectionAuthorityPda,
  getListingPda,
  getOfferPda,
  getOfferEscrowPda,
  getEscrowPda,
  getInvestmentPda,
  getFundraisingRoundPda,
  getDistributionPda,
  getDistributionEscrowPda,
  getEmergencyRecordPda,
  getBuyoutOfferPda,
  getBuyoutEscrowPda,
  getRegistrarPda,
  getVoterWeightRecordPda,
  getMaxVoterWeightRecordPda,
  getVoteRecordPda,
} from "../../src/pdas.js";

// Raw builders for comparison
import * as proto from "../../src/instructions/protocol.js";
import * as org from "../../src/instructions/organization.js";
import * as assetIx from "../../src/instructions/asset.js";
import * as fund from "../../src/instructions/fundraising.js";
import * as mkt from "../../src/instructions/market.js";
import * as dist from "../../src/instructions/distribution.js";
import * as gov from "../../src/instructions/governance.js";
import * as bo from "../../src/instructions/buyout.js";
import * as emg from "../../src/instructions/emergency.js";

function randAddr(): Address {
  return address(Keypair.generate().publicKey.toBase58());
}

const programId = randAddr();
const ix = createIxNamespace(programId);

/** Deep-compare two instructions (accounts + data + programAddress). */
function expectSameIx(
  a: { programAddress: Address; accounts?: readonly any[]; data?: ArrayLike<number> },
  b: { programAddress: Address; accounts?: readonly any[]; data?: ArrayLike<number> },
) {
  expect(a.programAddress).toBe(b.programAddress);
  expect(a.accounts).toEqual(b.accounts);
  expect(a.data).toEqual(b.data);
}

//  Protocol 

describe("ix.protocol", () => {
  it("initializeProtocol", async () => {
    const [config] = await getProtocolConfigPda(programId);
    const p = { operator: randAddr(), payer: randAddr(), feeBps: 200, feeTreasury: randAddr(), acceptedMint: randAddr() };
    const got = await ix.initializeProtocol(p);
    const want = proto.initializeProtocol({ ...p, config, programId });
    expectSameIx(got, want);
  });

  it("pauseProtocol", async () => {
    const [config] = await getProtocolConfigPda(programId);
    const p = { operator: randAddr() };
    const got = await ix.pauseProtocol(p);
    const want = proto.pauseProtocol({ ...p, config, programId });
    expectSameIx(got, want);
  });

  it("unpauseProtocol", async () => {
    const [config] = await getProtocolConfigPda(programId);
    const p = { operator: randAddr() };
    const got = await ix.unpauseProtocol(p);
    const want = proto.unpauseProtocol({ ...p, config, programId });
    expectSameIx(got, want);
  });

  it("updateConfigFeeBps", async () => {
    const [config] = await getProtocolConfigPda(programId);
    const p = { operator: randAddr(), feeBps: 300 };
    expectSameIx(await ix.updateConfigFeeBps(p), proto.updateConfigFeeBps({ ...p, config, programId }));
  });

  it("updateConfigAddMint", async () => {
    const [config] = await getProtocolConfigPda(programId);
    const p = { operator: randAddr(), mint: randAddr() };
    expectSameIx(await ix.updateConfigAddMint(p), proto.updateConfigAddMint({ ...p, config, programId }));
  });

  it("updateConfigSetOperator", async () => {
    const [config] = await getProtocolConfigPda(programId);
    const p = { operator: randAddr(), newOperator: randAddr() };
    expectSameIx(await ix.updateConfigSetOperator(p), proto.updateConfigSetOperator({ ...p, config, programId }));
  });

  it("updateConfigFeeTreasury", async () => {
    const [config] = await getProtocolConfigPda(programId);
    const p = { operator: randAddr(), feeTreasury: randAddr() };
    expectSameIx(await ix.updateConfigFeeTreasury(p), proto.updateConfigFeeTreasury({ ...p, config, programId }));
  });

  it("updateConfigRemoveMint", async () => {
    const [config] = await getProtocolConfigPda(programId);
    const p = { operator: randAddr(), mint: randAddr() };
    expectSameIx(await ix.updateConfigRemoveMint(p), proto.updateConfigRemoveMint({ ...p, config, programId }));
  });

  it("updateConfigMinProposalWeightBps", async () => {
    const [config] = await getProtocolConfigPda(programId);
    const p = { operator: randAddr(), minProposalWeightBps: 500 };
    expectSameIx(await ix.updateConfigMinProposalWeightBps(p), proto.updateConfigMinProposalWeightBps({ ...p, config, programId }));
  });
});

//  Organization 

describe("ix.organization", () => {
  it("registerOrganization derives config + orgAccount from orgId", async () => {
    const orgId = 42;
    const [config] = await getProtocolConfigPda(programId);
    const [orgAccount] = await getOrganizationPda(orgId, programId);
    const p = { orgId, operator: randAddr(), payer: randAddr(), authority: randAddr(), name: "Org", registrationNumber: "R1", country: "US" };
    const got = await ix.registerOrganization(p);
    const want = org.registerOrganization({ ...p, config, orgAccount, programId });
    expectSameIx(got, want);
  });

  it("deregisterOrganization derives config + orgAccount from orgId", async () => {
    const orgId = 7;
    const [config] = await getProtocolConfigPda(programId);
    const [orgAccount] = await getOrganizationPda(orgId, programId);
    const p = { orgId, operator: randAddr() };
    const got = await ix.deregisterOrganization(p);
    const want = org.deregisterOrganization({ ...p, config, orgAccount, programId });
    expectSameIx(got, want);
  });

  it("updateOrgAddMint derives config", async () => {
    const [config] = await getProtocolConfigPda(programId);
    const p = { orgAccount: randAddr(), authority: randAddr(), mint: randAddr() };
    expectSameIx(await ix.updateOrgAddMint(p), org.updateOrgAddMint({ ...p, config, programId }));
  });

  it("updateOrgRemoveMint derives config", async () => {
    const [config] = await getProtocolConfigPda(programId);
    const p = { orgAccount: randAddr(), authority: randAddr(), mint: randAddr() };
    expectSameIx(await ix.updateOrgRemoveMint(p), org.updateOrgRemoveMint({ ...p, config, programId }));
  });
});

//  Asset

describe("ix.asset", () => {
  it("initAsset derives config + collectionAuthority", async () => {
    const collection = randAddr();
    const [config] = await getProtocolConfigPda(programId);
    const [collectionAuthority] = await getCollectionAuthorityPda(collection, programId);
    const p = {
      orgAccount: randAddr(), assetAccount: randAddr(), collection,
      authority: randAddr(), payer: randAddr(), totalShares: 1000n,
      pricePerShare: 100n, acceptedMint: randAddr(), maturityDate: 0n,
      maturityGracePeriod: 0n, transferCooldown: 0n, maxHolders: 0,
      name: "A", uri: "https://a.com",
    };
    const got = await ix.initAsset(p);
    const want = assetIx.initAsset({ ...p, config, collectionAuthority, programId });
    expectSameIx(got, want);
  });

  it("mintToken derives config + collectionAuthority", async () => {
    const collection = randAddr();
    const [config] = await getProtocolConfigPda(programId);
    const [collectionAuthority] = await getCollectionAuthorityPda(collection, programId);
    const p = {
      orgAccount: randAddr(), assetAccount: randAddr(), assetTokenAccount: randAddr(),
      collection, nft: randAddr(), recipient: randAddr(),
      authority: randAddr(), payer: randAddr(), shares: 100n,
    };
    expectSameIx(await ix.mintToken(p), assetIx.mintToken({ ...p, config, collectionAuthority, programId }));
  });

  it("updateMetadata derives config + collectionAuthority", async () => {
    const collection = randAddr();
    const [config] = await getProtocolConfigPda(programId);
    const [collectionAuthority] = await getCollectionAuthorityPda(collection, programId);
    const p = {
      orgAccount: randAddr(), assetAccount: randAddr(), collection,
      authority: randAddr(), payer: randAddr(),
      orgId: 1, assetId: 2, newName: "Updated", newUri: "https://new.com",
    };
    expectSameIx(
      await ix.updateMetadata(p),
      assetIx.updateMetadata({ ...p, config, collectionAuthority, programId }),
    );
  });
});

//  Fundraising

describe("ix.fundraising", () => {
  it("createRound derives config + roundAccount + escrow", async () => {
    const assetAccount = randAddr();
    const roundIndex = 3;
    const [config] = await getProtocolConfigPda(programId);
    const [roundAccount] = await getFundraisingRoundPda(assetAccount, roundIndex, programId);
    const [escrow] = await getEscrowPda(roundAccount, programId);
    const p = {
      orgAccount: randAddr(), assetAccount, roundIndex,
      acceptedMint: randAddr(), authority: randAddr(), payer: randAddr(),
      sharesOffered: 1000n, pricePerShare: 100n, minRaise: 50000n, maxRaise: 100000n,
      minPerWallet: 100n, maxPerWallet: 10000n,
      startTime: 1700000000n, endTime: 1700100000n, lockupEnd: 0n,
      termsHash: new Uint8Array(32),
    };
    const got = await ix.createRound(p);
    const want = fund.createRound({ ...p, config, roundAccount, escrow, programId });
    expectSameIx(got, want);
  });

  it("invest derives config + investmentAccount + escrow", async () => {
    const roundAccount = randAddr();
    const investor = randAddr();
    const [config] = await getProtocolConfigPda(programId);
    const [investmentAccount] = await getInvestmentPda(roundAccount, investor, programId);
    const [escrow] = await getEscrowPda(roundAccount, programId);
    const p = { roundAccount, investorTokenAccount: randAddr(), investor, payer: randAddr(), shares: 50n, termsHash: new Uint8Array(32) };
    expectSameIx(
      await ix.invest(p),
      fund.invest({ ...p, config, investmentAccount, escrow, programId }),
    );
  });

  it("finalizeRound derives config + escrow", async () => {
    const roundAccount = randAddr();
    const [config] = await getProtocolConfigPda(programId);
    const [escrow] = await getEscrowPda(roundAccount, programId);
    const p = { assetAccount: randAddr(), roundAccount, feeTreasuryToken: randAddr(), orgTreasuryToken: randAddr(), treasuryWallet: randAddr(), payer: randAddr(), acceptedMint: randAddr(), ataProgram: randAddr() };
    expectSameIx(
      await ix.finalizeRound(p),
      fund.finalizeRound({ ...p, config, escrow, programId }),
    );
  });

  it("mintRoundTokens derives collectionAuthority", async () => {
    const collection = randAddr();
    const [collectionAuthority] = await getCollectionAuthorityPda(collection, programId);
    const p = {
      roundAccount: randAddr(), assetAccount: randAddr(), collection, payer: randAddr(),
      investors: [{ investmentAccount: randAddr(), assetTokenAccount: randAddr(), nft: randAddr(), investor: randAddr() }],
    };
    expectSameIx(
      await ix.mintRoundTokens(p),
      fund.mintRoundTokens({ ...p, collectionAuthority, programId }),
    );
  });

  it("refundInvestment derives escrow", async () => {
    const roundAccount = randAddr();
    const [escrow] = await getEscrowPda(roundAccount, programId);
    const p = { roundAccount, payer: randAddr(), acceptedMint: randAddr(), ataProgram: randAddr(), investors: [{ investmentAccount: randAddr(), investorTokenAccount: randAddr(), investor: randAddr() }] };
    expectSameIx(
      await ix.refundInvestment(p),
      fund.refundInvestment({ ...p, escrow, programId }),
    );
  });

  it("cancelRound derives config", async () => {
    const [config] = await getProtocolConfigPda(programId);
    const p = { orgAccount: randAddr(), assetAccount: randAddr(), roundAccount: randAddr(), authority: randAddr() };
    expectSameIx(await ix.cancelRound(p), fund.cancelRound({ ...p, config, programId }));
  });
});

//  Market 

describe("ix.market", () => {
  it("listForSale derives config + listingAccount", async () => {
    const assetTokenAccount = randAddr();
    const [config] = await getProtocolConfigPda(programId);
    const [listingAccount] = await getListingPda(assetTokenAccount, programId);
    const p = { assetAccount: randAddr(), assetTokenAccount, seller: randAddr(), payer: randAddr(), sharesForSale: 50n, pricePerShare: 200n, isPartial: true, expiry: 1700000000n };
    expectSameIx(
      await ix.listForSale(p),
      mkt.listForSale({ ...p, config, listingAccount, programId }),
    );
  });

  it("delist derives listingAccount", async () => {
    const assetTokenAccount = randAddr();
    const [listingAccount] = await getListingPda(assetTokenAccount, programId);
    const p = { assetTokenAccount, seller: randAddr(), rentDestination: randAddr() };
    expectSameIx(await ix.delist(p), mkt.delist({ ...p, listingAccount, programId }));
  });

  it("buyListedToken derives config + listing + collectionAuthority", async () => {
    const assetToken = randAddr();
    const collection = randAddr();
    const [config] = await getProtocolConfigPda(programId);
    const [listing] = await getListingPda(assetToken, programId);
    const [collectionAuthority] = await getCollectionAuthorityPda(collection, programId);
    const p = { asset: randAddr(), assetToken, nft: randAddr(), collection, buyer: randAddr(), seller: randAddr(), buyerTokenAcc: randAddr(), sellerTokenAcc: randAddr(), feeTreasuryToken: randAddr(), payer: randAddr(), acceptedMint: randAddr(), ataProgram: randAddr(), rentDestination: randAddr() };
    expectSameIx(
      await ix.buyListedToken(p),
      mkt.buyListedToken({ ...p, config, listing, collectionAuthority, programId }),
    );
  });

  it("makeOffer derives config + offerAccount + escrow", async () => {
    const assetTokenAccount = randAddr();
    const buyer = randAddr();
    const [config] = await getProtocolConfigPda(programId);
    const [offerAccount] = await getOfferPda(assetTokenAccount, buyer, programId);
    const [escrow] = await getOfferEscrowPda(offerAccount, programId);
    const p = { assetAccount: randAddr(), assetTokenAccount, acceptedMint: randAddr(), buyerTokenAcc: randAddr(), buyer, payer: randAddr(), sharesRequested: 25n, pricePerShare: 300n, expiry: 1700000000n };
    expectSameIx(
      await ix.makeOffer(p),
      mkt.makeOffer({ ...p, config, offerAccount, escrow, programId }),
    );
  });

  it("acceptOffer derives config + escrow + collectionAuthority", async () => {
    const offer = randAddr();
    const collection = randAddr();
    const [config] = await getProtocolConfigPda(programId);
    const [escrow] = await getOfferEscrowPda(offer, programId);
    const [collectionAuthority] = await getCollectionAuthorityPda(collection, programId);
    const p = { asset: randAddr(), assetToken: randAddr(), offer, nft: randAddr(), collection, seller: randAddr(), buyer: randAddr(), sellerTokenAcc: randAddr(), feeTreasuryToken: randAddr(), payer: randAddr(), acceptedMint: randAddr(), ataProgram: randAddr(), rentDestination: randAddr() };
    expectSameIx(
      await ix.acceptOffer(p),
      mkt.acceptOffer({ ...p, config, escrow, collectionAuthority, programId }),
    );
  });

  it("rejectOffer derives escrow", async () => {
    const offerAccount = randAddr();
    const [escrow] = await getOfferEscrowPda(offerAccount, programId);
    const p = { assetTokenAccount: randAddr(), offerAccount, buyerTokenAcc: randAddr(), seller: randAddr(), buyer: randAddr(), acceptedMint: randAddr(), ataProgram: randAddr(), rentDestination: randAddr() };
    expectSameIx(await ix.rejectOffer(p), mkt.rejectOffer({ ...p, escrow, programId }));
  });

  it("cancelOffer derives escrow", async () => {
    const offerAccount = randAddr();
    const [escrow] = await getOfferEscrowPda(offerAccount, programId);
    const p = { offerAccount, buyerTokenAcc: randAddr(), buyer: randAddr(), acceptedMint: randAddr(), ataProgram: randAddr(), rentDestination: randAddr() };
    expectSameIx(await ix.cancelOffer(p), mkt.cancelOffer({ ...p, escrow, programId }));
  });

  it("transferToken derives config + collectionAuthority", async () => {
    const collection = randAddr();
    const [config] = await getProtocolConfigPda(programId);
    const [collectionAuthority] = await getCollectionAuthorityPda(collection, programId);
    const p = { asset: randAddr(), assetToken: randAddr(), nft: randAddr(), collection, owner: randAddr(), newOwner: randAddr(), payer: randAddr() };
    expectSameIx(
      await ix.transferToken(p),
      mkt.transferToken({ ...p, config, collectionAuthority, programId }),
    );
  });

  it("consolidateTokens derives config + collectionAuthority", async () => {
    const collection = randAddr();
    const [config] = await getProtocolConfigPda(programId);
    const [collectionAuthority] = await getCollectionAuthorityPda(collection, programId);
    const p = { asset: randAddr(), collection, newNft: randAddr(), newAssetToken: randAddr(), owner: randAddr(), payer: randAddr(), tokens: [{ assetToken: randAddr(), nft: randAddr() }] };
    expectSameIx(
      await ix.consolidateTokens(p),
      mkt.consolidateTokens({ ...p, config, collectionAuthority, programId }),
    );
  });
});

//  Distribution 

describe("ix.distribution", () => {
  it("createDistribution derives config + distributionAccount + escrow", async () => {
    const assetAccount = randAddr();
    const epoch = 5;
    const [config] = await getProtocolConfigPda(programId);
    const [distributionAccount] = await getDistributionPda(assetAccount, epoch, programId);
    const [escrow] = await getDistributionEscrowPda(distributionAccount, programId);
    const p = { orgAccount: randAddr(), assetAccount, epoch, depositorTokenAcc: randAddr(), acceptedMint: randAddr(), authority: randAddr(), payer: randAddr(), totalAmount: 10000000000n };
    expectSameIx(
      await ix.createDistribution(p),
      dist.createDistribution({ ...p, config, distributionAccount, escrow, programId }),
    );
  });

  it("claimDistribution derives escrow", async () => {
    const distributionAccount = randAddr();
    const [escrow] = await getDistributionEscrowPda(distributionAccount, programId);
    const p = { distributionAccount, assetAccount: randAddr(), payer: randAddr(), acceptedMint: randAddr(), ataProgram: randAddr(), claims: [{ assetTokenAccount: randAddr(), holderTokenAcc: randAddr(), holder: randAddr() }] };
    expectSameIx(
      await ix.claimDistribution(p),
      dist.claimDistribution({ ...p, escrow, programId }),
    );
  });

  it("closeDistribution derives escrow", async () => {
    const distributionAccount = randAddr();
    const [escrow] = await getDistributionEscrowPda(distributionAccount, programId);
    const p = { distributionAccount, assetAccount: randAddr(), orgAccount: randAddr(), dustRecipient: randAddr(), payer: randAddr(), rentDestination: randAddr() };
    expectSameIx(
      await ix.closeDistribution(p),
      dist.closeDistribution({ ...p, escrow, programId }),
    );
  });
});

//  Governance 

describe("ix.governance", () => {
  it("createRegistrar derives registrarAccount", async () => {
    const realm = randAddr();
    const governingTokenMint = randAddr();
    const [registrarAccount] = await getRegistrarPda(realm, governingTokenMint, programId);
    const p = { realm, governingTokenMint, assetAccount: randAddr(), realmAuthority: randAddr(), payer: randAddr(), governanceProgramId: randAddr() };
    expectSameIx(
      await ix.createRegistrar(p),
      gov.createRegistrar({ ...p, registrarAccount, programId }),
    );
  });

  it("createVoterWeightRecord derives registrar + vwr", async () => {
    const realm = randAddr();
    const governingTokenMint = randAddr();
    const governingTokenOwner = randAddr();
    const [registrarAccount] = await getRegistrarPda(realm, governingTokenMint, programId);
    const [voterWeightRecordAccount] = await getVoterWeightRecordPda(realm, governingTokenMint, governingTokenOwner, programId);
    const p = { realm, governingTokenMint, governingTokenOwner, payer: randAddr() };
    expectSameIx(
      await ix.createVoterWeightRecord(p),
      gov.createVoterWeightRecord({ ...p, registrarAccount, voterWeightRecordAccount, programId }),
    );
  });

  it("createMaxVoterWeightRecord derives registrar + maxVwr", async () => {
    const realm = randAddr();
    const governingTokenMint = randAddr();
    const [registrarAccount] = await getRegistrarPda(realm, governingTokenMint, programId);
    const [maxVoterWeightRecordAccount] = await getMaxVoterWeightRecordPda(realm, governingTokenMint, programId);
    const p = { realm, governingTokenMint, assetAccount: randAddr(), payer: randAddr() };
    expectSameIx(
      await ix.createMaxVoterWeightRecord(p),
      gov.createMaxVoterWeightRecord({ ...p, registrarAccount, maxVoterWeightRecordAccount, programId }),
    );
  });

  it("updateVoterWeightRecord (non-CastVote) derives registrar + vwr", async () => {
    const realm = randAddr();
    const governingTokenMint = randAddr();
    const voterAuthority = randAddr();
    const [registrarAccount] = await getRegistrarPda(realm, governingTokenMint, programId);
    const [voterWeightRecordAccount] = await getVoterWeightRecordPda(realm, governingTokenMint, voterAuthority, programId);
    const at1 = randAddr();
    const p = { realm, governingTokenMint, voterTokenOwnerRecord: randAddr(), voterAuthority, assetTokenAccounts: [at1], action: 1, actionTarget: randAddr() };
    expectSameIx(
      await ix.updateVoterWeightRecord(p),
      gov.updateVoterWeightRecord({ ...p, registrarAccount, voterWeightRecordAccount, programId }),
    );
  });

  it("updateVoterWeightRecord (CastVote) derives registrar + vwr + voteRecords", async () => {
    const realm = randAddr();
    const governingTokenMint = randAddr();
    const voterAuthority = randAddr();
    const [registrarAccount] = await getRegistrarPda(realm, governingTokenMint, programId);
    const [voterWeightRecordAccount] = await getVoterWeightRecordPda(realm, governingTokenMint, voterAuthority, programId);
    const at1 = randAddr();
    const [vr1] = await getVoteRecordPda(at1, programId);
    const proposal = randAddr();
    const payer = randAddr();
    const p = { realm, governingTokenMint, voterTokenOwnerRecord: randAddr(), voterAuthority, proposal, payer, assetTokenAccounts: [at1], action: 0, actionTarget: proposal };
    expectSameIx(
      await ix.updateVoterWeightRecord(p),
      gov.updateVoterWeightRecord({ ...p, registrarAccount, voterWeightRecordAccount, voteRecordAccounts: [vr1], programId }),
    );
  });

  it("relinquishVoterWeight derives registrar + voteRecords", async () => {
    const realm = randAddr();
    const governingTokenMint = randAddr();
    const [registrarAccount] = await getRegistrarPda(realm, governingTokenMint, programId);
    const at1 = randAddr();
    const at2 = randAddr();
    const [vr1] = await getVoteRecordPda(at1, programId);
    const [vr2] = await getVoteRecordPda(at2, programId);
    const p = { realm, governingTokenMint, governanceProgram: randAddr(), proposal: randAddr(), rentDestination: randAddr(), assetTokenAccounts: [at1, at2] };
    expectSameIx(
      await ix.relinquishVoterWeight(p),
      gov.relinquishVoterWeight({ ...p, registrarAccount, voteRecordAccounts: [vr1, vr2], programId }),
    );
  });

  it("createProtocolRealm derives config", async () => {
    const [config] = await getProtocolConfigPda(programId);
    const p = {
      realm: randAddr(), realmAuthority: randAddr(), communityMint: randAddr(),
      communityHolding: randAddr(), councilMint: randAddr(), councilHolding: randAddr(),
      realmConfig: randAddr(), payer: randAddr(), governanceProgram: randAddr(),
      rentSysvar: randAddr(), governance: randAddr(), nativeTreasury: randAddr(),
      realmName: "R", governanceConfigData: new Uint8Array([1, 2, 3]),
    };
    expectSameIx(
      await ix.createProtocolRealm(p),
      gov.createProtocolRealm({ ...p, config, programId }),
    );
  });

  it("createOrgRealm derives config", async () => {
    const [config] = await getProtocolConfigPda(programId);
    const p = {
      orgAccount: randAddr(), realm: randAddr(), realmAuthority: randAddr(),
      councilMint: randAddr(), councilHolding: randAddr(), communityMint: randAddr(),
      communityHolding: randAddr(), realmConfig: randAddr(), authority: randAddr(),
      payer: randAddr(), governanceProgram: randAddr(), rentSysvar: randAddr(),
      voterWeightAddin: randAddr(), maxVoterWeightAddin: randAddr(),
      governance: randAddr(), nativeTreasury: randAddr(),
      realmName: "OrgRealm", governanceConfigData: new Uint8Array([4, 5, 6]),
    };
    expectSameIx(
      await ix.createOrgRealm(p),
      gov.createOrgRealm({ ...p, config, programId }),
    );
  });

  it("createAssetGovernance derives config", async () => {
    const [config] = await getProtocolConfigPda(programId);
    const p = {
      organization: randAddr(), asset: randAddr(), authority: randAddr(),
      realm: randAddr(), governance: randAddr(), tokenOwnerRecord: randAddr(),
      governanceAuthority: randAddr(), realmConfig: randAddr(), payer: randAddr(),
      governanceProgram: randAddr(), nativeTreasury: randAddr(),
      governanceConfigData: new Uint8Array([1, 2, 3]),
    };
    expectSameIx(
      await ix.createAssetGovernance(p),
      gov.createAssetGovernance({ ...p, config, programId }),
    );
  });
});

//  Buyout 

describe("ix.buyout", () => {
  it("createBuyoutOffer derives config + buyoutOffer", async () => {
    const asset = randAddr();
    const buyer = randAddr();
    const [config] = await getProtocolConfigPda(programId);
    const [buyoutOffer] = await getBuyoutOfferPda(asset, buyer, programId);
    const p = { org: randAddr(), asset, acceptedMint: randAddr(), buyer, payer: randAddr(), pricePerShare: 500n, isCouncilBuyout: false, treasuryDisposition: 0, broker: randAddr(), brokerBps: 200, termsHash: new Uint8Array(32), expiry: 1700000000n };
    expectSameIx(
      await ix.createBuyoutOffer(p),
      bo.createBuyoutOffer({ ...p, config, buyoutOffer, programId }),
    );
  });

  it("fundBuyoutOffer derives escrow", async () => {
    const buyoutOffer = randAddr();
    const [escrow] = await getBuyoutEscrowPda(buyoutOffer, programId);
    const p = { buyoutOffer, asset: randAddr(), buyerTokenAcc: randAddr(), acceptedMint: randAddr(), buyer: randAddr(), payer: randAddr() };
    expectSameIx(
      await ix.fundBuyoutOffer(p),
      bo.fundBuyoutOffer({ ...p, escrow, programId }),
    );
  });

  it("approveBuyout passes through with programId", async () => {
    const p = { buyoutOffer: randAddr(), asset: randAddr(), org: randAddr(), authority: randAddr() };
    expectSameIx(await ix.approveBuyout(p), bo.approveBuyout({ ...p, programId }));
  });

  it("settleBuyout passes through with programId", async () => {
    const p = { buyoutOffer: randAddr(), asset: randAddr(), payer: randAddr(), count: 5 };
    expectSameIx(await ix.settleBuyout(p), bo.settleBuyout({ ...p, programId }));
  });

  it("completeBuyout passes through with programId", async () => {
    const p = { buyoutOffer: randAddr(), asset: randAddr(), buyer: randAddr() };
    expectSameIx(await ix.completeBuyout(p), bo.completeBuyout({ ...p, programId }));
  });

  it("cancelBuyout without escrow", async () => {
    const p = { buyoutOffer: randAddr(), asset: randAddr(), buyer: randAddr(), rentDestination: randAddr() };
    expectSameIx(await ix.cancelBuyout(p), bo.cancelBuyout({ ...p, escrow: undefined, programId }));
  });

  it("cancelBuyout with escrow — auto-derives from buyoutOffer", async () => {
    const buyoutOffer = randAddr();
    const tokenProgram = randAddr();
    const [escrow] = await getBuyoutEscrowPda(buyoutOffer, programId);
    const p = { buyoutOffer, asset: randAddr(), buyer: randAddr(), rentDestination: randAddr(), buyerTokenAcc: randAddr(), tokenProgram };
    expectSameIx(await ix.cancelBuyout(p), bo.cancelBuyout({ ...p, escrow, programId }));
  });
});

//  Emergency 

describe("ix.emergency", () => {
  it("burnAndRemint derives emergencyRecord + collectionAuthority", async () => {
    const oldAssetTokenAccount = randAddr();
    const collection = randAddr();
    const [emergencyRecordAccount] = await getEmergencyRecordPda(oldAssetTokenAccount, programId);
    const [collectionAuthority] = await getCollectionAuthorityPda(collection, programId);
    const p = {
      orgAccount: randAddr(), assetAccount: randAddr(), oldAssetTokenAccount,
      oldNft: randAddr(), collection, newNft: randAddr(),
      newAssetTokenAccount: randAddr(), newOwner: randAddr(),
      orgAuthority: randAddr(), payer: randAddr(), reason: 0, sharesToTransfer: 0n,
    };
    expectSameIx(
      await ix.burnAndRemint(p),
      emg.burnAndRemint({ ...p, emergencyRecordAccount, collectionAuthority, programId }),
    );
  });

  it("splitAndRemint derives emergencyRecord + collectionAuthority", async () => {
    const oldAssetTokenAccount = randAddr();
    const collection = randAddr();
    const [emergencyRecordAccount] = await getEmergencyRecordPda(oldAssetTokenAccount, programId);
    const [collectionAuthority] = await getCollectionAuthorityPda(collection, programId);
    const p = {
      orgAccount: randAddr(), assetAccount: randAddr(), oldAssetTokenAccount,
      oldNft: randAddr(), collection,
      orgAuthority: randAddr(), payer: randAddr(),
      recipients: [{ newNft: randAddr(), newAssetTokenAccount: randAddr(), recipient: randAddr(), shares: 50n }],
    };
    expectSameIx(
      await ix.splitAndRemint(p),
      emg.splitAndRemint({ ...p, emergencyRecordAccount, collectionAuthority, programId }),
    );
  });
});

//  Config caching 

describe("config PDA caching", () => {
  it("multiple methods share the same config PDA", async () => {
    const [config] = await getProtocolConfigPda(programId);
    const op = randAddr();
    const [a, b, c] = await Promise.all([
      ix.pauseProtocol({ operator: op }),
      ix.unpauseProtocol({ operator: op }),
      ix.updateConfigFeeBps({ operator: op, feeBps: 100 }),
    ]);
    expect(a.accounts![0].address).toBe(config);
    expect(b.accounts![0].address).toBe(config);
    expect(c.accounts![0].address).toBe(config);
  });
});
