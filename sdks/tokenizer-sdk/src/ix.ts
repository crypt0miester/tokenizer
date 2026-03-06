/**
 * Auto-deriving instruction namespace.
 *
 * Each method mirrors a raw instruction builder but automatically derives
 * deterministic PDAs (config, escrow, listing, etc.) so callers only need to
 * provide signers, external accounts, seed inputs, and business params.
 *
 * Usage:
 *   const client = createTokenizerClient(rpc);
 *   const ix = await client.ix.listForSale({ assetAccount, assetTokenAccount, seller, payer, ... });
 */
import type { Address } from "gill";
import * as assetIx from "./instructions/asset.js";
import * as bo from "./instructions/buyout.js";
import * as dist from "./instructions/distribution.js";
import * as emg from "./instructions/emergency.js";
import * as fund from "./instructions/fundraising.js";
import * as gov from "./instructions/governance.js";
import * as mkt from "./instructions/market.js";
import * as org from "./instructions/organization.js";
import * as proto from "./instructions/protocol.js";
import {
  getBuyoutEscrowPda,
  getBuyoutOfferPda,
  getCollectionAuthorityPda,
  getDistributionEscrowPda,
  getDistributionPda,
  getEmergencyRecordPda,
  getEscrowPda,
  getFundraisingRoundPda,
  getInvestmentPda,
  getListingPda,
  getMaxVoterWeightRecordPda,
  getOfferEscrowPda,
  getOfferPda,
  getOrganizationPda,
  getProtocolConfigPda,
  getRegistrarPda,
  getVoteRecordPda,
  getVoterWeightRecordPda,
} from "./pdas.js";

type P<F extends (...args: any[]) => any> = Parameters<F>[0];

export type IxNamespace = ReturnType<typeof createIxNamespace>;

export function createIxNamespace(programId: Address) {
  // Config PDA — singleton, resolved once and cached.
  const configPda = getProtocolConfigPda(programId);
  async function cfg() {
    return (await configPda)[0];
  }
  // Collection authority PDA — cached per collection address.
  const collAuthCache = new Map<Address, Promise<Address>>();
  function collAuth(c: Address): Promise<Address> {
    let p = collAuthCache.get(c);
    if (!p) {
      p = getCollectionAuthorityPda(c, programId).then((r) => r[0]);
      collAuthCache.set(c, p);
    }
    return p;
  }

  return {
    // Protocol

    async initializeProtocol(p: Omit<P<typeof proto.initializeProtocol>, "config" | "programId">) {
      const c = await cfg();
      return proto.initializeProtocol({ ...p, config: c, programId });
    },

    async updateConfigFeeBps(p: Omit<P<typeof proto.updateConfigFeeBps>, "config" | "programId">) {
      const c = await cfg();
      return proto.updateConfigFeeBps({ ...p, config: c, programId });
    },

    async updateConfigFeeTreasury(
      p: Omit<P<typeof proto.updateConfigFeeTreasury>, "config" | "programId">,
    ) {
      const c = await cfg();
      return proto.updateConfigFeeTreasury({ ...p, config: c, programId });
    },

    async updateConfigAddMint(
      p: Omit<P<typeof proto.updateConfigAddMint>, "config" | "programId">,
    ) {
      const c = await cfg();
      return proto.updateConfigAddMint({ ...p, config: c, programId });
    },

    async updateConfigRemoveMint(
      p: Omit<P<typeof proto.updateConfigRemoveMint>, "config" | "programId">,
    ) {
      const c = await cfg();
      return proto.updateConfigRemoveMint({ ...p, config: c, programId });
    },

    async updateConfigSetOperator(
      p: Omit<P<typeof proto.updateConfigSetOperator>, "config" | "programId">,
    ) {
      const c = await cfg();
      return proto.updateConfigSetOperator({ ...p, config: c, programId });
    },

    async updateConfigMinProposalWeightBps(
      p: Omit<P<typeof proto.updateConfigMinProposalWeightBps>, "config" | "programId">,
    ) {
      const c = await cfg();
      return proto.updateConfigMinProposalWeightBps({ ...p, config: c, programId });
    },

    async pauseProtocol(p: Omit<P<typeof proto.pauseProtocol>, "config" | "programId">) {
      const c = await cfg();
      return proto.pauseProtocol({ ...p, config: c, programId });
    },

    async unpauseProtocol(p: Omit<P<typeof proto.unpauseProtocol>, "config" | "programId">) {
      const c = await cfg();
      return proto.unpauseProtocol({ ...p, config: c, programId });
    },

    // Organization

    async registerOrganization(
      p: Omit<P<typeof org.registerOrganization>, "config" | "orgAccount" | "programId"> & {
        orgId: number;
      },
    ) {
      const [[orgAccount], c] = await Promise.all([getOrganizationPda(p.orgId, programId), cfg()]);
      return org.registerOrganization({ ...p, config: c, orgAccount, programId });
    },

    async deregisterOrganization(
      p: Omit<P<typeof org.deregisterOrganization>, "config" | "orgAccount" | "programId">,
    ) {
      const [[orgAccount], c] = await Promise.all([getOrganizationPda(p.orgId, programId), cfg()]);
      return org.deregisterOrganization({ ...p, config: c, orgAccount, programId });
    },

    async updateOrgAddMint(p: Omit<P<typeof org.updateOrgAddMint>, "config" | "programId">) {
      const c = await cfg();
      return org.updateOrgAddMint({ ...p, config: c, programId });
    },

    async updateOrgRemoveMint(p: Omit<P<typeof org.updateOrgRemoveMint>, "config" | "programId">) {
      const c = await cfg();
      return org.updateOrgRemoveMint({ ...p, config: c, programId });
    },

    // Asset

    async initAsset(
      p: Omit<P<typeof assetIx.initAsset>, "config" | "collectionAuthority" | "programId">,
    ) {
      const [collectionAuthority, c] = await Promise.all([collAuth(p.collection), cfg()]);
      return assetIx.initAsset({ ...p, config: c, collectionAuthority, programId });
    },

    async mintToken(
      p: Omit<P<typeof assetIx.mintToken>, "config" | "collectionAuthority" | "programId">,
    ) {
      const [collectionAuthority, c] = await Promise.all([collAuth(p.collection), cfg()]);
      return assetIx.mintToken({ ...p, config: c, collectionAuthority, programId });
    },

    async updateMetadata(
      p: Omit<P<typeof assetIx.updateMetadata>, "config" | "collectionAuthority" | "programId">,
    ) {
      const [collectionAuthority, c] = await Promise.all([collAuth(p.collection), cfg()]);
      return assetIx.updateMetadata({ ...p, config: c, collectionAuthority, programId });
    },

    refreshOraclePrice(p: Omit<P<typeof assetIx.refreshOraclePrice>, "programId">) {
      return assetIx.refreshOraclePrice({ ...p, programId });
    },

    configureOracle(p: Omit<P<typeof assetIx.configureOracle>, "programId">) {
      return assetIx.configureOracle({ ...p, programId });
    },

    // Fundraising

    async createRound(
      p: Omit<P<typeof fund.createRound>, "config" | "roundAccount" | "escrow" | "programId"> & {
        roundIndex: number;
      },
    ) {
      const [roundAccount] = await getFundraisingRoundPda(p.assetAccount, p.roundIndex, programId);
      const [[escrow], c] = await Promise.all([getEscrowPda(roundAccount, programId), cfg()]);
      return fund.createRound({ ...p, config: c, roundAccount, escrow, programId });
    },

    async invest(
      p: Omit<P<typeof fund.invest>, "config" | "investmentAccount" | "escrow" | "programId">,
    ) {
      const [[investmentAccount], [escrow], c] = await Promise.all([
        getInvestmentPda(p.roundAccount, p.investor, programId),
        getEscrowPda(p.roundAccount, programId),
        cfg(),
      ]);
      return fund.invest({ ...p, config: c, investmentAccount, escrow, programId });
    },

    async finalizeRound(p: Omit<P<typeof fund.finalizeRound>, "config" | "escrow" | "programId">) {
      const [[escrow], c] = await Promise.all([getEscrowPda(p.roundAccount, programId), cfg()]);
      return fund.finalizeRound({ ...p, config: c, escrow, programId });
    },

    async mintRoundTokens(
      p: Omit<P<typeof fund.mintRoundTokens>, "collectionAuthority" | "programId">,
    ) {
      const collectionAuthority = await collAuth(p.collection);
      return fund.mintRoundTokens({ ...p, collectionAuthority, programId });
    },

    async refundInvestment(p: Omit<P<typeof fund.refundInvestment>, "escrow" | "programId">) {
      const [escrow] = await getEscrowPda(p.roundAccount, programId);
      return fund.refundInvestment({ ...p, escrow, programId });
    },

    async cancelRound(p: Omit<P<typeof fund.cancelRound>, "config" | "programId">) {
      const c = await cfg();
      return fund.cancelRound({ ...p, config: c, programId });
    },

    // Market

    async listForSale(
      p: Omit<P<typeof mkt.listForSale>, "config" | "listingAccount" | "programId">,
    ) {
      const [[listingAccount], c] = await Promise.all([
        getListingPda(p.assetTokenAccount, programId),
        cfg(),
      ]);
      return mkt.listForSale({ ...p, config: c, listingAccount, programId });
    },

    async delist(p: Omit<P<typeof mkt.delist>, "listingAccount" | "programId">) {
      const [listingAccount] = await getListingPda(p.assetTokenAccount, programId);
      return mkt.delist({ ...p, listingAccount, programId });
    },

    async buyListedToken(
      p: Omit<
        P<typeof mkt.buyListedToken>,
        "config" | "listing" | "collectionAuthority" | "programId"
      >,
    ) {
      const [[listing], collectionAuthority, c] = await Promise.all([
        getListingPda(p.assetToken, programId),
        collAuth(p.collection),
        cfg(),
      ]);
      return mkt.buyListedToken({ ...p, config: c, listing, collectionAuthority, programId });
    },

    async makeOffer(
      p: Omit<P<typeof mkt.makeOffer>, "config" | "offerAccount" | "escrow" | "programId">,
    ) {
      const [offerAccount] = await getOfferPda(p.assetTokenAccount, p.buyer, programId);
      const [[escrow], c] = await Promise.all([getOfferEscrowPda(offerAccount, programId), cfg()]);
      return mkt.makeOffer({ ...p, config: c, offerAccount, escrow, programId });
    },

    async acceptOffer(
      p: Omit<P<typeof mkt.acceptOffer>, "config" | "escrow" | "collectionAuthority" | "programId">,
    ) {
      const [[escrow], collectionAuthority, c] = await Promise.all([
        getOfferEscrowPda(p.offer, programId),
        collAuth(p.collection),
        cfg(),
      ]);
      return mkt.acceptOffer({ ...p, config: c, escrow, collectionAuthority, programId });
    },

    async rejectOffer(p: Omit<P<typeof mkt.rejectOffer>, "escrow" | "programId">) {
      const [escrow] = await getOfferEscrowPda(p.offerAccount, programId);
      return mkt.rejectOffer({ ...p, escrow, programId });
    },

    async cancelOffer(p: Omit<P<typeof mkt.cancelOffer>, "escrow" | "programId">) {
      const [escrow] = await getOfferEscrowPda(p.offerAccount, programId);
      return mkt.cancelOffer({ ...p, escrow, programId });
    },

    async transferToken(
      p: Omit<P<typeof mkt.transferToken>, "config" | "collectionAuthority" | "programId">,
    ) {
      const [collectionAuthority, c] = await Promise.all([collAuth(p.collection), cfg()]);
      return mkt.transferToken({ ...p, config: c, collectionAuthority, programId });
    },

    async consolidateTokens(
      p: Omit<P<typeof mkt.consolidateTokens>, "config" | "collectionAuthority" | "programId">,
    ) {
      const [collectionAuthority, c] = await Promise.all([collAuth(p.collection), cfg()]);
      return mkt.consolidateTokens({ ...p, config: c, collectionAuthority, programId });
    },

    // Distribution

    async createDistribution(
      p: Omit<
        P<typeof dist.createDistribution>,
        "config" | "distributionAccount" | "escrow" | "programId"
      > & { epoch: number },
    ) {
      const [distributionAccount] = await getDistributionPda(p.assetAccount, p.epoch, programId);
      const [[escrow], c] = await Promise.all([
        getDistributionEscrowPda(distributionAccount, programId),
        cfg(),
      ]);
      return dist.createDistribution({
        ...p,
        config: c,
        distributionAccount,
        escrow,
        programId,
      });
    },

    async claimDistribution(p: Omit<P<typeof dist.claimDistribution>, "escrow" | "programId">) {
      const [escrow] = await getDistributionEscrowPda(p.distributionAccount, programId);
      return dist.claimDistribution({ ...p, escrow, programId });
    },

    async closeDistribution(p: Omit<P<typeof dist.closeDistribution>, "escrow" | "programId">) {
      const [escrow] = await getDistributionEscrowPda(p.distributionAccount, programId);
      return dist.closeDistribution({ ...p, escrow, programId });
    },

    // Governance

    async createRegistrar(
      p: Omit<P<typeof gov.createRegistrar>, "registrarAccount" | "programId">,
    ) {
      const [registrarAccount] = await getRegistrarPda(p.realm, p.governingTokenMint, programId);
      return gov.createRegistrar({ ...p, registrarAccount, programId });
    },

    async createVoterWeightRecord(
      p: Omit<
        P<typeof gov.createVoterWeightRecord>,
        "registrarAccount" | "voterWeightRecordAccount" | "programId"
      > & { realm: Address; governingTokenMint: Address },
    ) {
      const [[registrarAccount], [voterWeightRecordAccount]] = await Promise.all([
        getRegistrarPda(p.realm, p.governingTokenMint, programId),
        getVoterWeightRecordPda(p.realm, p.governingTokenMint, p.governingTokenOwner, programId),
      ]);
      return gov.createVoterWeightRecord({
        ...p,
        registrarAccount,
        voterWeightRecordAccount,
        programId,
      });
    },

    async createMaxVoterWeightRecord(
      p: Omit<
        P<typeof gov.createMaxVoterWeightRecord>,
        "registrarAccount" | "maxVoterWeightRecordAccount" | "programId"
      > & { governingTokenMint: Address },
    ) {
      const [[registrarAccount], [maxVoterWeightRecordAccount]] = await Promise.all([
        getRegistrarPda(p.realm, p.governingTokenMint, programId),
        getMaxVoterWeightRecordPda(p.realm, p.governingTokenMint, programId),
      ]);
      return gov.createMaxVoterWeightRecord({
        ...p,
        registrarAccount,
        maxVoterWeightRecordAccount,
        programId,
      });
    },

    async updateVoterWeightRecord(
      p: Omit<
        P<typeof gov.updateVoterWeightRecord>,
        "registrarAccount" | "voterWeightRecordAccount" | "voteRecordAccounts" | "programId"
      > & { realm: Address; governingTokenMint: Address },
    ) {
      const [[registrarAccount], [voterWeightRecordAccount]] = await Promise.all([
        getRegistrarPda(p.realm, p.governingTokenMint, programId),
        getVoterWeightRecordPda(p.realm, p.governingTokenMint, p.voterAuthority, programId),
      ]);
      let voteRecordAccounts: Address[] | undefined;
      if (p.action === 0) {
        voteRecordAccounts = await Promise.all(
          p.assetTokenAccounts.map((at) => getVoteRecordPda(at, programId).then((r) => r[0])),
        );
      }
      return gov.updateVoterWeightRecord({
        ...p,
        registrarAccount,
        voterWeightRecordAccount,
        voteRecordAccounts,
        programId,
      });
    },

    async relinquishVoterWeight(
      p: Omit<
        P<typeof gov.relinquishVoterWeight>,
        "registrarAccount" | "voteRecordAccounts" | "programId"
      > & { realm: Address; governingTokenMint: Address },
    ) {
      const [registrarResult, ...voteRecordResults] = await Promise.all([
        getRegistrarPda(p.realm, p.governingTokenMint, programId),
        ...p.assetTokenAccounts.map((at) => getVoteRecordPda(at, programId)),
      ]);
      const registrarAccount = registrarResult[0];
      const voteRecordAccounts = voteRecordResults.map((r) => r[0]);
      return gov.relinquishVoterWeight({
        ...p,
        registrarAccount,
        voteRecordAccounts,
        programId,
      });
    },

    async createProtocolRealm(p: Omit<P<typeof gov.createProtocolRealm>, "config" | "programId">) {
      const c = await cfg();
      return gov.createProtocolRealm({ ...p, config: c, programId });
    },

    async createOrgRealm(p: Omit<P<typeof gov.createOrgRealm>, "config" | "programId">) {
      const c = await cfg();
      return gov.createOrgRealm({ ...p, config: c, programId });
    },

    async createAssetGovernance(
      p: Omit<P<typeof gov.createAssetGovernance>, "config" | "programId">,
    ) {
      const c = await cfg();
      return gov.createAssetGovernance({ ...p, config: c, programId });
    },

    // Buyout

    async createBuyoutOffer(
      p: Omit<P<typeof bo.createBuyoutOffer>, "config" | "buyoutOffer" | "programId">,
    ) {
      const [[buyoutOffer], c] = await Promise.all([
        getBuyoutOfferPda(p.asset, p.buyer, programId),
        cfg(),
      ]);
      return bo.createBuyoutOffer({ ...p, config: c, buyoutOffer, programId });
    },

    async fundBuyoutOffer(p: Omit<P<typeof bo.fundBuyoutOffer>, "escrow" | "programId">) {
      const [escrow] = await getBuyoutEscrowPda(p.buyoutOffer, programId);
      return bo.fundBuyoutOffer({ ...p, escrow, programId });
    },

    async approveBuyout(p: Omit<P<typeof bo.approveBuyout>, "programId">) {
      return bo.approveBuyout({ ...p, programId });
    },

    async settleBuyout(p: Omit<P<typeof bo.settleBuyout>, "programId">) {
      return bo.settleBuyout({ ...p, programId });
    },

    async completeBuyout(p: Omit<P<typeof bo.completeBuyout>, "programId">) {
      return bo.completeBuyout({ ...p, programId });
    },

    async cancelBuyout(p: Omit<P<typeof bo.cancelBuyout>, "escrow" | "programId">) {
      let escrow: Address | undefined;
      if (p.buyerTokenAcc && p.tokenProgram) {
        [escrow] = await getBuyoutEscrowPda(p.buyoutOffer, programId);
      }
      return bo.cancelBuyout({ ...p, escrow, programId });
    },

    // Emergency

    async burnAndRemint(
      p: Omit<
        P<typeof emg.burnAndRemint>,
        "emergencyRecordAccount" | "collectionAuthority" | "programId"
      >,
    ) {
      const [[emergencyRecordAccount], collectionAuthority] = await Promise.all([
        getEmergencyRecordPda(p.oldAssetTokenAccount, programId),
        collAuth(p.collection),
      ]);
      return emg.burnAndRemint({
        ...p,
        emergencyRecordAccount,
        collectionAuthority,
        programId,
      });
    },

    async splitAndRemint(
      p: Omit<
        P<typeof emg.splitAndRemint>,
        "emergencyRecordAccount" | "collectionAuthority" | "programId"
      >,
    ) {
      const [[emergencyRecordAccount], collectionAuthority] = await Promise.all([
        getEmergencyRecordPda(p.oldAssetTokenAccount, programId),
        collAuth(p.collection),
      ]);
      return emg.splitAndRemint({
        ...p,
        emergencyRecordAccount,
        collectionAuthority,
        programId,
      });
    },
  };
}
