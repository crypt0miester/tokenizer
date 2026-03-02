/**
 * High-level client that combines PDA derivation + RPC fetching + decoding.
 *
 * Usage:
 *   import { createSolanaClient } from "gill";
 *
 *   const { rpc } = createSolanaClient({ urlOrMoniker: "mainnet" });
 *   const client = createTokenizerClient(rpc);
 *
 *   const config = await client.getProtocolConfig();
 *   const assets = await client.getAssetsByOrganization(orgKey);
 *   const listings = await client.getListingsByAsset(assetKey);
 */
import {
  type Address,
  type Base64EncodedBytes,
  type GetProgramAccountsMemcmpFilter,
  type Rpc,
  type SolanaRpcApi,
  address as toAddress,
  fetchEncodedAccount,
  fetchEncodedAccounts,
  getBase64Decoder,
  getBase64Encoder,
} from "gill";
import {
  ASSET_OFFSET_ORGANIZATION,
  ASSET_TOKEN_OFFSET_ASSET,
  ASSET_TOKEN_OFFSET_OWNER,
  type Asset,
  type AssetToken,
  DIVIDEND_DISTRIBUTION_OFFSET_ASSET,
  type DividendDistribution,
  decodeAsset,
  decodeAssetToken,
  decodeDividendDistribution,
  decodeEmergencyRecord,
  decodeFundraisingRound,
  decodeInvestment,
  decodeListing,
  decodeOffer,
  decodeOrganization,
  decodeProtocolConfig,
  decodeRegistrar,
  EMERGENCY_RECORD_OFFSET_ASSET,
  type EmergencyRecord,
  FUNDRAISING_ROUND_OFFSET_ASSET,
  FUNDRAISING_ROUND_OFFSET_ORGANIZATION,
  FUNDRAISING_ROUND_OFFSET_STATUS,
  type FundraisingRound,
  INVESTMENT_OFFSET_INVESTOR,
  INVESTMENT_OFFSET_ROUND,
  type Investment,
  LISTING_OFFSET_ASSET,
  LISTING_OFFSET_ASSET_TOKEN,
  LISTING_OFFSET_SELLER,
  LISTING_OFFSET_STATUS,
  type Listing,
  OFFER_OFFSET_ASSET,
  OFFER_OFFSET_ASSET_TOKEN,
  OFFER_OFFSET_BUYER,
  OFFER_OFFSET_STATUS,
  type Offer,
  type Organization,
  type ProtocolConfig,
} from "./accounts/index.js";
import { type AssetV1, type CollectionV1, decodeAssetV1, decodeCollectionV1 } from "./external/mpl-core/accounts.js";
import { readVoterWeight } from "./accounts/voterWeightRecord.js";
import {
  type ProposalV2,
  type TokenOwnerRecordV2,
  ProposalState,
  SPL_GOVERNANCE_PROGRAM_ID,
} from "./external/governance/index.js";
import {
  canVoteCouncil,
  fetchProposalsByGovernanceIterative,
  fetchRealm,
  fetchTokenOwnerRecord,
  fetchTokenOwnerRecordsByRealm,
  fetchVoteRecord,
  fetchProposal,
} from "./external/governance/fetch.js";
import {
  getGovernanceAddress,
  getTokenOwnerRecordAddress,
  getVoteRecordAddress,
} from "./external/governance/pdas.js";
import { getRegistrarPda, getVoterWeightRecordPda } from "./pdas.js";
import type { AssetFull, AssetTokenWithNft, OrgGovernanceOverview } from "./types.js";
import {
  AccountKey,
  type ListingStatus,
  type OfferStatus,
  type RoundStatus,
  TOKENIZER_PROGRAM_ID,
} from "./constants.js";
import {
  accountKeyFilter,
  addressFilter,
  type MemcmpFilter,
  type ProgramAccount,
  u8Filter,
} from "./filters.js";
import {
  getAssetPda,
  getAssetTokenPda,
  getDistributionPda,
  getEmergencyRecordPda,
  getFundraisingRoundPda,
  getInvestmentPda,
  getListingPda,
  getOfferPda,
  getOrganizationPda,
  getProtocolConfigPda,
} from "./pdas.js";

// ── getProgramAccounts helpers (no gill wrapper for this) ───────────

const b64Enc = getBase64Encoder();
const b64Dec = getBase64Decoder();

function decodeBase64(b64: string): Uint8Array {
  return new Uint8Array(b64Enc.encode(b64));
}

function toRpcFilters(filters: MemcmpFilter[]): GetProgramAccountsMemcmpFilter[] {
  return filters.map((f) => ({
    memcmp: {
      offset: BigInt(f.offset),
      bytes: b64Dec.decode(f.bytes) as Base64EncodedBytes,
      encoding: "base64" as const,
    },
  }));
}

// ── Client ──────────────────────────────────────────────────────────

export function createTokenizerClient(
  rpc: Rpc<SolanaRpcApi>,
  programId: Address = TOKENIZER_PROGRAM_ID,
) {
  async function fetchOne<T>(address: Address, decode: (data: Uint8Array) => T): Promise<T | null> {
    const account = await fetchEncodedAccount(rpc, address);
    if (!account.exists) return null;
    return decode(account.data);
  }

  async function fetchMany<T>(
    addresses: Address[],
    decode: (data: Uint8Array) => T,
  ): Promise<(T | null)[]> {
    const accounts = await fetchEncodedAccounts(rpc, addresses);
    return accounts.map((acct) => {
      if (!acct.exists) return null;
      return decode(acct.data);
    });
  }

  async function query<T>(
    filters: MemcmpFilter[],
    decode: (data: Uint8Array) => T,
  ): Promise<ProgramAccount<T>[]> {
    const result = await rpc
      .getProgramAccounts(programId, {
        encoding: "base64",
        filters: toRpcFilters(filters),
      })
      .send();
    return result.map(({ pubkey, account }) => ({
      address: pubkey,
      data: decode(decodeBase64(account.data[0])),
    }));
  }

  return {
    programId,

    // ── Raw fetch helpers ──────────────────────────────────────────

    fetchOne,
    fetchMany,

    // ── Single-account by PDA ─────────────────────────────────────

    async getProtocolConfig(): Promise<ProtocolConfig | null> {
      const [addr] = await getProtocolConfigPda(programId);
      return fetchOne(addr, decodeProtocolConfig);
    },

    async getOrganization(orgId: number): Promise<Organization | null> {
      const [addr] = await getOrganizationPda(orgId, programId);
      return fetchOne(addr, decodeOrganization);
    },

    async getAsset(orgKey: Address, assetId: number): Promise<Asset | null> {
      const [addr] = await getAssetPda(orgKey, assetId, programId);
      return fetchOne(addr, decodeAsset);
    },

    async getAssetToken(assetKey: Address, tokenIndex: number): Promise<AssetToken | null> {
      const [addr] = await getAssetTokenPda(assetKey, tokenIndex, programId);
      return fetchOne(addr, decodeAssetToken);
    },

    async getFundraisingRound(
      assetKey: Address,
      roundIndex: number,
    ): Promise<FundraisingRound | null> {
      const [addr] = await getFundraisingRoundPda(assetKey, roundIndex, programId);
      return fetchOne(addr, decodeFundraisingRound);
    },

    async getInvestment(roundKey: Address, investorKey: Address): Promise<Investment | null> {
      const [addr] = await getInvestmentPda(roundKey, investorKey, programId);
      return fetchOne(addr, decodeInvestment);
    },

    async getListing(assetTokenKey: Address): Promise<Listing | null> {
      const [addr] = await getListingPda(assetTokenKey, programId);
      return fetchOne(addr, decodeListing);
    },

    async getOffer(assetTokenKey: Address, buyerKey: Address): Promise<Offer | null> {
      const [addr] = await getOfferPda(assetTokenKey, buyerKey, programId);
      return fetchOne(addr, decodeOffer);
    },

    async getDistribution(assetKey: Address, epoch: number): Promise<DividendDistribution | null> {
      const [addr] = await getDistributionPda(assetKey, epoch, programId);
      return fetchOne(addr, decodeDividendDistribution);
    },

    async getEmergencyRecord(assetTokenKey: Address): Promise<EmergencyRecord | null> {
      const [addr] = await getEmergencyRecordPda(assetTokenKey, programId);
      return fetchOne(addr, decodeEmergencyRecord);
    },

    // ── Query: Organizations ──────────────────────────────────────

    async getAllOrganizations(): Promise<ProgramAccount<Organization>[]> {
      return query([accountKeyFilter(AccountKey.Organization)], decodeOrganization);
    },

    // ── Query: Assets ─────────────────────────────────────────────

    async getAllAssets(): Promise<ProgramAccount<Asset>[]> {
      return query([accountKeyFilter(AccountKey.Asset)], decodeAsset);
    },

    async getAssetsByOrganization(orgKey: Address): Promise<ProgramAccount<Asset>[]> {
      return query(
        [accountKeyFilter(AccountKey.Asset), addressFilter(ASSET_OFFSET_ORGANIZATION, orgKey)],
        decodeAsset,
      );
    },

    // ── Query: Asset Tokens ───────────────────────────────────────

    async getAssetTokensByAsset(assetKey: Address): Promise<ProgramAccount<AssetToken>[]> {
      return query(
        [
          accountKeyFilter(AccountKey.AssetToken),
          addressFilter(ASSET_TOKEN_OFFSET_ASSET, assetKey),
        ],
        decodeAssetToken,
      );
    },

    async getAssetTokensByOwner(ownerKey: Address): Promise<ProgramAccount<AssetToken>[]> {
      return query(
        [
          accountKeyFilter(AccountKey.AssetToken),
          addressFilter(ASSET_TOKEN_OFFSET_OWNER, ownerKey),
        ],
        decodeAssetToken,
      );
    },

    // ── Query: Fundraising Rounds ─────────────────────────────────

    async getFundraisingRoundsByAsset(
      assetKey: Address,
      status?: RoundStatus,
    ): Promise<ProgramAccount<FundraisingRound>[]> {
      const filters = [
        accountKeyFilter(AccountKey.FundraisingRound),
        addressFilter(FUNDRAISING_ROUND_OFFSET_ASSET, assetKey),
      ];
      if (status !== undefined) filters.push(u8Filter(FUNDRAISING_ROUND_OFFSET_STATUS, status));
      return query(filters, decodeFundraisingRound);
    },

    async getFundraisingRoundsByOrganization(
      orgKey: Address,
      status?: RoundStatus,
    ): Promise<ProgramAccount<FundraisingRound>[]> {
      const filters = [
        accountKeyFilter(AccountKey.FundraisingRound),
        addressFilter(FUNDRAISING_ROUND_OFFSET_ORGANIZATION, orgKey),
      ];
      if (status !== undefined) filters.push(u8Filter(FUNDRAISING_ROUND_OFFSET_STATUS, status));
      return query(filters, decodeFundraisingRound);
    },

    // ── Query: Investments ────────────────────────────────────────

    async getInvestmentsByRound(roundKey: Address): Promise<ProgramAccount<Investment>[]> {
      return query(
        [accountKeyFilter(AccountKey.Investment), addressFilter(INVESTMENT_OFFSET_ROUND, roundKey)],
        decodeInvestment,
      );
    },

    async getInvestmentsByInvestor(investorKey: Address): Promise<ProgramAccount<Investment>[]> {
      return query(
        [
          accountKeyFilter(AccountKey.Investment),
          addressFilter(INVESTMENT_OFFSET_INVESTOR, investorKey),
        ],
        decodeInvestment,
      );
    },

    // ── Query: Listings ───────────────────────────────────────────

    async getListingsByAsset(
      assetKey: Address,
      status?: ListingStatus,
    ): Promise<ProgramAccount<Listing>[]> {
      const filters = [
        accountKeyFilter(AccountKey.Listing),
        addressFilter(LISTING_OFFSET_ASSET, assetKey),
      ];
      if (status !== undefined) filters.push(u8Filter(LISTING_OFFSET_STATUS, status));
      return query(filters, decodeListing);
    },

    async getListingsByAssetToken(assetTokenKey: Address): Promise<ProgramAccount<Listing>[]> {
      return query(
        [
          accountKeyFilter(AccountKey.Listing),
          addressFilter(LISTING_OFFSET_ASSET_TOKEN, assetTokenKey),
        ],
        decodeListing,
      );
    },

    async getListingsBySeller(
      sellerKey: Address,
      status?: ListingStatus,
    ): Promise<ProgramAccount<Listing>[]> {
      const filters = [
        accountKeyFilter(AccountKey.Listing),
        addressFilter(LISTING_OFFSET_SELLER, sellerKey),
      ];
      if (status !== undefined) filters.push(u8Filter(LISTING_OFFSET_STATUS, status));
      return query(filters, decodeListing);
    },

    // ── Query: Offers ─────────────────────────────────────────────

    async getOffersByAssetToken(
      assetTokenKey: Address,
      status?: OfferStatus,
    ): Promise<ProgramAccount<Offer>[]> {
      const filters = [
        accountKeyFilter(AccountKey.Offer),
        addressFilter(OFFER_OFFSET_ASSET_TOKEN, assetTokenKey),
      ];
      if (status !== undefined) filters.push(u8Filter(OFFER_OFFSET_STATUS, status));
      return query(filters, decodeOffer);
    },

    async getOffersByAsset(
      assetKey: Address,
      status?: OfferStatus,
    ): Promise<ProgramAccount<Offer>[]> {
      const filters = [
        accountKeyFilter(AccountKey.Offer),
        addressFilter(OFFER_OFFSET_ASSET, assetKey),
      ];
      if (status !== undefined) filters.push(u8Filter(OFFER_OFFSET_STATUS, status));
      return query(filters, decodeOffer);
    },

    async getOffersByBuyer(
      buyerKey: Address,
      status?: OfferStatus,
    ): Promise<ProgramAccount<Offer>[]> {
      const filters = [
        accountKeyFilter(AccountKey.Offer),
        addressFilter(OFFER_OFFSET_BUYER, buyerKey),
      ];
      if (status !== undefined) filters.push(u8Filter(OFFER_OFFSET_STATUS, status));
      return query(filters, decodeOffer);
    },

    // ── Query: Distributions ──────────────────────────────────────

    async getDistributionsByAsset(
      assetKey: Address,
    ): Promise<ProgramAccount<DividendDistribution>[]> {
      return query(
        [
          accountKeyFilter(AccountKey.DividendDistribution),
          addressFilter(DIVIDEND_DISTRIBUTION_OFFSET_ASSET, assetKey),
        ],
        decodeDividendDistribution,
      );
    },

    // ── Query: Emergency Records ──────────────────────────────────

    async getEmergencyRecordsByAsset(
      assetKey: Address,
    ): Promise<ProgramAccount<EmergencyRecord>[]> {
      return query(
        [
          accountKeyFilter(AccountKey.EmergencyRecord),
          addressFilter(EMERGENCY_RECORD_OFFSET_ASSET, assetKey),
        ],
        decodeEmergencyRecord,
      );
    },

    // ── Composite fetchers ────────────────────────────────────────

    /** Fetch all AssetTokens for an asset with their MPL Core NFT data in a single batch. */
    async getAssetTokensWithNfts(assetKey: Address): Promise<AssetTokenWithNft[]> {
      const tokens = await query(
        [
          accountKeyFilter(AccountKey.AssetToken),
          addressFilter(ASSET_TOKEN_OFFSET_ASSET, assetKey),
        ],
        decodeAssetToken,
      );
      if (tokens.length === 0) return [];

      const nftAddresses = tokens.map((t) => t.data.nft);
      const nftAccounts = await fetchEncodedAccounts(rpc, nftAddresses);

      return tokens.map((t, i) => {
        const nftAcct = nftAccounts[i];
        return {
          address: t.address,
          token: t.data,
          nftAddress: nftAddresses[i],
          nft: nftAcct.exists ? decodeAssetV1(nftAcct.data) : null,
        };
      });
    },

    /** Fetch AssetTokens owned by a wallet with their MPL Core NFT data. */
    async getAssetTokensWithNftsByOwner(ownerKey: Address): Promise<AssetTokenWithNft[]> {
      const tokens = await query(
        [
          accountKeyFilter(AccountKey.AssetToken),
          addressFilter(ASSET_TOKEN_OFFSET_OWNER, ownerKey),
        ],
        decodeAssetToken,
      );
      if (tokens.length === 0) return [];

      const nftAddresses = tokens.map((t) => t.data.nft);
      const nftAccounts = await fetchEncodedAccounts(rpc, nftAddresses);

      return tokens.map((t, i) => {
        const nftAcct = nftAccounts[i];
        return {
          address: t.address,
          token: t.data,
          nftAddress: nftAddresses[i],
          nft: nftAcct.exists ? decodeAssetV1(nftAcct.data) : null,
        };
      });
    },

    /** Fetch an Asset with its MPL Core Collection data. */
    async getAssetFull(orgKey: Address, assetId: number): Promise<AssetFull | null> {
      const [addr] = await getAssetPda(orgKey, assetId, programId);
      const asset = await fetchOne(addr, decodeAsset);
      if (!asset) return null;

      const collAcct = await fetchEncodedAccount(rpc, asset.collection);
      return {
        address: addr,
        asset,
        collection: collAcct.exists ? decodeCollectionV1(collAcct.data) : null,
      };
    },

    /** Fetch a single AssetToken by PDA with its NFT. */
    async getAssetTokenWithNft(assetKey: Address, tokenIndex: number): Promise<AssetTokenWithNft | null> {
      const [addr] = await getAssetTokenPda(assetKey, tokenIndex, programId);
      const token = await fetchOne(addr, decodeAssetToken);
      if (!token) return null;

      const nftAcct = await fetchEncodedAccount(rpc, token.nft);
      return {
        address: addr,
        token,
        nftAddress: token.nft,
        nft: nftAcct.exists ? decodeAssetV1(nftAcct.data) : null,
      };
    },

    /** Fetch a Listing with its associated AssetToken and NFT data. */
    async getListingFull(assetTokenKey: Address): Promise<{
      listing: Listing;
      token: AssetToken | null;
      nft: AssetV1 | null;
    } | null> {
      const [addr] = await getListingPda(assetTokenKey, programId);
      const listing = await fetchOne(addr, decodeListing);
      if (!listing) return null;

      const token = await fetchOne(assetTokenKey, decodeAssetToken);
      let nft: AssetV1 | null = null;
      if (token) {
        const nftAcct = await fetchEncodedAccount(rpc, token.nft);
        nft = nftAcct.exists ? decodeAssetV1(nftAcct.data) : null;
      }
      return { listing, token, nft };
    },

    // ── Governance ────────────────────────────────────────────────

    /** Check whether an org has a realm (DAO governance) attached. */
    async isOrgGoverned(orgId: number): Promise<boolean> {
      const org = await this.getOrganization(orgId);
      if (!org) return false;
      const SYSTEM_PROGRAM = toAddress("11111111111111111111111111111111");
      return org.realm !== SYSTEM_PROGRAM;
    },

    /** Fetch all proposals for an org's governance. */
    async getProposalsByOrg(
      orgKey: Address,
      councilMint: Address,
      opts?: { tokenizerProgramId?: Address; govProgramId?: Address; batchSize?: number },
    ): Promise<ProgramAccount<ProposalV2>[]> {
      const org = await fetchOne(orgKey, decodeOrganization);
      if (!org) return [];
      const SYSTEM_PROGRAM = toAddress("11111111111111111111111111111111");
      if (org.realm === SYSTEM_PROGRAM) return [];

      const [governance] = await getGovernanceAddress(org.realm, orgKey, opts?.govProgramId);
      return fetchProposalsByGovernanceIterative(rpc, governance, councilMint, {
        tokenizerProgramId: opts?.tokenizerProgramId ?? programId,
        govProgramId: opts?.govProgramId,
        batchSize: opts?.batchSize,
      });
    },

    /** Get a voter's deposited weight and token owner record address. */
    async getVoterWeight(
      realm: Address,
      governingTokenMint: Address,
      owner: Address,
      opts?: { govProgramId?: Address },
    ): Promise<{ depositedWeight: bigint; tokenOwnerRecord: Address } | null> {
      const govProgramId = opts?.govProgramId ?? SPL_GOVERNANCE_PROGRAM_ID;
      const [torAddr] = await getTokenOwnerRecordAddress(realm, governingTokenMint, owner, govProgramId);
      const tor = await fetchTokenOwnerRecord(rpc, torAddr);
      if (!tor) return null;
      return {
        depositedWeight: tor.governingTokenDepositAmount,
        tokenOwnerRecord: torAddr,
      };
    },

    /** Get all council/community members for a realm. */
    async getCouncilMembers(
      realm: Address,
      opts?: { govProgramId?: Address },
    ): Promise<ProgramAccount<TokenOwnerRecordV2>[]> {
      return fetchTokenOwnerRecordsByRealm(rpc, realm, opts?.govProgramId);
    },

    /**
     * Can a council member vote on a protocol-level proposal?
     * Protocol governance is council-only (deposited membership tokens).
     */
    async canVoteProtocol(
      proposal: Address,
      voter: Address,
      councilMint: Address,
      opts?: { govProgramId?: Address },
    ): Promise<{ canVote: boolean; reason?: string }> {
      const config = await this.getProtocolConfig();
      if (!config) return { canVote: false, reason: "config_not_found" };
      const SYSTEM_PROGRAM = toAddress("11111111111111111111111111111111");
      if (config.realm === SYSTEM_PROGRAM) return { canVote: false, reason: "no_realm" };

      return canVoteCouncil(rpc, proposal, voter, config.realm, councilMint, opts);
    },

    /**
     * Can a council member vote on an org-level proposal?
     * Org governance is council-only (deposited membership tokens).
     */
    async canVoteOrg(
      proposal: Address,
      voter: Address,
      realm: Address,
      councilMint: Address,
      opts?: { govProgramId?: Address },
    ): Promise<{ canVote: boolean; reason?: string }> {
      return canVoteCouncil(rpc, proposal, voter, realm, councilMint, opts);
    },

    /**
     * Can a voter cast a vote on an asset-level proposal?
     * Asset governance supports both council and community voting.
     * Automatically detects which path based on the proposal's governingTokenMint:
     *   - Council: checks TOR deposit (same as protocol/org)
     *   - Community: checks VoteRecord first, then VWR / asset token ownership
     *
     * Community-specific reasons:
     *   - "needs_voter_weight_setup" — voter owns asset tokens but VWR is missing or stale (needs create + update)
     *   - "no_voter_weight" — voter has no asset tokens for this asset
     */
    async canVoteAsset(
      proposal: Address,
      voter: Address,
      realm: Address,
      opts?: { govProgramId?: Address },
    ): Promise<{ canVote: boolean; reason?: string }> {
      const govProgramId = opts?.govProgramId ?? SPL_GOVERNANCE_PROGRAM_ID;

      // 1. Fetch proposal + realm concurrently
      const [prop, realmData] = await Promise.all([
        fetchProposal(rpc, proposal),
        fetchRealm(rpc, realm),
      ]);
      if (!prop) return { canVote: false, reason: "proposal_not_found" };
      if (prop.state !== ProposalState.Voting) {
        return { canVote: false, reason: "not_voting" };
      }
      if (!realmData) return { canVote: false, reason: "realm_not_found" };

      const isCommunity = prop.governingTokenMint === realmData.communityMint;

      if (!isCommunity) {
        // Council path — pass pre-fetched proposal to avoid re-fetching
        return canVoteCouncil(rpc, proposal, voter, realm, prop.governingTokenMint, opts, prop);
      }

      // ── Community path ──────────────────────────────────────────

      // 2. Derive all PDA addresses concurrently (pure math, no RPC)
      const [[torAddr], [vwrAddr], [registrarAddr]] = await Promise.all([
        getTokenOwnerRecordAddress(realm, prop.governingTokenMint, voter, govProgramId),
        getVoterWeightRecordPda(realm, prop.governingTokenMint, voter, programId),
        getRegistrarPda(realm, prop.governingTokenMint, programId),
      ]);
      const [voteRecordAddr] = await getVoteRecordAddress(proposal, torAddr, govProgramId);

      // 3. Fetch VoteRecord + VWR + registrar concurrently
      const [existingVote, vwrAcct, registrar] = await Promise.all([
        fetchVoteRecord(rpc, voteRecordAddr),
        fetchEncodedAccount(rpc, vwrAddr),
        fetchOne(registrarAddr, decodeRegistrar),
      ]);

      if (existingVote) {
        return { canVote: false, reason: "already_voted" };
      }

      // 4. VWR exists with weight > 0 → ready to vote
      if (vwrAcct.exists && readVoterWeight(vwrAcct.data) > 0n) {
        return { canVote: true };
      }

      // 5. VWR missing or stale — check if voter owns asset tokens
      if (!registrar) return { canVote: false, reason: "no_voter_weight" };

      const tokens = await query(
        [
          accountKeyFilter(AccountKey.AssetToken),
          addressFilter(ASSET_TOKEN_OFFSET_ASSET, registrar.asset),
          addressFilter(ASSET_TOKEN_OFFSET_OWNER, voter),
        ],
        decodeAssetToken,
      );

      if (tokens.some((t) => t.data.shares > 0n)) {
        return { canVote: false, reason: "needs_voter_weight_setup" };
      }

      return { canVote: false, reason: "no_voter_weight" };
    },

    /** Composite fetcher: org + realm + governance + proposals + members. */
    async getOrgGovernanceOverview(
      orgId: number,
      councilMint: Address,
      opts?: { tokenizerProgramId?: Address; govProgramId?: Address; batchSize?: number },
    ): Promise<OrgGovernanceOverview | null> {
      const [orgAddr] = await getOrganizationPda(orgId, programId);
      const org = await fetchOne(orgAddr, decodeOrganization);
      if (!org) return null;

      const SYSTEM_PROGRAM = toAddress("11111111111111111111111111111111");
      if (org.realm === SYSTEM_PROGRAM) return null;

      const govProgramId = opts?.govProgramId ?? SPL_GOVERNANCE_PROGRAM_ID;
      const [governance] = await getGovernanceAddress(org.realm, orgAddr, govProgramId);

      const [proposals, members] = await Promise.all([
        fetchProposalsByGovernanceIterative(rpc, governance, councilMint, {
          tokenizerProgramId: opts?.tokenizerProgramId ?? programId,
          govProgramId,
          batchSize: opts?.batchSize,
        }),
        fetchTokenOwnerRecordsByRealm(rpc, org.realm, govProgramId),
      ]);

      return {
        org,
        realm: org.realm,
        governance,
        proposals,
        members,
      };
    },
  };
}
