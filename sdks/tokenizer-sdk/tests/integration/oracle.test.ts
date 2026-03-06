import { describe, it, expect, beforeEach } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { type LiteSVM } from "litesvm";
import { address, type Address } from "gill";
import {
  createTestSvm,
  sendTx,
  sendTxExpectFail,
  getAccountData,
  toAddress,
  createUsdcMint,
} from "../helpers/setup.js";
import { decodeAsset } from "../../src/accounts/asset.js";
import { initializeProtocol } from "../../src/instructions/protocol.js";
import {
  registerOrganization,
  updateOrgAddMint,
} from "../../src/instructions/organization.js";
import { initAsset, refreshOraclePrice, configureOracle } from "../../src/instructions/asset.js";
import {
  getProtocolConfigPda,
  getOrganizationPda,
  getAssetPda,
  getCollectionAuthorityPda,
} from "../../src/pdas.js";
import { AccountKey, OracleSource } from "../../src/constants.js";

// Constants

const PROGRAM_ID = address("FNDZziaztYptbydC5UpLEaLMyFN4rDmP3G2MN7o6w4ZK");
const PROGRAM_PK = new PublicKey("FNDZziaztYptbydC5UpLEaLMyFN4rDmP3G2MN7o6w4ZK");

const PYTH_PROGRAM_ID = new PublicKey("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");
const SWITCHBOARD_PROGRAM_ID = new PublicKey("SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv");

// Mock oracle data builders

/**
 * Build mock Pyth PriceAccount data (240 bytes).
 *
 * Layout (from p-pyth PythPriceAccount):
 *   0..4:   magic (0xa1b2c3d4)
 *   4..8:   ver (2)
 *   8..12:  atype (3 = Price)
 *   12..16: size
 *   16:     ptype
 *   17..20: _pad1
 *   20..24: expo (i32)
 *   24..28: num
 *   28..32: num_qt
 *   32..40: last_slot (u64)
 *   40..48: valid_slot (u64)
 *   48..72: ema_price (Rational: val, numer, denom)
 *   72..96: ema_conf (Rational)
 *   96..104: timestamp (i64)
 *   104:   min_pub
 *   ...
 *   208..240: agg (PriceInfo)
 *     208..216: price (i64)
 *     216..224: conf (u64)
 *     224:      status (u8, 1=Trading)
 *     225:      corp_act
 *     226..232: _padding
 *     232..240: pub_slot (u64)
 */
function buildMockPythData(opts: {
  price: bigint;
  conf: bigint;
  expo: number;
  slot: bigint;
}): Uint8Array {
  const data = new Uint8Array(240);
  const view = new DataView(data.buffer);

  // Magic
  view.setUint32(0, 0xa1b2c3d4, true);
  // Version
  view.setUint32(4, 2, true);
  // Account type (Price = 3)
  view.setUint32(8, 3, true);
  // Size
  view.setUint32(12, 240, true);
  // Exponent (i32)
  view.setInt32(20, opts.expo, true);
  // last_slot
  view.setBigUint64(32, opts.slot, true);
  // valid_slot
  view.setBigUint64(40, opts.slot, true);
  // timestamp
  view.setBigInt64(96, BigInt(1700000000), true);

  // agg.price (i64 at offset 208)
  view.setBigInt64(208, opts.price, true);
  // agg.conf (u64 at offset 216)
  view.setBigUint64(216, opts.conf, true);
  // agg.status (u8 at offset 224, 1 = Trading)
  data[224] = 1;
  // agg.pub_slot (u64 at offset 232)
  view.setBigUint64(232, opts.slot, true);

  return data;
}

/**
 * Build mock Switchboard PullFeedAccountData (min 2396 bytes).
 *
 * Key offsets (from p-switchboard):
 *   0..8:     discriminator
 *   2216..2224: last_update_timestamp (i64)
 *   2264..2280: result.value (i128)
 *   2280..2296: result.std_dev (i128)
 *   2368..2376: result.result_slot (u64)
 */
function buildMockSwitchboardData(opts: {
  value: bigint;
  stdDev: bigint;
  slot: bigint;
}): Uint8Array {
  const data = new Uint8Array(2396);
  const view = new DataView(data.buffer);

  // Discriminator: [196, 27, 108, 196, 10, 215, 219, 40]
  data.set([196, 27, 108, 196, 10, 215, 219, 40], 0);

  // last_update_timestamp (i64 at 2216)
  view.setBigInt64(2216, BigInt(1700000000), true);

  // result.value (i128 at 2264) — write as two i64s (LE)
  writeI128LE(data, 2264, opts.value);

  // result.std_dev (i128 at 2280)
  writeI128LE(data, 2280, opts.stdDev);

  // result.result_slot (u64 at 2368)
  view.setBigUint64(2368, opts.slot, true);

  return data;
}

/** Write a BigInt as a 128-bit little-endian value. */
function writeI128LE(data: Uint8Array, offset: number, value: bigint) {
  // Convert to unsigned 128-bit representation
  const mask = (1n << 128n) - 1n;
  let unsigned = value < 0n ? ((~(-value - 1n)) & mask) : value;
  for (let i = 0; i < 16; i++) {
    data[offset + i] = Number(unsigned & 0xffn);
    unsigned >>= 8n;
  }
}

// Test Suite

describe("Oracle Integration", () => {
  let svm: LiteSVM;
  let operator: Keypair;
  let payer: Keypair;
  let orgAuthority: Keypair;
  let mintAuthority: Keypair;
  let usdcMint: PublicKey;
  let configAddr: Address;
  let orgAddr: Address;

  beforeEach(async () => {
    svm = createTestSvm({ programId: PROGRAM_PK, loadMplCore: true });

    operator = Keypair.generate();
    payer = Keypair.generate();
    orgAuthority = Keypair.generate();
    mintAuthority = Keypair.generate();

    svm.airdrop(operator.publicKey, BigInt(10_000_000_000));
    svm.airdrop(payer.publicKey, BigInt(10_000_000_000));
    svm.airdrop(orgAuthority.publicKey, BigInt(10_000_000_000));

    usdcMint = createUsdcMint(svm, mintAuthority);

    const [configPda] = await getProtocolConfigPda(PROGRAM_ID);
    configAddr = configPda;

    // Initialize protocol
    sendTx(
      svm,
      [
        initializeProtocol({
          config: configAddr,
          operator: toAddress(operator.publicKey),
          payer: toAddress(payer.publicKey),
          feeBps: 100,
          feeTreasury: toAddress(Keypair.generate().publicKey),
          acceptedMint: toAddress(usdcMint),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, operator],
    );

    // Register org
    const [orgPda] = await getOrganizationPda(0, PROGRAM_ID);
    orgAddr = orgPda;

    sendTx(
      svm,
      [
        registerOrganization({
          config: configAddr,
          orgAccount: orgAddr,
          operator: toAddress(operator.publicKey),
          payer: toAddress(payer.publicKey),
          authority: toAddress(orgAuthority.publicKey),
          name: "TestOrg",
          registrationNumber: "REG-001",
          country: "US",
          programId: PROGRAM_ID,
        }),
      ],
      [payer, operator],
    );

    // Add USDC to org
    sendTx(
      svm,
      [
        updateOrgAddMint({
          config: configAddr,
          orgAccount: orgAddr,
          authority: toAddress(orgAuthority.publicKey),
          mint: toAddress(usdcMint),
          programId: PROGRAM_ID,
        }),
      ],
      [orgAuthority],
    );
  });

  /** Helper: create a mock oracle account owned by the given program. */
  function setMockAccount(pk: PublicKey, owner: PublicKey, data: Uint8Array) {
    svm.setAccount(pk, {
      lamports: 1_000_000_000,
      data,
      owner,
      executable: false,
    });
  }

  /** Helper: init an asset with oracle config. */
  async function initAssetWithOracle(opts: {
    oracleSource: number;
    oracleFeed: Address;
    sharesPerUnit?: bigint;
    oracleMaxStaleness?: number;
    oracleMaxConfidenceBps?: number;
    acceptedMintDecimals?: number;
  }) {
    const collection = Keypair.generate();
    const [assetPda] = await getAssetPda(orgAddr, 0, PROGRAM_ID);
    const [collAuthPda] = await getCollectionAuthorityPda(
      toAddress(collection.publicKey),
      PROGRAM_ID,
    );

    sendTx(
      svm,
      [
        initAsset({
          config: configAddr,
          orgAccount: orgAddr,
          assetAccount: assetPda,
          collection: toAddress(collection.publicKey),
          collectionAuthority: collAuthPda,
          authority: toAddress(orgAuthority.publicKey),
          payer: toAddress(payer.publicKey),
          totalShares: 1_000_000n,
          pricePerShare: 1_000_000n,
          acceptedMint: toAddress(usdcMint),
          maturityDate: 0n,
          maturityGracePeriod: 0n,
          transferCooldown: 0n,
          maxHolders: 0,
          oracleSource: opts.oracleSource,
          oracleMaxStaleness: opts.oracleMaxStaleness ?? 100,
          oracleMaxConfidenceBps: opts.oracleMaxConfidenceBps ?? 0,
          acceptedMintDecimals: opts.acceptedMintDecimals ?? 6,
          sharesPerUnit: opts.sharesPerUnit ?? 1000n,
          oracleFeed: opts.oracleFeed,
          name: "GoldAsset",
          uri: "https://example.com/gold.json",
          programId: PROGRAM_ID,
        }),
      ],
      [payer, orgAuthority, collection],
    );

    return { assetPda, collection };
  }

  describe("initAsset with oracle", () => {
    it("initializes asset with Pyth oracle config", async () => {
      const pythFeed = Keypair.generate();
      const currentSlot = svm.getClock().slot;
      const mockPythData = buildMockPythData({
        price: 265050n,
        conf: 100n,
        expo: -2,
        slot: currentSlot,
      });
      setMockAccount(pythFeed.publicKey, PYTH_PROGRAM_ID, mockPythData);

      const { assetPda } = await initAssetWithOracle({
        oracleSource: OracleSource.Pyth,
        oracleFeed: toAddress(pythFeed.publicKey),
      });

      const asset = decodeAsset(getAccountData(svm, assetPda));
      expect(asset.accountKey).toBe(AccountKey.Asset);
      expect(asset.oracleSource).toBe(OracleSource.Pyth);
      expect(asset.oracleFeed).toBe(toAddress(pythFeed.publicKey));
      expect(asset.sharesPerUnit).toBe(1000n);
      expect(asset.oracleMaxStaleness).toBe(100);
      expect(asset.acceptedMintDecimals).toBe(6);
    });

    it("initializes asset with Switchboard oracle config", async () => {
      const sbFeed = Keypair.generate();
      const currentSlot = svm.getClock().slot;
      const mockSbData = buildMockSwitchboardData({
        value: 2_650_500_000_000_000_000_000n,
        stdDev: 1_000_000_000_000_000_000n,
        slot: currentSlot,
      });
      setMockAccount(sbFeed.publicKey, SWITCHBOARD_PROGRAM_ID, mockSbData);

      const { assetPda } = await initAssetWithOracle({
        oracleSource: OracleSource.Switchboard,
        oracleFeed: toAddress(sbFeed.publicKey),
      });

      const asset = decodeAsset(getAccountData(svm, assetPda));
      expect(asset.oracleSource).toBe(OracleSource.Switchboard);
      expect(asset.oracleFeed).toBe(toAddress(sbFeed.publicKey));
    });

    it("initializes asset without oracle (manual pricing)", async () => {
      const collection = Keypair.generate();
      const [assetPda] = await getAssetPda(orgAddr, 0, PROGRAM_ID);
      const [collAuthPda] = await getCollectionAuthorityPda(
        toAddress(collection.publicKey),
        PROGRAM_ID,
      );

      sendTx(
        svm,
        [
          initAsset({
            config: configAddr,
            orgAccount: orgAddr,
            assetAccount: assetPda,
            collection: toAddress(collection.publicKey),
            collectionAuthority: collAuthPda,
            authority: toAddress(orgAuthority.publicKey),
            payer: toAddress(payer.publicKey),
            totalShares: 1_000_000n,
            pricePerShare: 1_000_000n,
            acceptedMint: toAddress(usdcMint),
            maturityDate: 0n,
            maturityGracePeriod: 0n,
            transferCooldown: 0n,
            maxHolders: 0,
            name: "ManualAsset",
            uri: "https://example.com/manual.json",
            programId: PROGRAM_ID,
          }),
        ],
        [payer, orgAuthority, collection],
      );

      const asset = decodeAsset(getAccountData(svm, assetPda));
      expect(asset.oracleSource).toBe(OracleSource.None);
      expect(asset.sharesPerUnit).toBe(0n);
    });

    it("rejects Pyth feed owned by wrong program", async () => {
      const fakeFeed = Keypair.generate();
      const currentSlot = svm.getClock().slot;
      const mockData = buildMockPythData({
        price: 265050n,
        conf: 100n,
        expo: -2,
        slot: currentSlot,
      });
      // Set account with wrong owner (system program instead of Pyth)
      setMockAccount(fakeFeed.publicKey, PublicKey.default, mockData);

      const collection = Keypair.generate();
      const [assetPda] = await getAssetPda(orgAddr, 0, PROGRAM_ID);
      const [collAuthPda] = await getCollectionAuthorityPda(
        toAddress(collection.publicKey),
        PROGRAM_ID,
      );

      sendTxExpectFail(
        svm,
        [
          initAsset({
            config: configAddr,
            orgAccount: orgAddr,
            assetAccount: assetPda,
            collection: toAddress(collection.publicKey),
            collectionAuthority: collAuthPda,
            authority: toAddress(orgAuthority.publicKey),
            payer: toAddress(payer.publicKey),
            totalShares: 1_000_000n,
            pricePerShare: 1_000_000n,
            acceptedMint: toAddress(usdcMint),
            maturityDate: 0n,
            maturityGracePeriod: 0n,
            transferCooldown: 0n,
            maxHolders: 0,
            oracleSource: OracleSource.Pyth,
            oracleMaxStaleness: 100,
            oracleMaxConfidenceBps: 0,
            acceptedMintDecimals: 6,
            sharesPerUnit: 1000n,
            oracleFeed: toAddress(fakeFeed.publicKey),
            name: "BadOracle",
            uri: "https://example.com/bad.json",
            programId: PROGRAM_ID,
          }),
        ],
        [payer, orgAuthority, collection],
      );
    });
  });

  describe("refreshOraclePrice", () => {
    it("refreshes price from Pyth oracle", async () => {
      const pythFeed = Keypair.generate();
      const currentSlot = svm.getClock().slot;

      // Gold at $2650.50 with expo=-2 → price=265050
      const mockPythData = buildMockPythData({
        price: 265050n,
        conf: 100n,
        expo: -2,
        slot: currentSlot,
      });
      setMockAccount(pythFeed.publicKey, PYTH_PROGRAM_ID, mockPythData);

      const { assetPda } = await initAssetWithOracle({
        oracleSource: OracleSource.Pyth,
        oracleFeed: toAddress(pythFeed.publicKey),
        sharesPerUnit: 1000n,
        acceptedMintDecimals: 6,
      });

      // Verify initial price
      let asset = decodeAsset(getAccountData(svm, assetPda));
      expect(asset.pricePerShare).toBe(1_000_000n); // Initial price from initAsset
      expect(asset.lastOracleUpdate).toBe(0n);

      // Set clock to a non-zero timestamp so lastOracleUpdate is meaningful
      const clock = svm.getClock();
      clock.unixTimestamp = 1_700_000_000n;
      svm.setClock(clock);

      // Refresh oracle price
      sendTx(
        svm,
        [
          refreshOraclePrice({
            assetAccount: assetPda,
            oracleFeed: toAddress(pythFeed.publicKey),
            programId: PROGRAM_ID,
          }),
        ],
        [payer],
      );

      // Verify price updated
      // Price = 265050 * 10^((-2) - (-6)) / 1000 = 265050 * 10^4 / 1000 = 2_650_500
      asset = decodeAsset(getAccountData(svm, assetPda));
      expect(asset.pricePerShare).toBe(2_650_500n);
      expect(asset.lastOracleUpdate).toBe(1_700_000_000n);
    });

    it("refreshes price from Switchboard oracle", async () => {
      const sbFeed = Keypair.generate();
      const currentSlot = svm.getClock().slot;

      // Gold at $2650.50, scaled by 10^18
      const mockSbData = buildMockSwitchboardData({
        value: 2_650_500_000_000_000_000_000n, // $2650.50 * 10^18
        stdDev: 1_000_000_000_000_000_000n,
        slot: currentSlot,
      });
      setMockAccount(sbFeed.publicKey, SWITCHBOARD_PROGRAM_ID, mockSbData);

      const { assetPda } = await initAssetWithOracle({
        oracleSource: OracleSource.Switchboard,
        oracleFeed: toAddress(sbFeed.publicKey),
        sharesPerUnit: 1000n,
        acceptedMintDecimals: 6,
      });

      sendTx(
        svm,
        [
          refreshOraclePrice({
            assetAccount: assetPda,
            oracleFeed: toAddress(sbFeed.publicKey),
            programId: PROGRAM_ID,
          }),
        ],
        [payer],
      );

      // Switchboard: value / 10^(18-6) / shares_per_unit
      // = 2_650_500_000_000_000_000_000 / 10^12 / 1000 = 2_650_500
      const asset = decodeAsset(getAccountData(svm, assetPda));
      expect(asset.pricePerShare).toBe(2_650_500n);
    });

    it("fails refresh when oracle is not configured", async () => {
      const collection = Keypair.generate();
      const [assetPda] = await getAssetPda(orgAddr, 0, PROGRAM_ID);
      const [collAuthPda] = await getCollectionAuthorityPda(
        toAddress(collection.publicKey),
        PROGRAM_ID,
      );

      // Init asset without oracle
      sendTx(
        svm,
        [
          initAsset({
            config: configAddr,
            orgAccount: orgAddr,
            assetAccount: assetPda,
            collection: toAddress(collection.publicKey),
            collectionAuthority: collAuthPda,
            authority: toAddress(orgAuthority.publicKey),
            payer: toAddress(payer.publicKey),
            totalShares: 1_000_000n,
            pricePerShare: 1_000_000n,
            acceptedMint: toAddress(usdcMint),
            maturityDate: 0n,
            maturityGracePeriod: 0n,
            transferCooldown: 0n,
            maxHolders: 0,
            name: "NoOracle",
            uri: "https://example.com/no-oracle.json",
            programId: PROGRAM_ID,
          }),
        ],
        [payer, orgAuthority, collection],
      );

      const dummyFeed = Keypair.generate();
      sendTxExpectFail(
        svm,
        [
          refreshOraclePrice({
            assetAccount: assetPda,
            oracleFeed: toAddress(dummyFeed.publicKey),
            programId: PROGRAM_ID,
          }),
        ],
        [payer],
      );
    });

    it("fails refresh when feed account mismatches", async () => {
      const pythFeed = Keypair.generate();
      const currentSlot = svm.getClock().slot;
      const mockPythData = buildMockPythData({
        price: 265050n,
        conf: 100n,
        expo: -2,
        slot: currentSlot,
      });
      setMockAccount(pythFeed.publicKey, PYTH_PROGRAM_ID, mockPythData);

      const { assetPda } = await initAssetWithOracle({
        oracleSource: OracleSource.Pyth,
        oracleFeed: toAddress(pythFeed.publicKey),
      });

      // Try to refresh with a different feed account
      const wrongFeed = Keypair.generate();
      sendTxExpectFail(
        svm,
        [
          refreshOraclePrice({
            assetAccount: assetPda,
            oracleFeed: toAddress(wrongFeed.publicKey),
            programId: PROGRAM_ID,
          }),
        ],
        [payer],
      );
    });
  });

  describe("configureOracle", () => {
    it("configures oracle on an existing asset", async () => {
      // First create asset without oracle
      const collection = Keypair.generate();
      const [assetPda] = await getAssetPda(orgAddr, 0, PROGRAM_ID);
      const [collAuthPda] = await getCollectionAuthorityPda(
        toAddress(collection.publicKey),
        PROGRAM_ID,
      );

      sendTx(
        svm,
        [
          initAsset({
            config: configAddr,
            orgAccount: orgAddr,
            assetAccount: assetPda,
            collection: toAddress(collection.publicKey),
            collectionAuthority: collAuthPda,
            authority: toAddress(orgAuthority.publicKey),
            payer: toAddress(payer.publicKey),
            totalShares: 1_000_000n,
            pricePerShare: 1_000_000n,
            acceptedMint: toAddress(usdcMint),
            maturityDate: 0n,
            maturityGracePeriod: 0n,
            transferCooldown: 0n,
            maxHolders: 0,
            name: "ConfigLater",
            uri: "https://example.com/config.json",
            programId: PROGRAM_ID,
          }),
        ],
        [payer, orgAuthority, collection],
      );

      let asset = decodeAsset(getAccountData(svm, assetPda));
      expect(asset.oracleSource).toBe(OracleSource.None);

      // Set up Pyth feed
      const pythFeed = Keypair.generate();
      const currentSlot = svm.getClock().slot;
      const mockPythData = buildMockPythData({
        price: 265050n,
        conf: 100n,
        expo: -2,
        slot: currentSlot,
      });
      setMockAccount(pythFeed.publicKey, PYTH_PROGRAM_ID, mockPythData);

      // Configure oracle
      sendTx(
        svm,
        [
          configureOracle({
            orgAccount: orgAddr,
            assetAccount: assetPda,
            oracleFeed: toAddress(pythFeed.publicKey),
            authority: toAddress(orgAuthority.publicKey),
            oracleSource: OracleSource.Pyth,
            oracleMaxStaleness: 200,
            oracleMaxConfidenceBps: 100,
            acceptedMintDecimals: 6,
            sharesPerUnit: 500n,
            programId: PROGRAM_ID,
          }),
        ],
        [orgAuthority],
      );

      asset = decodeAsset(getAccountData(svm, assetPda));
      expect(asset.oracleSource).toBe(OracleSource.Pyth);
      expect(asset.oracleFeed).toBe(toAddress(pythFeed.publicKey));
      expect(asset.sharesPerUnit).toBe(500n);
      expect(asset.oracleMaxStaleness).toBe(200);
      expect(asset.oracleMaxConfidenceBps).toBe(100);
      expect(asset.acceptedMintDecimals).toBe(6);
    });

    it("removes oracle from an asset", async () => {
      const pythFeed = Keypair.generate();
      const currentSlot = svm.getClock().slot;
      const mockPythData = buildMockPythData({
        price: 265050n,
        conf: 100n,
        expo: -2,
        slot: currentSlot,
      });
      setMockAccount(pythFeed.publicKey, PYTH_PROGRAM_ID, mockPythData);

      const { assetPda } = await initAssetWithOracle({
        oracleSource: OracleSource.Pyth,
        oracleFeed: toAddress(pythFeed.publicKey),
      });

      let asset = decodeAsset(getAccountData(svm, assetPda));
      expect(asset.oracleSource).toBe(OracleSource.Pyth);

      // Remove oracle (source = 0)
      // We still need to pass an account for oracle_feed slot in the accounts array
      sendTx(
        svm,
        [
          configureOracle({
            orgAccount: orgAddr,
            assetAccount: assetPda,
            oracleFeed: toAddress(pythFeed.publicKey),
            authority: toAddress(orgAuthority.publicKey),
            oracleSource: OracleSource.None,
            oracleMaxStaleness: 0,
            oracleMaxConfidenceBps: 0,
            acceptedMintDecimals: 0,
            sharesPerUnit: 0n,
            programId: PROGRAM_ID,
          }),
        ],
        [orgAuthority],
      );

      asset = decodeAsset(getAccountData(svm, assetPda));
      expect(asset.oracleSource).toBe(OracleSource.None);
    });

    it("rejects non-authority signer", async () => {
      const collection = Keypair.generate();
      const [assetPda] = await getAssetPda(orgAddr, 0, PROGRAM_ID);
      const [collAuthPda] = await getCollectionAuthorityPda(
        toAddress(collection.publicKey),
        PROGRAM_ID,
      );

      sendTx(
        svm,
        [
          initAsset({
            config: configAddr,
            orgAccount: orgAddr,
            assetAccount: assetPda,
            collection: toAddress(collection.publicKey),
            collectionAuthority: collAuthPda,
            authority: toAddress(orgAuthority.publicKey),
            payer: toAddress(payer.publicKey),
            totalShares: 1_000_000n,
            pricePerShare: 1_000_000n,
            acceptedMint: toAddress(usdcMint),
            maturityDate: 0n,
            maturityGracePeriod: 0n,
            transferCooldown: 0n,
            maxHolders: 0,
            name: "AuthTest",
            uri: "https://example.com/auth.json",
            programId: PROGRAM_ID,
          }),
        ],
        [payer, orgAuthority, collection],
      );

      const pythFeed = Keypair.generate();
      const currentSlot = svm.getClock().slot;
      const mockPythData = buildMockPythData({
        price: 265050n,
        conf: 100n,
        expo: -2,
        slot: currentSlot,
      });
      setMockAccount(pythFeed.publicKey, PYTH_PROGRAM_ID, mockPythData);

      // Try with wrong authority
      const wrongAuth = Keypair.generate();
      svm.airdrop(wrongAuth.publicKey, BigInt(1_000_000_000));

      sendTxExpectFail(
        svm,
        [
          configureOracle({
            orgAccount: orgAddr,
            assetAccount: assetPda,
            oracleFeed: toAddress(pythFeed.publicKey),
            authority: toAddress(wrongAuth.publicKey),
            oracleSource: OracleSource.Pyth,
            oracleMaxStaleness: 100,
            oracleMaxConfidenceBps: 0,
            acceptedMintDecimals: 6,
            sharesPerUnit: 1000n,
            programId: PROGRAM_ID,
          }),
        ],
        [wrongAuth],
      );
    });
  });
});
