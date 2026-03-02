import { describe, it, expect, beforeEach } from "vitest";
import {
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { type LiteSVM, type FailedTransactionMetadata } from "litesvm";
import { address, type Address } from "gill";
import {
  createTestSvm,
  sendTx,
  sendTxExpectFail,
  getAccountData,
  getTokenBalance,
  toAddress,
  createUsdcMint,
  createTokenAccount,
  mintTokensTo,
  TOKEN_PROGRAM_ID,
  ATA_PROGRAM_ID,
  SPL_TOKEN_ACCOUNT_LEN,
} from "../helpers/setup.js";
import { decodeAsset } from "../../src/accounts/asset.js";
import { decodeBuyoutOffer } from "../../src/accounts/buyoutOffer.js";
import { initializeProtocol } from "../../src/instructions/protocol.js";
import {
  registerOrganization,
  updateOrgAddMint,
} from "../../src/instructions/organization.js";
import { initAsset } from "../../src/instructions/asset.js";
import {
  createRound,
  invest,
  finalizeRound,
  mintRoundTokens,
} from "../../src/instructions/fundraising.js";
import { listForSale } from "../../src/instructions/market.js";
import {
  createBuyoutOffer,
  fundBuyoutOffer,
  cancelBuyout,
} from "../../src/instructions/buyout.js";
import {
  getProtocolConfigPda,
  getOrganizationPda,
  getAssetPda,
  getAssetTokenPda,
  getCollectionAuthorityPda,
  getFundraisingRoundPda,
  getEscrowPda,
  getInvestmentPda,
  getBuyoutOfferPda,
  getBuyoutEscrowPda,
  getListingPda,
} from "../../src/pdas.js";
import { makeOffer } from "../../src/instructions/market.js";
import { mintToken } from "../../src/instructions/asset.js";
import { AccountKey, AssetStatus, BuyoutStatus } from "../../src/constants.js";
import {
  getOfferPda,
  getOfferEscrowPda,
} from "../../src/pdas.js";

// ── Constants ────────────────────────────────────────────────────────

const PROGRAM_ID = address("FNDZziaztYptbydC5UpLEaLMyFN4rDmP3G2MN7o6w4ZK");
const PROGRAM_PK = new PublicKey("FNDZziaztYptbydC5UpLEaLMyFN4rDmP3G2MN7o6w4ZK");

/** Creates a token account at a specific keypair's address. */
function createTokenAccountAtAddress(
  svm: LiteSVM,
  mint: PublicKey,
  owner: PublicKey,
  accountKp: Keypair,
  payerKp: Keypair,
): PublicKey {
  const rentExempt = svm.minimumBalanceForRentExemption(BigInt(SPL_TOKEN_ACCOUNT_LEN));
  const initData = Buffer.alloc(1);
  initData.writeUInt8(1, 0); // InitializeAccount

  const tx = new Transaction();
  tx.add(
    SystemProgram.createAccount({
      fromPubkey: payerKp.publicKey,
      newAccountPubkey: accountKp.publicKey,
      lamports: Number(rentExempt),
      space: SPL_TOKEN_ACCOUNT_LEN,
      programId: TOKEN_PROGRAM_ID,
    }),
  );
  tx.add(
    new TransactionInstruction({
      keys: [
        { pubkey: accountKp.publicKey, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: owner, isSigner: false, isWritable: false },
        {
          pubkey: new PublicKey("SysvarRent111111111111111111111111111111111"),
          isSigner: false,
          isWritable: false,
        },
      ],
      programId: TOKEN_PROGRAM_ID,
      data: initData,
    }),
  );

  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = payerKp.publicKey;
  tx.sign(payerKp, accountKp);

  const result = svm.sendTransaction(tx);
  if ("err" in result && typeof (result as FailedTransactionMetadata).err === "function") {
    throw new Error(
      `createTokenAccountAtAddress failed: ${(result as FailedTransactionMetadata).meta().prettyLogs()}`,
    );
  }
  return accountKp.publicKey;
}

/**
 * Patches the asset account's native_treasury field (offset 162, 32 bytes)
 * to enable buyout testing without full governance setup.
 */
function patchAssetNativeTreasury(
  svm: LiteSVM,
  assetPk: PublicKey,
  nativeTreasury: PublicKey,
): void {
  const acct = svm.getAccount(assetPk)!;
  const data = new Uint8Array(acct.data);
  data.set(nativeTreasury.toBytes(), 162);
  svm.setAccount(assetPk, { ...acct, data });
}

/**
 * Patches the asset account's status field (offset 88, u8).
 */
function patchAssetStatus(
  svm: LiteSVM,
  assetPk: PublicKey,
  status: number,
): void {
  const acct = svm.getAccount(assetPk)!;
  const data = new Uint8Array(acct.data);
  data[88] = status;
  svm.setAccount(assetPk, { ...acct, data });
}

/**
 * Patches the asset account's active_buyout field (offset 194, 32 bytes).
 */
function patchAssetActiveBuyout(
  svm: LiteSVM,
  assetPk: PublicKey,
  buyoutKey: PublicKey,
): void {
  const acct = svm.getAccount(assetPk)!;
  const data = new Uint8Array(acct.data);
  data.set(buyoutKey.toBytes(), 194);
  svm.setAccount(assetPk, { ...acct, data });
}

/**
 * Patches the asset account's unminted_succeeded_rounds field (offset 228, u32 LE).
 */
function patchAssetUnmintedRounds(
  svm: LiteSVM,
  assetPk: PublicKey,
  count: number,
): void {
  const acct = svm.getAccount(assetPk)!;
  const data = new Uint8Array(acct.data);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  dv.setUint32(228, count, true);
  svm.setAccount(assetPk, { ...acct, data });
}

// ── Test Suite ───────────────────────────────────────────────────────

describe("Buyout Integration", () => {
  let svm: LiteSVM;
  let operator: Keypair;
  let payer: Keypair;
  let orgAuthority: Keypair;
  let mintAuthority: Keypair;
  let feeTreasury: Keypair;
  let usdcMint: PublicKey;
  let configAddr: Address;
  let orgAddr: Address;
  let assetAddr: Address;
  let collectionKp: Keypair;
  let collAuthAddr: Address;

  // Investor who holds a minted token after fundraising
  let investor: Keypair;
  let assetTokenAddr: Address;
  let nftKp: Keypair;

  beforeEach(async () => {
    svm = createTestSvm({ programId: PROGRAM_PK, loadMplCore: true });

    operator = Keypair.generate();
    payer = Keypair.generate();
    orgAuthority = Keypair.generate();
    mintAuthority = Keypair.generate();
    feeTreasury = Keypair.generate();

    svm.airdrop(operator.publicKey, BigInt(10_000_000_000));
    svm.airdrop(payer.publicKey, BigInt(10_000_000_000));
    svm.airdrop(orgAuthority.publicKey, BigInt(10_000_000_000));

    usdcMint = createUsdcMint(svm, mintAuthority);

    // Fee treasury token account
    createTokenAccountAtAddress(svm, usdcMint, payer.publicKey, feeTreasury, payer);

    const [configPda] = await getProtocolConfigPda(PROGRAM_ID);
    configAddr = configPda;

    sendTx(
      svm,
      [
        initializeProtocol({
          config: configAddr,
          operator: toAddress(operator.publicKey),
          payer: toAddress(payer.publicKey),
          feeBps: 100,
          feeTreasury: toAddress(feeTreasury.publicKey),
          acceptedMint: toAddress(usdcMint),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, operator],
    );

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

    collectionKp = Keypair.generate();
    const [assetPda] = await getAssetPda(orgAddr, 0, PROGRAM_ID);
    assetAddr = assetPda;
    const [collAuthPda] = await getCollectionAuthorityPda(
      toAddress(collectionKp.publicKey),
      PROGRAM_ID,
    );
    collAuthAddr = collAuthPda;

    sendTx(
      svm,
      [
        initAsset({
          config: configAddr,
          orgAccount: orgAddr,
          assetAccount: assetAddr,
          collection: toAddress(collectionKp.publicKey),
          collectionAuthority: collAuthAddr,
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
      [payer, orgAuthority, collectionKp],
    );

    // ── Fundraising flow to get an Active asset with a minted token ──

    const [roundPda] = await getFundraisingRoundPda(assetAddr, 0, PROGRAM_ID);
    const [escrowPda] = await getEscrowPda(roundPda, PROGRAM_ID);
    const END_TIME = 1_000_000n;

    sendTx(
      svm,
      [
        createRound({
          config: configAddr,
          orgAccount: orgAddr,
          assetAccount: assetAddr,
          roundAccount: roundPda,
          escrow: escrowPda,
          acceptedMint: toAddress(usdcMint),
          authority: toAddress(orgAuthority.publicKey),
          payer: toAddress(payer.publicKey),
          sharesOffered: 500_000n,
          pricePerShare: 1_000_000n,
          minRaise: 100_000_000n,
          maxRaise: 500_000_000_000n,
          minPerWallet: 1_000_000n,
          maxPerWallet: 250_000_000_000n,
          startTime: 0n,
          endTime: END_TIME,
          lockupEnd: 0n,
          termsHash: new Uint8Array(32),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, orgAuthority],
    );

    investor = Keypair.generate();
    svm.airdrop(investor.publicKey, BigInt(10_000_000_000));
    const investorToken = createTokenAccount(svm, usdcMint, investor.publicKey, payer);
    mintTokensTo(svm, usdcMint, investorToken, 200_000_000n, mintAuthority);
    const [invPda] = await getInvestmentPda(roundPda, toAddress(investor.publicKey), PROGRAM_ID);

    sendTx(
      svm,
      [
        invest({
          config: configAddr,
          roundAccount: roundPda,
          investmentAccount: invPda,
          escrow: escrowPda,
          investorTokenAccount: toAddress(investorToken),
          investor: toAddress(investor.publicKey),
          payer: toAddress(payer.publicKey),
          shares: 100n,
          termsHash: new Uint8Array(32),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, investor],
    );

    // Warp past end, finalize
    const clock = svm.getClock();
    clock.unixTimestamp = END_TIME + 1n;
    svm.setClock(clock);

    const orgTreasuryAta = PublicKey.findProgramAddressSync(
      [orgAuthority.publicKey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), usdcMint.toBuffer()],
      ATA_PROGRAM_ID,
    )[0];

    sendTx(
      svm,
      [
        finalizeRound({
          config: configAddr,
          assetAccount: assetAddr,
          roundAccount: roundPda,
          escrow: escrowPda,
          feeTreasuryToken: toAddress(feeTreasury.publicKey),
          orgTreasuryToken: toAddress(orgTreasuryAta),
          treasuryWallet: toAddress(orgAuthority.publicKey),
          payer: toAddress(payer.publicKey),
          acceptedMint: toAddress(usdcMint),
          ataProgram: toAddress(ATA_PROGRAM_ID),
          programId: PROGRAM_ID,
        }),
      ],
      [payer],
    );

    // Mint token
    nftKp = Keypair.generate();
    const [atPda] = await getAssetTokenPda(assetAddr, 0, PROGRAM_ID);
    assetTokenAddr = atPda;

    sendTx(
      svm,
      [
        mintRoundTokens({
          roundAccount: roundPda,
          assetAccount: assetAddr,
          collection: toAddress(collectionKp.publicKey),
          collectionAuthority: collAuthAddr,
          payer: toAddress(payer.publicKey),
          investors: [
            {
              investmentAccount: invPda,
              assetTokenAccount: assetTokenAddr,
              nft: toAddress(nftKp.publicKey),
              investor: toAddress(investor.publicKey),
            },
          ],
          programId: PROGRAM_ID,
        }),
      ],
      [payer, nftKp],
    );

    // Verify asset is Active
    const asset = decodeAsset(getAccountData(svm, assetAddr));
    expect(asset.status).toBe(AssetStatus.Active);

    // Patch native_treasury so buyout sees governance as set up
    const fakeTreasury = Keypair.generate().publicKey;
    patchAssetNativeTreasury(svm, new PublicKey(assetAddr), fakeTreasury);
  });

  // ── Helpers ──────────────────────────────────────────────────────

  async function createOffer(buyer: Keypair, pricePerShare = 1_200_000n, expiry = 10_000_000n) {
    const [offerPda] = await getBuyoutOfferPda(
      assetAddr,
      toAddress(buyer.publicKey),
      PROGRAM_ID,
    );

    sendTx(
      svm,
      [
        createBuyoutOffer({
          config: configAddr,
          org: orgAddr,
          asset: assetAddr,
          buyoutOffer: offerPda,
          acceptedMint: toAddress(usdcMint),
          buyer: toAddress(buyer.publicKey),
          payer: toAddress(payer.publicKey),
          pricePerShare,
          isCouncilBuyout: false,
          treasuryDisposition: 0,
          broker: toAddress(PublicKey.default),
          brokerBps: 0,
          termsHash: new Uint8Array(32),
          expiry,
          programId: PROGRAM_ID,
        }),
      ],
      [payer, buyer],
    );

    return offerPda;
  }

  // ── Tests ────────────────────────────────────────────────────────

  it("creates external buyout offer", async () => {
    const buyer = Keypair.generate();
    svm.airdrop(buyer.publicKey, BigInt(10_000_000_000));

    const offerPda = await createOffer(buyer);

    const offer = decodeBuyoutOffer(getAccountData(svm, offerPda));
    expect(offer.accountKey).toBe(AccountKey.BuyoutOffer);
    expect(offer.version).toBe(1);
    expect(offer.buyer).toBe(toAddress(buyer.publicKey));
    expect(offer.asset).toBe(assetAddr);
    expect(offer.pricePerShare).toBe(1_200_000n);
    expect(offer.acceptedMint).toBe(toAddress(usdcMint));
    expect(offer.status).toBe(BuyoutStatus.Pending);
    expect(offer.isCouncilBuyout).toBe(false);
    expect(offer.mintedShares).toBe(100n);

    // Verify asset.active_buyout is set
    const asset = decodeAsset(getAccountData(svm, assetAddr));
    expect(asset.activeBuyout).toBe(offerPda);
  });

  it("funds buyout offer", async () => {
    const buyer = Keypair.generate();
    svm.airdrop(buyer.publicKey, BigInt(10_000_000_000));

    const offerPda = await createOffer(buyer);

    // Fund the buyer with USDC: minted_shares(100) * price(1_200_000) = 120_000_000
    const buyerUsdcAcct = createTokenAccount(svm, usdcMint, buyer.publicKey, payer);
    mintTokensTo(svm, usdcMint, buyerUsdcAcct, 120_000_000n, mintAuthority);

    const [escrowPda] = await getBuyoutEscrowPda(offerPda, PROGRAM_ID);

    sendTx(
      svm,
      [
        fundBuyoutOffer({
          buyoutOffer: offerPda,
          asset: assetAddr,
          escrow: escrowPda,
          buyerTokenAcc: toAddress(buyerUsdcAcct),
          acceptedMint: toAddress(usdcMint),
          buyer: toAddress(buyer.publicKey),
          payer: toAddress(payer.publicKey),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, buyer],
    );

    // Verify status → Funded
    const offer = decodeBuyoutOffer(getAccountData(svm, offerPda));
    expect(offer.status).toBe(BuyoutStatus.Funded);
    expect(offer.escrow).toBe(escrowPda);

    // Verify escrow has the tokens
    const escrowBalance = getTokenBalance(svm, new PublicKey(escrowPda));
    expect(escrowBalance).toBe(120_000_000n);

    // Verify buyer token account drained
    const buyerBalance = getTokenBalance(svm, buyerUsdcAcct);
    expect(buyerBalance).toBe(0n);
  });

  it("cancel buyout refunds escrow", async () => {
    const buyer = Keypair.generate();
    svm.airdrop(buyer.publicKey, BigInt(10_000_000_000));

    const offerPda = await createOffer(buyer);

    // Fund it
    const buyerUsdcAcct = createTokenAccount(svm, usdcMint, buyer.publicKey, payer);
    mintTokensTo(svm, usdcMint, buyerUsdcAcct, 120_000_000n, mintAuthority);
    const [escrowPda] = await getBuyoutEscrowPda(offerPda, PROGRAM_ID);

    sendTx(
      svm,
      [
        fundBuyoutOffer({
          buyoutOffer: offerPda,
          asset: assetAddr,
          escrow: escrowPda,
          buyerTokenAcc: toAddress(buyerUsdcAcct),
          acceptedMint: toAddress(usdcMint),
          buyer: toAddress(buyer.publicKey),
          payer: toAddress(payer.publicKey),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, buyer],
    );

    // Verify funded
    expect(getTokenBalance(svm, buyerUsdcAcct)).toBe(0n);

    // Cancel — buyer voluntary
    sendTx(
      svm,
      [
        cancelBuyout({
          buyoutOffer: offerPda,
          asset: assetAddr,
          buyer: toAddress(buyer.publicKey),
          escrow: escrowPda,
          buyerTokenAcc: toAddress(buyerUsdcAcct),
          tokenProgram: toAddress(TOKEN_PROGRAM_ID),
          programId: PROGRAM_ID,
        }),
      ],
      [buyer],
    );

    // Verify refund: buyer got tokens back
    const buyerBalance = getTokenBalance(svm, buyerUsdcAcct);
    expect(buyerBalance).toBe(120_000_000n);

    // Verify offer account closed (data length 0 or account gone)
    const offerAcct = svm.getAccount(new PublicKey(offerPda));
    expect(offerAcct === null || offerAcct.data.length === 0).toBe(true);

    // Verify asset.active_buyout cleared
    const asset = decodeAsset(getAccountData(svm, assetAddr));
    expect(asset.activeBuyout).toBe(toAddress(PublicKey.default));
  });

  it("cancel expired buyout permissionlessly", async () => {
    const buyer = Keypair.generate();
    svm.airdrop(buyer.publicKey, BigInt(10_000_000_000));

    // Create offer with short expiry
    const EXPIRY = 2_000_000n;
    const offerPda = await createOffer(buyer, 1_200_000n, EXPIRY);

    // Warp past expiry
    const clock = svm.getClock();
    clock.unixTimestamp = EXPIRY + 1n;
    svm.setClock(clock);

    // Cancel permissionlessly — anyone can cancel (Pending offer, no escrow to refund)
    const anyone = Keypair.generate();
    svm.airdrop(anyone.publicKey, BigInt(10_000_000_000));

    sendTx(
      svm,
      [
        cancelBuyout({
          buyoutOffer: offerPda,
          asset: assetAddr,
          buyer: toAddress(buyer.publicKey),
          permissionless: true, // Expired — buyer doesn't need to sign
          programId: PROGRAM_ID,
        }),
      ],
      [anyone], // Anyone can be the fee payer
    );

    // Verify offer closed
    const offerAcct = svm.getAccount(new PublicKey(offerPda));
    expect(offerAcct === null || offerAcct.data.length === 0).toBe(true);

    // Verify asset.active_buyout cleared
    const asset = decodeAsset(getAccountData(svm, assetAddr));
    expect(asset.activeBuyout).toBe(toAddress(PublicKey.default));
  });

  it("rejects buyout with price below floor", async () => {
    const buyer = Keypair.generate();
    svm.airdrop(buyer.publicKey, BigInt(10_000_000_000));

    // Asset price_per_share = 1_000_000. Min buyout price = 1_100_000 (110%).
    // Try with 1_000_000 (100%) — should fail.
    const [offerPda] = await getBuyoutOfferPda(
      assetAddr,
      toAddress(buyer.publicKey),
      PROGRAM_ID,
    );

    sendTxExpectFail(
      svm,
      [
        createBuyoutOffer({
          config: configAddr,
          org: orgAddr,
          asset: assetAddr,
          buyoutOffer: offerPda,
          acceptedMint: toAddress(usdcMint),
          buyer: toAddress(buyer.publicKey),
          payer: toAddress(payer.publicKey),
          pricePerShare: 1_000_000n, // = asset price, below 110% floor
          isCouncilBuyout: false,
          treasuryDisposition: 0,
          broker: toAddress(PublicKey.default),
          brokerBps: 0,
          termsHash: new Uint8Array(32),
          expiry: 10_000_000n,
          programId: PROGRAM_ID,
        }),
      ],
      [payer, buyer],
    );
  });

  it("rejects buyout when unminted succeeded rounds exist", async () => {
    const buyer = Keypair.generate();
    svm.airdrop(buyer.publicKey, BigInt(10_000_000_000));

    // Patch asset to have unminted succeeded rounds
    patchAssetUnmintedRounds(svm, new PublicKey(assetAddr), 1);

    const [offerPda] = await getBuyoutOfferPda(
      assetAddr,
      toAddress(buyer.publicKey),
      PROGRAM_ID,
    );

    sendTxExpectFail(
      svm,
      [
        createBuyoutOffer({
          config: configAddr,
          org: orgAddr,
          asset: assetAddr,
          buyoutOffer: offerPda,
          acceptedMint: toAddress(usdcMint),
          buyer: toAddress(buyer.publicKey),
          payer: toAddress(payer.publicKey),
          pricePerShare: 1_200_000n,
          isCouncilBuyout: false,
          treasuryDisposition: 0,
          broker: toAddress(PublicKey.default),
          brokerBps: 0,
          termsHash: new Uint8Array(32),
          expiry: 10_000_000n,
          programId: PROGRAM_ID,
        }),
      ],
      [payer, buyer],
    );

    // Restore to 0 for other tests
    patchAssetUnmintedRounds(svm, new PublicKey(assetAddr), 0);
  });

  it("blocks listing during active buyout", async () => {
    const buyer = Keypair.generate();
    svm.airdrop(buyer.publicKey, BigInt(10_000_000_000));

    // Create buyout offer (sets asset.active_buyout)
    await createOffer(buyer);

    // Try to list the investor's token — should fail with BuyoutActiveBuyoutExists
    const [listingPda] = await getListingPda(assetTokenAddr, PROGRAM_ID);

    sendTxExpectFail(
      svm,
      [
        listForSale({
          config: configAddr,
          assetAccount: assetAddr,
          assetTokenAccount: assetTokenAddr,
          listingAccount: listingPda,
          seller: toAddress(investor.publicKey),
          payer: toAddress(payer.publicKey),
          sharesForSale: 50n,
          pricePerShare: 2_000_000n,
          isPartial: false,
          expiry: 10_000_000n,
          programId: PROGRAM_ID,
        }),
      ],
      [payer, investor],
    );
  });

  it("blocks create_round during active buyout", async () => {
    const buyer = Keypair.generate();
    svm.airdrop(buyer.publicKey, BigInt(10_000_000_000));

    // Create buyout offer (sets asset.active_buyout)
    await createOffer(buyer);

    // Try to create a new fundraising round — should fail
    const [roundPda] = await getFundraisingRoundPda(assetAddr, 1, PROGRAM_ID);
    const [escrowPda] = await getEscrowPda(roundPda, PROGRAM_ID);

    sendTxExpectFail(
      svm,
      [
        createRound({
          config: configAddr,
          orgAccount: orgAddr,
          assetAccount: assetAddr,
          roundAccount: roundPda,
          escrow: escrowPda,
          acceptedMint: toAddress(usdcMint),
          authority: toAddress(orgAuthority.publicKey),
          payer: toAddress(payer.publicKey),
          sharesOffered: 100_000n,
          pricePerShare: 1_000_000n,
          minRaise: 50_000_000n,
          maxRaise: 500_000_000_000n,
          minPerWallet: 1_000_000n,
          maxPerWallet: 250_000_000_000n,
          startTime: 0n,
          endTime: 5_000_000n,
          lockupEnd: 0n,
          termsHash: new Uint8Array(32),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, orgAuthority],
    );
  });

  // ── Failure: create_buyout_offer validations ──────────────────────

  it("rejects buyout on non-Active asset", async () => {
    const buyer = Keypair.generate();
    svm.airdrop(buyer.publicKey, BigInt(10_000_000_000));

    // Patch asset status to Pending (0) — not Active
    patchAssetStatus(svm, new PublicKey(assetAddr), 0);

    const [offerPda] = await getBuyoutOfferPda(
      assetAddr,
      toAddress(buyer.publicKey),
      PROGRAM_ID,
    );

    sendTxExpectFail(
      svm,
      [
        createBuyoutOffer({
          config: configAddr,
          org: orgAddr,
          asset: assetAddr,
          buyoutOffer: offerPda,
          acceptedMint: toAddress(usdcMint),
          buyer: toAddress(buyer.publicKey),
          payer: toAddress(payer.publicKey),
          pricePerShare: 1_200_000n,
          isCouncilBuyout: false,
          treasuryDisposition: 0,
          broker: toAddress(PublicKey.default),
          brokerBps: 0,
          termsHash: new Uint8Array(32),
          expiry: 10_000_000n,
          programId: PROGRAM_ID,
        }),
      ],
      [payer, buyer],
    );

    // Restore Active status for other tests
    patchAssetStatus(svm, new PublicKey(assetAddr), AssetStatus.Active);
  });

  it("rejects buyout without governance", async () => {
    const buyer = Keypair.generate();
    svm.airdrop(buyer.publicKey, BigInt(10_000_000_000));

    // Clear native_treasury (zero = no governance)
    patchAssetNativeTreasury(svm, new PublicKey(assetAddr), PublicKey.default);

    const [offerPda] = await getBuyoutOfferPda(
      assetAddr,
      toAddress(buyer.publicKey),
      PROGRAM_ID,
    );

    sendTxExpectFail(
      svm,
      [
        createBuyoutOffer({
          config: configAddr,
          org: orgAddr,
          asset: assetAddr,
          buyoutOffer: offerPda,
          acceptedMint: toAddress(usdcMint),
          buyer: toAddress(buyer.publicKey),
          payer: toAddress(payer.publicKey),
          pricePerShare: 1_200_000n,
          isCouncilBuyout: false,
          treasuryDisposition: 0,
          broker: toAddress(PublicKey.default),
          brokerBps: 0,
          termsHash: new Uint8Array(32),
          expiry: 10_000_000n,
          programId: PROGRAM_ID,
        }),
      ],
      [payer, buyer],
    );

    // Restore native_treasury
    const fakeTreasury = Keypair.generate().publicKey;
    patchAssetNativeTreasury(svm, new PublicKey(assetAddr), fakeTreasury);
  });

  it("rejects duplicate buyout (active buyout exists)", async () => {
    const buyer1 = Keypair.generate();
    const buyer2 = Keypair.generate();
    svm.airdrop(buyer1.publicKey, BigInt(10_000_000_000));
    svm.airdrop(buyer2.publicKey, BigInt(10_000_000_000));

    // First buyout succeeds
    await createOffer(buyer1);

    // Second buyout from different buyer should fail
    const [offerPda2] = await getBuyoutOfferPda(
      assetAddr,
      toAddress(buyer2.publicKey),
      PROGRAM_ID,
    );

    sendTxExpectFail(
      svm,
      [
        createBuyoutOffer({
          config: configAddr,
          org: orgAddr,
          asset: assetAddr,
          buyoutOffer: offerPda2,
          acceptedMint: toAddress(usdcMint),
          buyer: toAddress(buyer2.publicKey),
          payer: toAddress(payer.publicKey),
          pricePerShare: 1_200_000n,
          isCouncilBuyout: false,
          treasuryDisposition: 0,
          broker: toAddress(PublicKey.default),
          brokerBps: 0,
          termsHash: new Uint8Array(32),
          expiry: 10_000_000n,
          programId: PROGRAM_ID,
        }),
      ],
      [payer, buyer2],
    );
  });

  it("rejects invalid treasury disposition", async () => {
    const buyer = Keypair.generate();
    svm.airdrop(buyer.publicKey, BigInt(10_000_000_000));

    const [offerPda] = await getBuyoutOfferPda(
      assetAddr,
      toAddress(buyer.publicKey),
      PROGRAM_ID,
    );

    sendTxExpectFail(
      svm,
      [
        createBuyoutOffer({
          config: configAddr,
          org: orgAddr,
          asset: assetAddr,
          buyoutOffer: offerPda,
          acceptedMint: toAddress(usdcMint),
          buyer: toAddress(buyer.publicKey),
          payer: toAddress(payer.publicKey),
          pricePerShare: 1_200_000n,
          isCouncilBuyout: false,
          treasuryDisposition: 99, // Invalid — only 0-3 are valid
          broker: toAddress(PublicKey.default),
          brokerBps: 0,
          termsHash: new Uint8Array(32),
          expiry: 10_000_000n,
          programId: PROGRAM_ID,
        }),
      ],
      [payer, buyer],
    );
  });

  it("rejects broker that is the buyer", async () => {
    const buyer = Keypair.generate();
    svm.airdrop(buyer.publicKey, BigInt(10_000_000_000));

    const [offerPda] = await getBuyoutOfferPda(
      assetAddr,
      toAddress(buyer.publicKey),
      PROGRAM_ID,
    );

    sendTxExpectFail(
      svm,
      [
        createBuyoutOffer({
          config: configAddr,
          org: orgAddr,
          asset: assetAddr,
          buyoutOffer: offerPda,
          acceptedMint: toAddress(usdcMint),
          buyer: toAddress(buyer.publicKey),
          payer: toAddress(payer.publicKey),
          pricePerShare: 1_200_000n,
          isCouncilBuyout: false,
          treasuryDisposition: 0,
          broker: toAddress(buyer.publicKey), // Broker == buyer
          brokerBps: 500,
          termsHash: new Uint8Array(32),
          expiry: 10_000_000n,
          programId: PROGRAM_ID,
        }),
      ],
      [payer, buyer],
    );
  });

  it("rejects broker with zero bps", async () => {
    const buyer = Keypair.generate();
    const broker = Keypair.generate();
    svm.airdrop(buyer.publicKey, BigInt(10_000_000_000));

    const [offerPda] = await getBuyoutOfferPda(
      assetAddr,
      toAddress(buyer.publicKey),
      PROGRAM_ID,
    );

    sendTxExpectFail(
      svm,
      [
        createBuyoutOffer({
          config: configAddr,
          org: orgAddr,
          asset: assetAddr,
          buyoutOffer: offerPda,
          acceptedMint: toAddress(usdcMint),
          buyer: toAddress(buyer.publicKey),
          payer: toAddress(payer.publicKey),
          pricePerShare: 1_200_000n,
          isCouncilBuyout: false,
          treasuryDisposition: 0,
          broker: toAddress(broker.publicKey), // Non-zero broker...
          brokerBps: 0, // ...but zero bps
          termsHash: new Uint8Array(32),
          expiry: 10_000_000n,
          programId: PROGRAM_ID,
        }),
      ],
      [payer, buyer],
    );
  });

  it("rejects broker with bps over 1000", async () => {
    const buyer = Keypair.generate();
    const broker = Keypair.generate();
    svm.airdrop(buyer.publicKey, BigInt(10_000_000_000));

    const [offerPda] = await getBuyoutOfferPda(
      assetAddr,
      toAddress(buyer.publicKey),
      PROGRAM_ID,
    );

    sendTxExpectFail(
      svm,
      [
        createBuyoutOffer({
          config: configAddr,
          org: orgAddr,
          asset: assetAddr,
          buyoutOffer: offerPda,
          acceptedMint: toAddress(usdcMint),
          buyer: toAddress(buyer.publicKey),
          payer: toAddress(payer.publicKey),
          pricePerShare: 1_200_000n,
          isCouncilBuyout: false,
          treasuryDisposition: 0,
          broker: toAddress(broker.publicKey),
          brokerBps: 1001, // Over max 1000
          termsHash: new Uint8Array(32),
          expiry: 10_000_000n,
          programId: PROGRAM_ID,
        }),
      ],
      [payer, buyer],
    );
  });

  it("rejects buyout with past expiry", async () => {
    const buyer = Keypair.generate();
    svm.airdrop(buyer.publicKey, BigInt(10_000_000_000));

    const [offerPda] = await getBuyoutOfferPda(
      assetAddr,
      toAddress(buyer.publicKey),
      PROGRAM_ID,
    );

    // Clock is at ~1_000_001 from beforeEach; use an expiry in the past
    sendTxExpectFail(
      svm,
      [
        createBuyoutOffer({
          config: configAddr,
          org: orgAddr,
          asset: assetAddr,
          buyoutOffer: offerPda,
          acceptedMint: toAddress(usdcMint),
          buyer: toAddress(buyer.publicKey),
          payer: toAddress(payer.publicKey),
          pricePerShare: 1_200_000n,
          isCouncilBuyout: false,
          treasuryDisposition: 0,
          broker: toAddress(PublicKey.default),
          brokerBps: 0,
          termsHash: new Uint8Array(32),
          expiry: 1n, // Way in the past
          programId: PROGRAM_ID,
        }),
      ],
      [payer, buyer],
    );
  });

  // ── Failure: fund_buyout_offer validations ────────────────────────

  it("rejects fund by non-buyer", async () => {
    const buyer = Keypair.generate();
    const impostor = Keypair.generate();
    svm.airdrop(buyer.publicKey, BigInt(10_000_000_000));
    svm.airdrop(impostor.publicKey, BigInt(10_000_000_000));

    const offerPda = await createOffer(buyer);
    const [escrowPda] = await getBuyoutEscrowPda(offerPda, PROGRAM_ID);

    const impostorToken = createTokenAccount(svm, usdcMint, impostor.publicKey, payer);
    mintTokensTo(svm, usdcMint, impostorToken, 120_000_000n, mintAuthority);

    sendTxExpectFail(
      svm,
      [
        fundBuyoutOffer({
          buyoutOffer: offerPda,
          asset: assetAddr,
          escrow: escrowPda,
          buyerTokenAcc: toAddress(impostorToken),
          acceptedMint: toAddress(usdcMint),
          buyer: toAddress(impostor.publicKey), // Wrong buyer
          payer: toAddress(payer.publicKey),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, impostor],
    );
  });

  it("rejects fund on expired offer", async () => {
    const buyer = Keypair.generate();
    svm.airdrop(buyer.publicKey, BigInt(10_000_000_000));

    const EXPIRY = 2_000_000n;
    const offerPda = await createOffer(buyer, 1_200_000n, EXPIRY);
    const [escrowPda] = await getBuyoutEscrowPda(offerPda, PROGRAM_ID);

    // Warp past expiry
    const clock = svm.getClock();
    clock.unixTimestamp = EXPIRY + 1n;
    svm.setClock(clock);

    const buyerUsdcAcct = createTokenAccount(svm, usdcMint, buyer.publicKey, payer);
    mintTokensTo(svm, usdcMint, buyerUsdcAcct, 120_000_000n, mintAuthority);

    sendTxExpectFail(
      svm,
      [
        fundBuyoutOffer({
          buyoutOffer: offerPda,
          asset: assetAddr,
          escrow: escrowPda,
          buyerTokenAcc: toAddress(buyerUsdcAcct),
          acceptedMint: toAddress(usdcMint),
          buyer: toAddress(buyer.publicKey),
          payer: toAddress(payer.publicKey),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, buyer],
    );
  });

  it("rejects fund on already-funded offer", async () => {
    const buyer = Keypair.generate();
    svm.airdrop(buyer.publicKey, BigInt(10_000_000_000));

    const offerPda = await createOffer(buyer);

    // Fund it once
    const buyerUsdcAcct = createTokenAccount(svm, usdcMint, buyer.publicKey, payer);
    mintTokensTo(svm, usdcMint, buyerUsdcAcct, 240_000_000n, mintAuthority);
    const [escrowPda] = await getBuyoutEscrowPda(offerPda, PROGRAM_ID);

    sendTx(
      svm,
      [
        fundBuyoutOffer({
          buyoutOffer: offerPda,
          asset: assetAddr,
          escrow: escrowPda,
          buyerTokenAcc: toAddress(buyerUsdcAcct),
          acceptedMint: toAddress(usdcMint),
          buyer: toAddress(buyer.publicKey),
          payer: toAddress(payer.publicKey),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, buyer],
    );

    // Try to fund again — status is Funded, not Pending
    // Need a new escrow PDA since old one is taken — but the error
    // should happen at status check before escrow creation
    sendTxExpectFail(
      svm,
      [
        fundBuyoutOffer({
          buyoutOffer: offerPda,
          asset: assetAddr,
          escrow: escrowPda,
          buyerTokenAcc: toAddress(buyerUsdcAcct),
          acceptedMint: toAddress(usdcMint),
          buyer: toAddress(buyer.publicKey),
          payer: toAddress(payer.publicKey),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, buyer],
    );
  });

  // ── Failure: cancel validations ───────────────────────────────────

  it("rejects cancel by non-buyer (voluntary path)", async () => {
    const buyer = Keypair.generate();
    const nonBuyer = Keypair.generate();
    svm.airdrop(buyer.publicKey, BigInt(10_000_000_000));
    svm.airdrop(nonBuyer.publicKey, BigInt(10_000_000_000));

    const offerPda = await createOffer(buyer);

    sendTxExpectFail(
      svm,
      [
        cancelBuyout({
          buyoutOffer: offerPda,
          asset: assetAddr,
          buyer: toAddress(nonBuyer.publicKey), // Wrong buyer
          programId: PROGRAM_ID,
        }),
      ],
      [nonBuyer],
    );
  });

  // ── Failure: market blocks during active buyout ───────────────────

  it("blocks make_offer during active buyout", async () => {
    const buyer = Keypair.generate();
    svm.airdrop(buyer.publicKey, BigInt(10_000_000_000));

    await createOffer(buyer);

    // Try to make an offer on the investor's token
    const offerBuyer = Keypair.generate();
    svm.airdrop(offerBuyer.publicKey, BigInt(10_000_000_000));
    const offerBuyerToken = createTokenAccount(svm, usdcMint, offerBuyer.publicKey, payer);
    mintTokensTo(svm, usdcMint, offerBuyerToken, 50_000_000n, mintAuthority);

    const [offerPda] = await getOfferPda(
      assetTokenAddr,
      toAddress(offerBuyer.publicKey),
      PROGRAM_ID,
    );
    const [offerEscrowPda] = await getOfferEscrowPda(offerPda, PROGRAM_ID);

    sendTxExpectFail(
      svm,
      [
        makeOffer({
          config: configAddr,
          assetAccount: assetAddr,
          assetTokenAccount: assetTokenAddr,
          offerAccount: offerPda,
          escrow: offerEscrowPda,
          acceptedMint: toAddress(usdcMint),
          buyerTokenAcc: toAddress(offerBuyerToken),
          buyer: toAddress(offerBuyer.publicKey),
          payer: toAddress(payer.publicKey),
          sharesRequested: 10n,
          pricePerShare: 2_000_000n,
          expiry: 10_000_000n,
          programId: PROGRAM_ID,
        }),
      ],
      [payer, offerBuyer],
    );
  });

  it("blocks mint_token during active buyout", async () => {
    const buyer = Keypair.generate();
    svm.airdrop(buyer.publicKey, BigInt(10_000_000_000));

    await createOffer(buyer);

    // Try to direct-mint a token — should fail
    const newNftKp = Keypair.generate();
    const recipient = Keypair.generate();
    const [newTokenPda] = await getAssetTokenPda(assetAddr, 1, PROGRAM_ID);

    sendTxExpectFail(
      svm,
      [
        mintToken({
          config: configAddr,
          orgAccount: orgAddr,
          assetAccount: assetAddr,
          assetTokenAccount: newTokenPda,
          collection: toAddress(collectionKp.publicKey),
          collectionAuthority: collAuthAddr,
          nft: toAddress(newNftKp.publicKey),
          recipient: toAddress(recipient.publicKey),
          authority: toAddress(orgAuthority.publicKey),
          payer: toAddress(payer.publicKey),
          shares: 10n,
          programId: PROGRAM_ID,
        }),
      ],
      [payer, orgAuthority, newNftKp],
    );
  });
});
