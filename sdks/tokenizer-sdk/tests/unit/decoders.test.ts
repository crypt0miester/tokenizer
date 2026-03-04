import { describe, it, expect } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { AccountKey, AssetStatus, RoundStatus, ListingStatus, OfferStatus, BuyoutStatus } from "../../src/constants.js";
import {
  decodeProtocolConfig,
  PROTOCOL_CONFIG_SIZE,
} from "../../src/accounts/protocolConfig.js";
import {
  decodeOrganization,
  ORGANIZATION_SIZE,
} from "../../src/accounts/organization.js";
import { decodeAsset, ASSET_SIZE } from "../../src/accounts/asset.js";
import {
  decodeAssetToken,
  ASSET_TOKEN_SIZE,
} from "../../src/accounts/assetToken.js";
import {
  decodeFundraisingRound,
  FUNDRAISING_ROUND_SIZE,
} from "../../src/accounts/fundraisingRound.js";
import {
  decodeInvestment,
  INVESTMENT_SIZE,
} from "../../src/accounts/investment.js";
import { decodeListing, LISTING_SIZE } from "../../src/accounts/listing.js";
import { decodeOffer, OFFER_SIZE } from "../../src/accounts/offer.js";
import {
  decodeDividendDistribution,
  DIVIDEND_DISTRIBUTION_SIZE,
} from "../../src/accounts/dividendDistribution.js";
import {
  decodeEmergencyRecord,
  EMERGENCY_RECORD_SIZE,
} from "../../src/accounts/emergencyRecord.js";
import {
  decodeBuyoutOffer,
  BUYOUT_OFFER_SIZE,
} from "../../src/accounts/buyoutOffer.js";
import {
  buildProtocolConfigBytes,
  buildOrganizationBytes,
  buildAssetBytes,
  buildAssetTokenBytes,
  buildFundraisingRoundBytes,
  buildInvestmentBytes,
  buildListingBytes,
  buildOfferBytes,
  buildDistributionBytes,
  buildEmergencyRecordBytes,
  buildBuyoutOfferBytes,
} from "../helpers/accounts.js";

// Helpers───

function addrOf(pk: PublicKey): string {
  return pk.toBase58();
}

// ProtocolConfig

describe("decodeProtocolConfig", () => {
  const operator = Keypair.generate().publicKey;
  const realm = Keypair.generate().publicKey;
  const treasury = Keypair.generate().publicKey;
  const mint1 = Keypair.generate().publicKey;
  const mint2 = Keypair.generate().publicKey;

  it("decodes all fields correctly", () => {
    const data = buildProtocolConfigBytes({
      operator,
      realm,
      feeBps: 250,
      feeTreasury: treasury,
      paused: false,
      acceptedMintCount: 2,
      acceptedMints: [mint1, mint2],
      totalOrganizations: 42,
      bump: 253,
    });
    const config = decodeProtocolConfig(data);

    expect(config.accountKey).toBe(AccountKey.ProtocolConfig);
    expect(config.version).toBe(1);
    expect(config.operator).toBe(addrOf(operator));
    expect(config.realm).toBe(addrOf(realm));
    expect(config.feeBps).toBe(250);
    expect(config.feeTreasury).toBe(addrOf(treasury));
    expect(config.paused).toBe(false);
    expect(config.acceptedMintCount).toBe(2);
    expect(config.acceptedMints).toHaveLength(2);
    expect(config.acceptedMints[0]).toBe(addrOf(mint1));
    expect(config.acceptedMints[1]).toBe(addrOf(mint2));
    expect(config.totalOrganizations).toBe(42);
    expect(config.bump).toBe(253);
  });

  it("throws on wrong account key", () => {
    const data = buildProtocolConfigBytes({ accountKey: AccountKey.Organization });
    expect(() => decodeProtocolConfig(data)).toThrow("invalid account key");
  });

  it("throws on undersized buffer", () => {
    const data = new Uint8Array(PROTOCOL_CONFIG_SIZE - 1);
    data[0] = AccountKey.ProtocolConfig;
    expect(() => decodeProtocolConfig(data)).toThrow(`expected ${PROTOCOL_CONFIG_SIZE}`);
  });
});

// Organization──

describe("decodeOrganization", () => {
  const authority = Keypair.generate().publicKey;
  const realm = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;

  it("decodes all fields correctly", () => {
    const data = buildOrganizationBytes({
      id: 7,
      authority,
      name: "AcmeCorp",
      registrationNumber: "BR-12345",
      country: "BR",
      isActive: true,
      assetCount: 3,
      realm,
      acceptedMintCount: 1,
      acceptedMints: [mint],
      createdAt: 1700001000n,
      updatedAt: 1700002000n,
      bump: 252,
      roundFeeMode: 0,
      buyoutFeeMode: 1,
      secondaryFeeMode: 0,
      distributionFeeMode: 1,
      roundFeeValue: 250n,
      buyoutFeeValue: 5000000n,
      secondaryFeeValue: 100n,
      distributionFeeValue: 1000000n,
    });
    const org = decodeOrganization(data);

    expect(org.accountKey).toBe(AccountKey.Organization);
    expect(org.id).toBe(7);
    expect(org.authority).toBe(addrOf(authority));
    expect(org.name).toBe("AcmeCorp");
    expect(org.registrationNumber).toBe("BR-12345");
    expect(org.country).toBe("BR");
    expect(org.isActive).toBe(true);
    expect(org.assetCount).toBe(3);
    expect(org.realm).toBe(addrOf(realm));
    expect(org.acceptedMintCount).toBe(1);
    expect(org.acceptedMints).toHaveLength(1);
    expect(org.acceptedMints[0]).toBe(addrOf(mint));
    expect(org.createdAt).toBe(1700001000n);
    expect(org.updatedAt).toBe(1700002000n);
    expect(org.bump).toBe(252);
    expect(org.roundFeeMode).toBe(0);
    expect(org.buyoutFeeMode).toBe(1);
    expect(org.secondaryFeeMode).toBe(0);
    expect(org.distributionFeeMode).toBe(1);
    expect(org.roundFeeValue).toBe(250n);
    expect(org.buyoutFeeValue).toBe(5000000n);
    expect(org.secondaryFeeValue).toBe(100n);
    expect(org.distributionFeeValue).toBe(1000000n);
  });

  it("throws on wrong account key", () => {
    const data = buildOrganizationBytes({ accountKey: AccountKey.Asset });
    expect(() => decodeOrganization(data)).toThrow("invalid account key");
  });

  it("throws on undersized buffer", () => {
    const data = new Uint8Array(ORGANIZATION_SIZE - 1);
    data[0] = AccountKey.Organization;
    expect(() => decodeOrganization(data)).toThrow(`expected ${ORGANIZATION_SIZE}`);
  });
});

// Asset─

describe("decodeAsset", () => {
  const org = Keypair.generate().publicKey;
  const collection = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const nativeTreasury = Keypair.generate().publicKey;
  const activeBuyout = Keypair.generate().publicKey;
  const complianceProgram = Keypair.generate().publicKey;

  it("decodes all fields correctly", () => {
    const data = buildAssetBytes({
      id: 5,
      organization: org,
      collection,
      totalShares: 500000n,
      mintedShares: 100000n,
      status: AssetStatus.Active,
      pricePerShare: 2000000n,
      acceptedMint: mint,
      dividendEpoch: 3,
      fundraisingRoundCount: 2,
      createdAt: 1700003000n,
      updatedAt: 1700004000n,
      bump: 251,
      collectionAuthorityBump: 250,
      nativeTreasury,
      activeBuyout,
      unmintedSucceededRounds: 1,
      openDistributions: 2,
      complianceProgram,
      transferCooldown: 86400n,
      maxHolders: 500,
      currentHolders: 42,
      maturityDate: 1800000000n,
      maturityGracePeriod: 2592000n,
    });
    const asset = decodeAsset(data);

    expect(asset.accountKey).toBe(AccountKey.Asset);
    expect(asset.id).toBe(5);
    expect(asset.organization).toBe(addrOf(org));
    expect(asset.collection).toBe(addrOf(collection));
    expect(asset.totalShares).toBe(500000n);
    expect(asset.mintedShares).toBe(100000n);
    expect(asset.status).toBe(AssetStatus.Active);
    expect(asset.pricePerShare).toBe(2000000n);
    expect(asset.acceptedMint).toBe(addrOf(mint));
    expect(asset.dividendEpoch).toBe(3);
    expect(asset.fundraisingRoundCount).toBe(2);
    expect(asset.createdAt).toBe(1700003000n);
    expect(asset.updatedAt).toBe(1700004000n);
    expect(asset.bump).toBe(251);
    expect(asset.collectionAuthorityBump).toBe(250);
    expect(asset.nativeTreasury).toBe(addrOf(nativeTreasury));
    expect(asset.activeBuyout).toBe(addrOf(activeBuyout));
    expect(asset.unmintedSucceededRounds).toBe(1);
    expect(asset.openDistributions).toBe(2);
    expect(asset.complianceProgram).toBe(addrOf(complianceProgram));
    expect(asset.transferCooldown).toBe(86400n);
    expect(asset.maxHolders).toBe(500);
    expect(asset.currentHolders).toBe(42);
    expect(asset.maturityDate).toBe(1800000000n);
    expect(asset.maturityGracePeriod).toBe(2592000n);
  });

  it("throws on wrong account key", () => {
    const data = buildAssetBytes({ accountKey: AccountKey.Listing });
    expect(() => decodeAsset(data)).toThrow("invalid account key");
  });

  it("throws on undersized buffer", () => {
    const data = new Uint8Array(ASSET_SIZE - 1);
    data[0] = AccountKey.Asset;
    expect(() => decodeAsset(data)).toThrow(`expected ${ASSET_SIZE}`);
  });
});

// AssetToken

describe("decodeAssetToken", () => {
  const asset = Keypair.generate().publicKey;
  const nft = Keypair.generate().publicKey;
  const owner = Keypair.generate().publicKey;
  const parentToken = Keypair.generate().publicKey;

  it("decodes all fields correctly", () => {
    const data = buildAssetTokenBytes({
      asset,
      nft,
      owner,
      shares: 500n,
      isListed: true,
      activeVotes: 2,
      parentToken,
      lastClaimedEpoch: 1,
      tokenIndex: 7,
      createdAt: 1700005000n,
      bump: 249,
      lockupEnd: 1800000000n,
      lastTransferAt: 1700005500n,
      costBasisPerShare: 3000000n,
    });
    const token = decodeAssetToken(data);

    expect(token.accountKey).toBe(AccountKey.AssetToken);
    expect(token.asset).toBe(addrOf(asset));
    expect(token.nft).toBe(addrOf(nft));
    expect(token.owner).toBe(addrOf(owner));
    expect(token.shares).toBe(500n);
    expect(token.isListed).toBe(true);
    expect(token.activeVotes).toBe(2);
    expect(token.parentToken).toBe(addrOf(parentToken));
    expect(token.lastClaimedEpoch).toBe(1);
    expect(token.tokenIndex).toBe(7);
    expect(token.createdAt).toBe(1700005000n);
    expect(token.bump).toBe(249);
    expect(token.lockupEnd).toBe(1800000000n);
    expect(token.lastTransferAt).toBe(1700005500n);
    expect(token.costBasisPerShare).toBe(3000000n);
  });

  it("throws on wrong account key", () => {
    const data = buildAssetTokenBytes({ accountKey: AccountKey.Investment });
    expect(() => decodeAssetToken(data)).toThrow("invalid account key");
  });

  it("throws on undersized buffer", () => {
    const data = new Uint8Array(ASSET_TOKEN_SIZE - 1);
    data[0] = AccountKey.AssetToken;
    expect(() => decodeAssetToken(data)).toThrow(`expected ${ASSET_TOKEN_SIZE}`);
  });
});

// FundraisingRound──

describe("decodeFundraisingRound", () => {
  const asset = Keypair.generate().publicKey;
  const org = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const escrow = Keypair.generate().publicKey;
  const treasury = Keypair.generate().publicKey;

  it("decodes all fields correctly", () => {
    const termsHash = new Uint8Array(32);
    termsHash.fill(0xab);
    const data = buildFundraisingRoundBytes({
      roundIndex: 2,
      asset,
      organization: org,
      sharesOffered: 5000n,
      pricePerShare: 3000000n,
      acceptedMint: mint,
      minRaise: 100000000n,
      maxRaise: 500000000n,
      minPerWallet: 5000000n,
      maxPerWallet: 50000000n,
      startTime: 1700010000n,
      endTime: 1700020000n,
      status: RoundStatus.Active,
      escrow,
      totalRaised: 250000000n,
      sharesSold: 2500n,
      investorCount: 10,
      investorsSettled: 0,
      createdAt: 1700010000n,
      updatedAt: 1700015000n,
      bump: 248,
      escrowBump: 247,
      treasury,
      lockupEnd: 1800000000n,
      termsHash,
    });
    const round = decodeFundraisingRound(data);

    expect(round.accountKey).toBe(AccountKey.FundraisingRound);
    expect(round.roundIndex).toBe(2);
    expect(round.asset).toBe(addrOf(asset));
    expect(round.organization).toBe(addrOf(org));
    expect(round.sharesOffered).toBe(5000n);
    expect(round.pricePerShare).toBe(3000000n);
    expect(round.acceptedMint).toBe(addrOf(mint));
    expect(round.minRaise).toBe(100000000n);
    expect(round.maxRaise).toBe(500000000n);
    expect(round.minPerWallet).toBe(5000000n);
    expect(round.maxPerWallet).toBe(50000000n);
    expect(round.startTime).toBe(1700010000n);
    expect(round.endTime).toBe(1700020000n);
    expect(round.status).toBe(RoundStatus.Active);
    expect(round.escrow).toBe(addrOf(escrow));
    expect(round.totalRaised).toBe(250000000n);
    expect(round.sharesSold).toBe(2500n);
    expect(round.investorCount).toBe(10);
    expect(round.investorsSettled).toBe(0);
    expect(round.createdAt).toBe(1700010000n);
    expect(round.updatedAt).toBe(1700015000n);
    expect(round.bump).toBe(248);
    expect(round.escrowBump).toBe(247);
    expect(round.treasury).toBe(addrOf(treasury));
    expect(round.lockupEnd).toBe(1800000000n);
    expect(round.termsHash).toEqual(termsHash);
  });

  it("throws on wrong account key", () => {
    const data = buildFundraisingRoundBytes({ accountKey: AccountKey.Asset });
    expect(() => decodeFundraisingRound(data)).toThrow("invalid account key");
  });

  it("throws on undersized buffer", () => {
    const data = new Uint8Array(FUNDRAISING_ROUND_SIZE - 1);
    data[0] = AccountKey.FundraisingRound;
    expect(() => decodeFundraisingRound(data)).toThrow(`expected ${FUNDRAISING_ROUND_SIZE}`);
  });
});

// Investment

describe("decodeInvestment", () => {
  const round = Keypair.generate().publicKey;
  const investor = Keypair.generate().publicKey;

  it("decodes all fields correctly", () => {
    const data = buildInvestmentBytes({
      round,
      investor,
      sharesReserved: 200n,
      amountDeposited: 600000000n,
      isMinted: true,
      isRefunded: false,
      createdAt: 1700020000n,
      updatedAt: 1700025000n,
      bump: 246,
    });
    const inv = decodeInvestment(data);

    expect(inv.accountKey).toBe(AccountKey.Investment);
    expect(inv.round).toBe(addrOf(round));
    expect(inv.investor).toBe(addrOf(investor));
    expect(inv.sharesReserved).toBe(200n);
    expect(inv.amountDeposited).toBe(600000000n);
    expect(inv.isMinted).toBe(true);
    expect(inv.isRefunded).toBe(false);
    expect(inv.createdAt).toBe(1700020000n);
    expect(inv.updatedAt).toBe(1700025000n);
    expect(inv.bump).toBe(246);
  });

  it("throws on wrong account key", () => {
    const data = buildInvestmentBytes({ accountKey: AccountKey.Listing });
    expect(() => decodeInvestment(data)).toThrow("invalid account key");
  });

  it("throws on undersized buffer", () => {
    const data = new Uint8Array(INVESTMENT_SIZE - 1);
    data[0] = AccountKey.Investment;
    expect(() => decodeInvestment(data)).toThrow(`expected ${INVESTMENT_SIZE}`);
  });
});

// Listing───

describe("decodeListing", () => {
  const assetToken = Keypair.generate().publicKey;
  const asset = Keypair.generate().publicKey;
  const seller = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const rentPayer = Keypair.generate().publicKey;

  it("decodes all fields correctly", () => {
    const data = buildListingBytes({
      assetToken,
      asset,
      seller,
      acceptedMint: mint,
      sharesForSale: 75n,
      pricePerShare: 4000000n,
      expiry: 1700300000n,
      status: ListingStatus.Active,
      isPartial: true,
      createdAt: 1700030000n,
      bump: 245,
      rentPayer,
    });
    const listing = decodeListing(data);

    expect(listing.accountKey).toBe(AccountKey.Listing);
    expect(listing.assetToken).toBe(addrOf(assetToken));
    expect(listing.asset).toBe(addrOf(asset));
    expect(listing.seller).toBe(addrOf(seller));
    expect(listing.acceptedMint).toBe(addrOf(mint));
    expect(listing.sharesForSale).toBe(75n);
    expect(listing.pricePerShare).toBe(4000000n);
    expect(listing.expiry).toBe(1700300000n);
    expect(listing.status).toBe(ListingStatus.Active);
    expect(listing.isPartial).toBe(true);
    expect(listing.createdAt).toBe(1700030000n);
    expect(listing.bump).toBe(245);
    expect(listing.rentPayer).toBe(addrOf(rentPayer));
  });

  it("throws on wrong account key", () => {
    const data = buildListingBytes({ accountKey: AccountKey.Offer });
    expect(() => decodeListing(data)).toThrow("invalid account key");
  });

  it("throws on undersized buffer", () => {
    const data = new Uint8Array(LISTING_SIZE - 1);
    data[0] = AccountKey.Listing;
    expect(() => decodeListing(data)).toThrow(`expected ${LISTING_SIZE}`);
  });
});

// Offer─

describe("decodeOffer", () => {
  const assetToken = Keypair.generate().publicKey;
  const asset = Keypair.generate().publicKey;
  const buyer = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const escrow = Keypair.generate().publicKey;
  const rentPayer = Keypair.generate().publicKey;

  it("decodes all fields correctly", () => {
    const data = buildOfferBytes({
      assetToken,
      asset,
      buyer,
      acceptedMint: mint,
      sharesRequested: 50n,
      pricePerShare: 5000000n,
      expiry: 1700400000n,
      status: OfferStatus.Active,
      escrow,
      totalDeposited: 250000000n,
      createdAt: 1700040000n,
      bump: 244,
      escrowBump: 243,
      rentPayer,
    });
    const offer = decodeOffer(data);

    expect(offer.accountKey).toBe(AccountKey.Offer);
    expect(offer.assetToken).toBe(addrOf(assetToken));
    expect(offer.asset).toBe(addrOf(asset));
    expect(offer.buyer).toBe(addrOf(buyer));
    expect(offer.acceptedMint).toBe(addrOf(mint));
    expect(offer.sharesRequested).toBe(50n);
    expect(offer.pricePerShare).toBe(5000000n);
    expect(offer.expiry).toBe(1700400000n);
    expect(offer.status).toBe(OfferStatus.Active);
    expect(offer.escrow).toBe(addrOf(escrow));
    expect(offer.totalDeposited).toBe(250000000n);
    expect(offer.createdAt).toBe(1700040000n);
    expect(offer.bump).toBe(244);
    expect(offer.escrowBump).toBe(243);
    expect(offer.rentPayer).toBe(addrOf(rentPayer));
  });

  it("throws on wrong account key", () => {
    const data = buildOfferBytes({ accountKey: AccountKey.Investment });
    expect(() => decodeOffer(data)).toThrow("invalid account key");
  });

  it("throws on undersized buffer", () => {
    const data = new Uint8Array(OFFER_SIZE - 1);
    data[0] = AccountKey.Offer;
    expect(() => decodeOffer(data)).toThrow(`expected ${OFFER_SIZE}`);
  });
});

// DividendDistribution──

describe("decodeDividendDistribution", () => {
  const asset = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const escrow = Keypair.generate().publicKey;
  const rentPayer = Keypair.generate().publicKey;

  it("decodes all fields correctly", () => {
    const data = buildDistributionBytes({
      asset,
      epoch: 5,
      acceptedMint: mint,
      totalAmount: 50000000000n,
      totalShares: 1000000n,
      sharesClaimed: 500000n,
      escrow,
      createdAt: 1700050000n,
      bump: 242,
      escrowBump: 241,
      rentPayer,
    });
    const dist = decodeDividendDistribution(data);

    expect(dist.accountKey).toBe(AccountKey.DividendDistribution);
    expect(dist.asset).toBe(addrOf(asset));
    expect(dist.epoch).toBe(5);
    expect(dist.acceptedMint).toBe(addrOf(mint));
    expect(dist.totalAmount).toBe(50000000000n);
    expect(dist.totalShares).toBe(1000000n);
    expect(dist.sharesClaimed).toBe(500000n);
    expect(dist.escrow).toBe(addrOf(escrow));
    expect(dist.createdAt).toBe(1700050000n);
    expect(dist.bump).toBe(242);
    expect(dist.escrowBump).toBe(241);
    expect(dist.rentPayer).toBe(addrOf(rentPayer));
  });

  it("throws on wrong account key", () => {
    const data = buildDistributionBytes({ accountKey: AccountKey.EmergencyRecord });
    expect(() => decodeDividendDistribution(data)).toThrow("invalid account key");
  });

  it("throws on undersized buffer", () => {
    const data = new Uint8Array(DIVIDEND_DISTRIBUTION_SIZE - 1);
    data[0] = AccountKey.DividendDistribution;
    expect(() => decodeDividendDistribution(data)).toThrow(`expected ${DIVIDEND_DISTRIBUTION_SIZE}`);
  });
});

// EmergencyRecord───

describe("decodeEmergencyRecord", () => {
  const asset = Keypair.generate().publicKey;
  const oldAssetToken = Keypair.generate().publicKey;
  const oldOwner = Keypair.generate().publicKey;

  it("decodes all fields correctly", () => {
    const remainderToken = Keypair.generate().publicKey;
    const data = buildEmergencyRecordBytes({
      asset,
      oldAssetToken,
      oldOwner,
      recoveryType: 1,
      createdAt: 1700060000n,
      bump: 240,
      reason: 3,
      sharesTransferred: 500n,
      remainderToken,
    });
    const rec = decodeEmergencyRecord(data);

    expect(rec.accountKey).toBe(AccountKey.EmergencyRecord);
    expect(rec.asset).toBe(addrOf(asset));
    expect(rec.oldAssetToken).toBe(addrOf(oldAssetToken));
    expect(rec.oldOwner).toBe(addrOf(oldOwner));
    expect(rec.recoveryType).toBe(1);
    expect(rec.createdAt).toBe(1700060000n);
    expect(rec.bump).toBe(240);
    expect(rec.reason).toBe(3);
    expect(rec.sharesTransferred).toBe(500n);
    expect(rec.remainderToken).toBe(addrOf(remainderToken));
  });

  it("throws on wrong account key", () => {
    const data = buildEmergencyRecordBytes({ accountKey: AccountKey.ProtocolConfig });
    expect(() => decodeEmergencyRecord(data)).toThrow("invalid account key");
  });

  it("throws on undersized buffer", () => {
    const data = new Uint8Array(EMERGENCY_RECORD_SIZE - 1);
    data[0] = AccountKey.EmergencyRecord;
    expect(() => decodeEmergencyRecord(data)).toThrow(`expected ${EMERGENCY_RECORD_SIZE}`);
  });
});

// BuyoutOffer──

describe("decodeBuyoutOffer", () => {
  const buyer = Keypair.generate().publicKey;
  const asset = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const escrow = Keypair.generate().publicKey;
  const broker = Keypair.generate().publicKey;
  const rentPayer = Keypair.generate().publicKey;

  it("decodes all fields correctly", () => {
    const termsHash = new Uint8Array(32);
    termsHash.fill(0xcd);
    const data = buildBuyoutOfferBytes({
      buyer,
      asset,
      pricePerShare: 5000000n,
      acceptedMint: mint,
      escrow,
      treasuryDisposition: 1,
      termsHash,
      broker,
      brokerBps: 200,
      brokerAmount: 10000000n,
      mintedShares: 500000n,
      sharesSettled: 100000n,
      treasuryAmount: 25000000n,
      status: BuyoutStatus.Funded,
      isCouncilBuyout: true,
      expiresAt: 1700300000n,
      createdAt: 1700070000n,
      updatedAt: 1700080000n,
      bump: 239,
      rentPayer,
    });
    const offer = decodeBuyoutOffer(data);

    expect(offer.accountKey).toBe(AccountKey.BuyoutOffer);
    expect(offer.version).toBe(1);
    expect(offer.buyer).toBe(addrOf(buyer));
    expect(offer.asset).toBe(addrOf(asset));
    expect(offer.pricePerShare).toBe(5000000n);
    expect(offer.acceptedMint).toBe(addrOf(mint));
    expect(offer.escrow).toBe(addrOf(escrow));
    expect(offer.treasuryDisposition).toBe(1);
    expect(offer.termsHash).toEqual(termsHash);
    expect(offer.broker).toBe(addrOf(broker));
    expect(offer.brokerBps).toBe(200);
    expect(offer.brokerAmount).toBe(10000000n);
    expect(offer.mintedShares).toBe(500000n);
    expect(offer.sharesSettled).toBe(100000n);
    expect(offer.treasuryAmount).toBe(25000000n);
    expect(offer.status).toBe(BuyoutStatus.Funded);
    expect(offer.isCouncilBuyout).toBe(true);
    expect(offer.expiresAt).toBe(1700300000n);
    expect(offer.createdAt).toBe(1700070000n);
    expect(offer.updatedAt).toBe(1700080000n);
    expect(offer.bump).toBe(239);
    expect(offer.rentPayer).toBe(addrOf(rentPayer));
  });

  it("throws on wrong account key", () => {
    const data = buildBuyoutOfferBytes({ accountKey: AccountKey.Asset });
    expect(() => decodeBuyoutOffer(data)).toThrow("invalid account key");
  });

  it("throws on undersized buffer", () => {
    const data = new Uint8Array(BUYOUT_OFFER_SIZE - 1);
    data[0] = AccountKey.BuyoutOffer;
    expect(() => decodeBuyoutOffer(data)).toThrow(`expected ${BUYOUT_OFFER_SIZE}`);
  });
});
