import { describe, it, expect, beforeEach } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { type LiteSVM } from "litesvm";
import { address, type Address } from "gill";
import {
  createTestSvm,
  sendTx,
  getAccountData,
  toAddress,
  createUsdcMint,
} from "../helpers/setup.js";
import { decodeOrganization } from "../../src/accounts/organization.js";
import { decodeAsset } from "../../src/accounts/asset.js";
import { decodeAssetToken } from "../../src/accounts/assetToken.js";
import { decodeCollectionV1, decodeAssetV1 } from "../../src/external/mpl-core/accounts.js";
import { PluginType } from "../../src/external/mpl-core/constants.js";
import { initializeProtocol } from "../../src/instructions/protocol.js";
import {
  registerOrganization,
  updateOrgAddMint,
} from "../../src/instructions/organization.js";
import { initAsset, mintToken, updateMetadata } from "../../src/instructions/asset.js";
import { createRound } from "../../src/instructions/fundraising.js";
import {
  getProtocolConfigPda,
  getOrganizationPda,
  getAssetPda,
  getAssetTokenPda,
  getCollectionAuthorityPda,
  getFundraisingRoundPda,
  getEscrowPda,
} from "../../src/pdas.js";
import { AccountKey, AssetStatus } from "../../src/constants.js";
import { MplCoreKey } from "../../src/external/mpl-core/constants.js";

// ── Constants ────────────────────────────────────────────────────────

const PROGRAM_ID = address("FNDZziaztYptbydC5UpLEaLMyFN4rDmP3G2MN7o6w4ZK");
const PROGRAM_PK = new PublicKey("FNDZziaztYptbydC5UpLEaLMyFN4rDmP3G2MN7o6w4ZK");

// ── Test Suite ───────────────────────────────────────────────────────

describe("Asset Integration", () => {
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

  it("initializes an asset with USDC", async () => {
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
          name: "TestAsset",
          uri: "https://example.com/asset.json",
          programId: PROGRAM_ID,
        }),
      ],
      [payer, orgAuthority, collection],
    );

    // Verify Asset account
    const asset = decodeAsset(getAccountData(svm, assetPda));
    expect(asset.accountKey).toBe(AccountKey.Asset);
    expect(asset.id).toBe(0);
    expect(asset.organization).toBe(orgAddr);
    expect(asset.collection).toBe(toAddress(collection.publicKey));
    expect(asset.totalShares).toBe(1_000_000n);
    expect(asset.mintedShares).toBe(0n);
    expect(asset.status).toBe(AssetStatus.Draft);
    expect(asset.pricePerShare).toBe(1_000_000n);
    expect(asset.acceptedMint).toBe(toAddress(usdcMint));

    // Verify Collection created via MPL Core CPI
    const collData = getAccountData(svm, toAddress(collection.publicKey));
    expect(collData[0]).toBe(MplCoreKey.CollectionV1);

    // Verify org assetCount incremented
    const org = decodeOrganization(getAccountData(svm, orgAddr));
    expect(org.assetCount).toBe(1);
  });

  it("mints a token (NFT + AssetToken)", async () => {
    const collection = Keypair.generate();
    const [assetPda] = await getAssetPda(orgAddr, 0, PROGRAM_ID);
    const [collAuthPda] = await getCollectionAuthorityPda(
      toAddress(collection.publicKey),
      PROGRAM_ID,
    );

    // Init asset
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
          name: "TestAsset",
          uri: "https://example.com/asset.json",
          programId: PROGRAM_ID,
        }),
      ],
      [payer, orgAuthority, collection],
    );

    // Create fundraising round to transition asset from Draft → Fundraising
    const [roundPda] = await getFundraisingRoundPda(assetPda, 0, PROGRAM_ID);
    const [escrowPda] = await getEscrowPda(roundPda, PROGRAM_ID);

    sendTx(
      svm,
      [
        createRound({
          config: configAddr,
          orgAccount: orgAddr,
          assetAccount: assetPda,
          roundAccount: roundPda,
          escrow: escrowPda,
          acceptedMint: toAddress(usdcMint),
          authority: toAddress(orgAuthority.publicKey),
          payer: toAddress(payer.publicKey),
          sharesOffered: 500_000n,
          pricePerShare: 1_000_000n,
          minRaise: 1_000_000n,
          maxRaise: 500_000_000_000n,
          minPerWallet: 1n,
          maxPerWallet: 500_000n,
          startTime: 0n,
          endTime: 9_999_999_999n,
          lockupEnd: 0n,
          termsHash: new Uint8Array(32),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, orgAuthority],
    );

    // Mint token
    const nft = Keypair.generate();
    const recipient = Keypair.generate();
    const [assetTokenPda] = await getAssetTokenPda(assetPda, 0, PROGRAM_ID);

    sendTx(
      svm,
      [
        mintToken({
          config: configAddr,
          orgAccount: orgAddr,
          assetAccount: assetPda,
          assetTokenAccount: assetTokenPda,
          collection: toAddress(collection.publicKey),
          collectionAuthority: collAuthPda,
          nft: toAddress(nft.publicKey),
          recipient: toAddress(recipient.publicKey),
          authority: toAddress(orgAuthority.publicKey),
          payer: toAddress(payer.publicKey),
          shares: 100_000n,
          programId: PROGRAM_ID,
        }),
      ],
      [payer, orgAuthority, nft],
    );

    // Verify AssetToken
    const token = decodeAssetToken(getAccountData(svm, assetTokenPda));
    expect(token.accountKey).toBe(AccountKey.AssetToken);
    expect(token.asset).toBe(assetPda);
    expect(token.nft).toBe(toAddress(nft.publicKey));
    expect(token.owner).toBe(toAddress(recipient.publicKey));
    expect(token.shares).toBe(100_000n);
    expect(token.tokenIndex).toBe(0);

    // Verify Asset mintedShares updated
    const asset = decodeAsset(getAccountData(svm, assetPda));
    expect(asset.mintedShares).toBe(100_000n);

    // Verify NFT created via MPL Core CPI
    const nftAcct = svm.getAccount(nft.publicKey);
    expect(nftAcct).not.toBeNull();
    expect(nftAcct!.data[0]).toBe(MplCoreKey.AssetV1);

    // Decode full NFT including plugins
    const nftAsset = decodeAssetV1(nftAcct!.data);
    expect(nftAsset.owner).toBe(toAddress(recipient.publicKey));
    expect(nftAsset.name).toBe("TestAsset #1");

    // Verify PermanentFreezeDelegate plugin (frozen = true)
    const freezePlugin = nftAsset.plugins.find(
      (p) => p.type === PluginType.PermanentFreezeDelegate,
    );
    expect(freezePlugin).toBeDefined();
    expect(freezePlugin!.type).toBe(PluginType.PermanentFreezeDelegate);
    expect((freezePlugin as { frozen: boolean }).frozen).toBe(true);

    // Verify BurnDelegate plugin exists
    const burnPlugin = nftAsset.plugins.find(
      (p) => p.type === PluginType.BurnDelegate,
    );
    expect(burnPlugin).toBeDefined();

    // Verify TransferDelegate plugin exists
    const transferPlugin = nftAsset.plugins.find(
      (p) => p.type === PluginType.TransferDelegate,
    );
    expect(transferPlugin).toBeDefined();

    // Verify Attributes plugin with shares, asset_id, status
    const attrsPlugin = nftAsset.plugins.find(
      (p) => p.type === PluginType.Attributes,
    );
    expect(attrsPlugin).toBeDefined();
    const attrs = (attrsPlugin as { attributes: { key: string; value: string }[] }).attributes;

    const sharesAttr = attrs.find((a) => a.key === "shares");
    expect(sharesAttr).toBeDefined();
    expect(sharesAttr!.value).toBe("100000");

    const assetIdAttr = attrs.find((a) => a.key === "asset_id");
    expect(assetIdAttr).toBeDefined();
    expect(assetIdAttr!.value).toBe("0");

    const statusAttr = attrs.find((a) => a.key === "status");
    expect(statusAttr).toBeDefined();
    expect(statusAttr!.value).toBe("active");
  });

  it("updates asset metadata", async () => {
    const collection = Keypair.generate();
    const [assetPda] = await getAssetPda(orgAddr, 0, PROGRAM_ID);
    const [collAuthPda] = await getCollectionAuthorityPda(
      toAddress(collection.publicKey),
      PROGRAM_ID,
    );

    // Init asset
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
          name: "OldName",
          uri: "https://example.com/old.json",
          programId: PROGRAM_ID,
        }),
      ],
      [payer, orgAuthority, collection],
    );

    // Update metadata
    sendTx(
      svm,
      [
        updateMetadata({
          config: configAddr,
          orgAccount: orgAddr,
          assetAccount: assetPda,
          collection: toAddress(collection.publicKey),
          collectionAuthority: collAuthPda,
          authority: toAddress(orgAuthority.publicKey),
          payer: toAddress(payer.publicKey),
          orgId: 0,
          assetId: 0,
          newName: "NewName",
          newUri: "https://example.com/new.json",
          programId: PROGRAM_ID,
        }),
      ],
      [payer, orgAuthority],
    );

    // Verify the collection was updated
    const collData = getAccountData(svm, toAddress(collection.publicKey));
    // Decode as p-core fixed layout (282 bytes) since tokenizer writes in that format
    const coll = decodeCollectionV1(collData);
    expect(coll.name).toBe("NewName");
    expect(coll.uri).toBe("https://example.com/new.json");
  });
});
