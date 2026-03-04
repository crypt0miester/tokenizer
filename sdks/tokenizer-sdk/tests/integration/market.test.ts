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
import { decodeAssetToken } from "../../src/accounts/assetToken.js";
import { decodeListing } from "../../src/accounts/listing.js";
import { decodeOffer } from "../../src/accounts/offer.js";
import { decodeAssetV1, decodeCollectionV1 } from "../../src/external/mpl-core/accounts.js";
import { PluginType } from "../../src/external/mpl-core/constants.js";
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
import {
  listForSale,
  delist,
  buyListedToken,
  makeOffer,
  acceptOffer,
  rejectOffer,
  cancelOffer,
  consolidateTokens,
  transferToken,
} from "../../src/instructions/market.js";
import {
  getProtocolConfigPda,
  getOrganizationPda,
  getAssetPda,
  getAssetTokenPda,
  getCollectionAuthorityPda,
  getFundraisingRoundPda,
  getEscrowPda,
  getInvestmentPda,
  getListingPda,
  getOfferPda,
  getOfferEscrowPda,
} from "../../src/pdas.js";
import {
  AccountKey,
  AssetStatus,
  ListingStatus,
  OfferStatus,
  TransferPolicy,
} from "../../src/constants.js";
import { MplCoreKey } from "../../src/external/mpl-core/constants.js";

// Constants─

const PROGRAM_ID = address("FNDZziaztYptbydC5UpLEaLMyFN4rDmP3G2MN7o6w4ZK");
const PROGRAM_PK = new PublicKey("FNDZziaztYptbydC5UpLEaLMyFN4rDmP3G2MN7o6w4ZK");

function getAtaAddress(wallet: PublicKey, mint: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [wallet.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM_ID,
  );
  return ata;
}

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

// Test Suite

describe("Market Integration", () => {
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

  // Minted token from fundraising
  let seller: Keypair; // investor who received the token
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

    // Create fee treasury token account at feeTreasury.publicKey.
    // buy_listed_token and accept_offer validate:
    //   fee_treasury_token.address() == config.fee_treasury
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

    // Fundraising flow to get a minted token

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

    seller = Keypair.generate();
    svm.airdrop(seller.publicKey, BigInt(10_000_000_000));
    const sellerUsdcAcct = createTokenAccount(svm, usdcMint, seller.publicKey, payer);
    mintTokensTo(svm, usdcMint, sellerUsdcAcct, 200_000_000n, mintAuthority);
    const [invPda] = await getInvestmentPda(
      roundPda,
      toAddress(seller.publicKey),
      PROGRAM_ID,
    );

    sendTx(
      svm,
      [
        invest({
          config: configAddr,
          roundAccount: roundPda,
          investmentAccount: invPda,
          escrow: escrowPda,
          investorTokenAccount: toAddress(sellerUsdcAcct),
          investor: toAddress(seller.publicKey),
          payer: toAddress(payer.publicKey),
          shares: 100n,
          termsHash: new Uint8Array(32),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, seller],
    );

    // Finalize
    const clock = svm.getClock();
    clock.unixTimestamp = END_TIME + 1n;
    svm.setClock(clock);

    const orgTreasuryToken = getAtaAddress(orgAuthority.publicKey, usdcMint);

    sendTx(
      svm,
      [
        finalizeRound({
          config: configAddr,
          assetAccount: assetAddr,
          roundAccount: roundPda,
          escrow: escrowPda,
          feeTreasuryToken: toAddress(feeTreasury.publicKey),
          orgTreasuryToken: toAddress(orgTreasuryToken),
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
              investor: toAddress(seller.publicKey),
            },
          ],
          programId: PROGRAM_ID,
        }),
      ],
      [payer, nftKp],
    );
  });

  // list → delist──

  it("list and delist", async () => {
    const [listingPda] = await getListingPda(assetTokenAddr, PROGRAM_ID);

    // List token for sale
    sendTx(
      svm,
      [
        listForSale({
          config: configAddr,
          assetAccount: assetAddr,
          assetTokenAccount: assetTokenAddr,
          listingAccount: listingPda,
          seller: toAddress(seller.publicKey),
          payer: toAddress(payer.publicKey),
          sharesForSale: 100n,
          pricePerShare: 2_000_000n,
          isPartial: false,
          expiry: 0n,
          programId: PROGRAM_ID,
        }),
      ],
      [payer, seller],
    );

    // Verify listing created
    const listing = decodeListing(getAccountData(svm, listingPda));
    expect(listing.accountKey).toBe(AccountKey.Listing);
    expect(listing.status).toBe(ListingStatus.Active);
    expect(listing.sharesForSale).toBe(100n);
    expect(listing.pricePerShare).toBe(2_000_000n);
    expect(listing.seller).toBe(toAddress(seller.publicKey));
    expect(listing.isPartial).toBe(false);

    // Verify asset token marked as listed
    const tokenListed = decodeAssetToken(getAccountData(svm, assetTokenAddr));
    expect(tokenListed.isListed).toBe(true);

    // Delist
    sendTx(
      svm,
      [
        delist({
          assetTokenAccount: assetTokenAddr,
          listingAccount: listingPda,
          seller: toAddress(seller.publicKey),
          rentDestination: toAddress(payer.publicKey),
          programId: PROGRAM_ID,
        }),
      ],
      [seller],
    );

    // Verify listing account closed
    const listingAcct = svm.getAccount(new PublicKey(listingPda));
    expect(listingAcct).toBeNull();

    // Verify asset token no longer listed
    const tokenDelisted = decodeAssetToken(getAccountData(svm, assetTokenAddr));
    expect(tokenDelisted.isListed).toBe(false);
  });

  // list → buy (full)─

  it("list and buy (full buy)", async () => {
    const [listingPda] = await getListingPda(assetTokenAddr, PROGRAM_ID);

    // List all 100 shares at 2 USDC each
    sendTx(
      svm,
      [
        listForSale({
          config: configAddr,
          assetAccount: assetAddr,
          assetTokenAccount: assetTokenAddr,
          listingAccount: listingPda,
          seller: toAddress(seller.publicKey),
          payer: toAddress(payer.publicKey),
          sharesForSale: 100n,
          pricePerShare: 2_000_000n,
          isPartial: false,
          expiry: 0n,
          programId: PROGRAM_ID,
        }),
      ],
      [payer, seller],
    );

    // Fund buyer
    const buyer = Keypair.generate();
    svm.airdrop(buyer.publicKey, BigInt(10_000_000_000));
    const buyerUsdcAcct = createTokenAccount(svm, usdcMint, buyer.publicKey, payer);
    mintTokensTo(svm, usdcMint, buyerUsdcAcct, 500_000_000n, mintAuthority);

    const sellerTokenAcc = getAtaAddress(seller.publicKey, usdcMint);
    const feeBalanceBefore = getTokenBalance(svm, feeTreasury.publicKey);

    // Buy
    sendTx(
      svm,
      [
        buyListedToken({
          config: configAddr,
          asset: assetAddr,
          assetToken: assetTokenAddr,
          listing: listingPda,
          nft: toAddress(nftKp.publicKey),
          collection: toAddress(collectionKp.publicKey),
          collectionAuthority: collAuthAddr,
          buyer: toAddress(buyer.publicKey),
          seller: toAddress(seller.publicKey),
          buyerTokenAcc: toAddress(buyerUsdcAcct),
          sellerTokenAcc: toAddress(sellerTokenAcc),
          feeTreasuryToken: toAddress(feeTreasury.publicKey),
          payer: toAddress(payer.publicKey),
          acceptedMint: toAddress(usdcMint),
          ataProgram: toAddress(ATA_PROGRAM_ID),
          rentDestination: toAddress(payer.publicKey),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, buyer],
    );

    // Verify asset token owner changed to buyer
    const token = decodeAssetToken(getAccountData(svm, assetTokenAddr));
    expect(token.owner).toBe(toAddress(buyer.publicKey));
    expect(token.isListed).toBe(false);

    // Verify listing closed
    expect(svm.getAccount(new PublicKey(listingPda))).toBeNull();

    // Verify payment: 100 shares × 2 USDC = 200 USDC
    // Fee: 1% of 200 = 2 USDC, Seller gets 198 USDC
    const feeBalanceAfter = getTokenBalance(svm, feeTreasury.publicKey);
    expect(feeBalanceAfter - feeBalanceBefore).toBe(2_000_000n);

    const sellerBalance = getTokenBalance(svm, sellerTokenAcc);
    expect(sellerBalance).toBe(198_000_000n);

    // Verify NFT owner (on-chain MPL Core asset)
    const nftAcct = svm.getAccount(nftKp.publicKey);
    expect(nftAcct).not.toBeNull();
    expect(nftAcct!.data[0]).toBe(MplCoreKey.AssetV1);

    // Verify PermanentFreezeDelegate still frozen after transfer
    const nftAsset = decodeAssetV1(nftAcct!.data);
    const freezePlugin = nftAsset.plugins.find(
      (p) => p.type === PluginType.PermanentFreezeDelegate,
    );
    expect(freezePlugin).toBeDefined();
    expect((freezePlugin as { frozen: boolean }).frozen).toBe(true);
  });

  // make offer → reject───

  it("make offer and reject", async () => {
    const buyer = Keypair.generate();
    svm.airdrop(buyer.publicKey, BigInt(10_000_000_000));
    const buyerUsdcAcct = createTokenAccount(svm, usdcMint, buyer.publicKey, payer);
    mintTokensTo(svm, usdcMint, buyerUsdcAcct, 500_000_000n, mintAuthority);

    const [offerPda] = await getOfferPda(
      assetTokenAddr,
      toAddress(buyer.publicKey),
      PROGRAM_ID,
    );
    const [offerEscrowPda] = await getOfferEscrowPda(offerPda, PROGRAM_ID);

    const buyerBalanceBefore = getTokenBalance(svm, buyerUsdcAcct);

    // Make offer: 100 shares at 3 USDC each = 300 USDC total
    sendTx(
      svm,
      [
        makeOffer({
          config: configAddr,
          assetAccount: assetAddr,
          assetTokenAccount: assetTokenAddr,
          offerAccount: offerPda,
          escrow: offerEscrowPda,
          acceptedMint: toAddress(usdcMint),
          buyerTokenAcc: toAddress(buyerUsdcAcct),
          buyer: toAddress(buyer.publicKey),
          payer: toAddress(payer.publicKey),
          sharesRequested: 100n,
          pricePerShare: 3_000_000n,
          expiry: 0n,
          programId: PROGRAM_ID,
        }),
      ],
      [payer, buyer],
    );

    // Verify offer created
    const offer = decodeOffer(getAccountData(svm, offerPda));
    expect(offer.accountKey).toBe(AccountKey.Offer);
    expect(offer.status).toBe(OfferStatus.Active);
    expect(offer.sharesRequested).toBe(100n);
    expect(offer.pricePerShare).toBe(3_000_000n);
    expect(offer.totalDeposited).toBe(300_000_000n);

    // Verify escrow has deposit
    expect(getTokenBalance(svm, new PublicKey(offerEscrowPda))).toBe(300_000_000n);

    // Verify buyer balance decreased
    const buyerBalanceAfterOffer = getTokenBalance(svm, buyerUsdcAcct);
    expect(buyerBalanceAfterOffer).toBe(buyerBalanceBefore - 300_000_000n);

    // Reject offer (seller rejects)
    sendTx(
      svm,
      [
        rejectOffer({
          assetTokenAccount: assetTokenAddr,
          offerAccount: offerPda,
          escrow: offerEscrowPda,
          buyerTokenAcc: toAddress(buyerUsdcAcct),
          seller: toAddress(seller.publicKey),
          buyer: toAddress(buyer.publicKey),
          acceptedMint: toAddress(usdcMint),
          ataProgram: toAddress(ATA_PROGRAM_ID),
          rentDestination: toAddress(payer.publicKey),
          programId: PROGRAM_ID,
        }),
      ],
      [seller],
    );

    // Verify offer + escrow closed
    expect(svm.getAccount(new PublicKey(offerPda))).toBeNull();
    expect(svm.getAccount(new PublicKey(offerEscrowPda))).toBeNull();

    // Verify buyer got refund
    const buyerBalanceAfterReject = getTokenBalance(svm, buyerUsdcAcct);
    expect(buyerBalanceAfterReject).toBe(buyerBalanceBefore);
  });

  // make offer → cancel───

  it("make offer and cancel", async () => {
    const buyer = Keypair.generate();
    svm.airdrop(buyer.publicKey, BigInt(10_000_000_000));
    const buyerUsdcAcct = createTokenAccount(svm, usdcMint, buyer.publicKey, payer);
    mintTokensTo(svm, usdcMint, buyerUsdcAcct, 500_000_000n, mintAuthority);

    const [offerPda] = await getOfferPda(
      assetTokenAddr,
      toAddress(buyer.publicKey),
      PROGRAM_ID,
    );
    const [offerEscrowPda] = await getOfferEscrowPda(offerPda, PROGRAM_ID);

    const buyerBalanceBefore = getTokenBalance(svm, buyerUsdcAcct);

    // Make offer: 50 shares at 2 USDC each
    sendTx(
      svm,
      [
        makeOffer({
          config: configAddr,
          assetAccount: assetAddr,
          assetTokenAccount: assetTokenAddr,
          offerAccount: offerPda,
          escrow: offerEscrowPda,
          acceptedMint: toAddress(usdcMint),
          buyerTokenAcc: toAddress(buyerUsdcAcct),
          buyer: toAddress(buyer.publicKey),
          payer: toAddress(payer.publicKey),
          sharesRequested: 50n,
          pricePerShare: 2_000_000n,
          expiry: 0n,
          programId: PROGRAM_ID,
        }),
      ],
      [payer, buyer],
    );

    // Cancel offer (buyer cancels)
    sendTx(
      svm,
      [
        cancelOffer({
          offerAccount: offerPda,
          escrow: offerEscrowPda,
          buyerTokenAcc: toAddress(buyerUsdcAcct),
          buyer: toAddress(buyer.publicKey),
          acceptedMint: toAddress(usdcMint),
          ataProgram: toAddress(ATA_PROGRAM_ID),
          rentDestination: toAddress(payer.publicKey),
          programId: PROGRAM_ID,
        }),
      ],
      [buyer],
    );

    // Verify offer + escrow closed
    expect(svm.getAccount(new PublicKey(offerPda))).toBeNull();
    expect(svm.getAccount(new PublicKey(offerEscrowPda))).toBeNull();

    // Verify buyer got full refund
    const buyerBalanceAfter = getTokenBalance(svm, buyerUsdcAcct);
    expect(buyerBalanceAfter).toBe(buyerBalanceBefore);
  });

  // make offer → accept (full)─

  it("make offer and accept (full buy)", async () => {
    const buyer = Keypair.generate();
    svm.airdrop(buyer.publicKey, BigInt(10_000_000_000));
    const buyerUsdcAcct = createTokenAccount(svm, usdcMint, buyer.publicKey, payer);
    mintTokensTo(svm, usdcMint, buyerUsdcAcct, 500_000_000n, mintAuthority);

    const [offerPda] = await getOfferPda(
      assetTokenAddr,
      toAddress(buyer.publicKey),
      PROGRAM_ID,
    );
    const [offerEscrowPda] = await getOfferEscrowPda(offerPda, PROGRAM_ID);

    // Make offer: all 100 shares at 2 USDC each = 200 USDC
    sendTx(
      svm,
      [
        makeOffer({
          config: configAddr,
          assetAccount: assetAddr,
          assetTokenAccount: assetTokenAddr,
          offerAccount: offerPda,
          escrow: offerEscrowPda,
          acceptedMint: toAddress(usdcMint),
          buyerTokenAcc: toAddress(buyerUsdcAcct),
          buyer: toAddress(buyer.publicKey),
          payer: toAddress(payer.publicKey),
          sharesRequested: 0n, // 0 = all shares
          pricePerShare: 2_000_000n,
          expiry: 0n,
          programId: PROGRAM_ID,
        }),
      ],
      [payer, buyer],
    );

    // Verify escrow
    expect(getTokenBalance(svm, new PublicKey(offerEscrowPda))).toBe(200_000_000n);

    const sellerTokenAcc = getAtaAddress(seller.publicKey, usdcMint);
    const feeBalanceBefore = getTokenBalance(svm, feeTreasury.publicKey);

    // Accept offer
    sendTx(
      svm,
      [
        acceptOffer({
          config: configAddr,
          asset: assetAddr,
          assetToken: assetTokenAddr,
          offer: offerPda,
          escrow: offerEscrowPda,
          nft: toAddress(nftKp.publicKey),
          collection: toAddress(collectionKp.publicKey),
          collectionAuthority: collAuthAddr,
          seller: toAddress(seller.publicKey),
          buyer: toAddress(buyer.publicKey),
          sellerTokenAcc: toAddress(sellerTokenAcc),
          feeTreasuryToken: toAddress(feeTreasury.publicKey),
          payer: toAddress(payer.publicKey),
          acceptedMint: toAddress(usdcMint),
          ataProgram: toAddress(ATA_PROGRAM_ID),
          rentDestination: toAddress(payer.publicKey),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, seller],
    );

    // Verify token owner changed
    const token = decodeAssetToken(getAccountData(svm, assetTokenAddr));
    expect(token.owner).toBe(toAddress(buyer.publicKey));

    // Verify offer + escrow closed
    expect(svm.getAccount(new PublicKey(offerPda))).toBeNull();
    expect(svm.getAccount(new PublicKey(offerEscrowPda))).toBeNull();

    // Verify payment: 200 USDC total, 1% fee = 2 USDC, seller = 198 USDC
    const feeBalanceAfter = getTokenBalance(svm, feeTreasury.publicKey);
    expect(feeBalanceAfter - feeBalanceBefore).toBe(2_000_000n);

    const sellerBalance = getTokenBalance(svm, sellerTokenAcc);
    expect(sellerBalance).toBe(198_000_000n);

    // Verify PermanentFreezeDelegate still frozen after transfer
    const nftAcct = svm.getAccount(nftKp.publicKey);
    expect(nftAcct).not.toBeNull();
    const nftAsset = decodeAssetV1(nftAcct!.data);
    expect(nftAsset.owner).toBe(toAddress(buyer.publicKey));
    const freezePlugin = nftAsset.plugins.find(
      (p) => p.type === PluginType.PermanentFreezeDelegate,
    );
    expect(freezePlugin).toBeDefined();
    expect((freezePlugin as { frozen: boolean }).frozen).toBe(true);
  });

  // partial buy

  it("list and buy (partial buy)", async () => {
    const [listingPda] = await getListingPda(assetTokenAddr, PROGRAM_ID);

    // List 40 of 100 shares as partial at 2 USDC each
    sendTx(
      svm,
      [
        listForSale({
          config: configAddr,
          assetAccount: assetAddr,
          assetTokenAccount: assetTokenAddr,
          listingAccount: listingPda,
          seller: toAddress(seller.publicKey),
          payer: toAddress(payer.publicKey),
          sharesForSale: 40n,
          pricePerShare: 2_000_000n,
          isPartial: true,
          expiry: 0n,
          programId: PROGRAM_ID,
        }),
      ],
      [payer, seller],
    );

    // Fund buyer
    const buyer = Keypair.generate();
    svm.airdrop(buyer.publicKey, BigInt(10_000_000_000));
    const buyerUsdcAcct = createTokenAccount(svm, usdcMint, buyer.publicKey, payer);
    mintTokensTo(svm, usdcMint, buyerUsdcAcct, 500_000_000n, mintAuthority);

    const sellerTokenAcc = getAtaAddress(seller.publicKey, usdcMint);
    const feeBalanceBefore = getTokenBalance(svm, feeTreasury.publicKey);

    // New NFT keypairs for buyer and seller remainder
    const newNftBuyerKp = Keypair.generate();
    const newNftSellerKp = Keypair.generate();

    // After beforeEach, collection.num_minted = 1 (index 0 used).
    // Partial buy mints 2 new tokens: buyer at index 1, seller at index 2.
    const [buyerAssetToken] = await getAssetTokenPda(assetAddr, 1, PROGRAM_ID);
    const [sellerAssetToken] = await getAssetTokenPda(assetAddr, 2, PROGRAM_ID);

    sendTx(
      svm,
      [
        buyListedToken({
          config: configAddr,
          asset: assetAddr,
          assetToken: assetTokenAddr,
          listing: listingPda,
          nft: toAddress(nftKp.publicKey),
          collection: toAddress(collectionKp.publicKey),
          collectionAuthority: collAuthAddr,
          buyer: toAddress(buyer.publicKey),
          seller: toAddress(seller.publicKey),
          buyerTokenAcc: toAddress(buyerUsdcAcct),
          sellerTokenAcc: toAddress(sellerTokenAcc),
          feeTreasuryToken: toAddress(feeTreasury.publicKey),
          payer: toAddress(payer.publicKey),
          acceptedMint: toAddress(usdcMint),
          ataProgram: toAddress(ATA_PROGRAM_ID),
          rentDestination: toAddress(payer.publicKey),
          partial: {
            newNftBuyer: toAddress(newNftBuyerKp.publicKey),
            buyerAssetToken,
            newNftSeller: toAddress(newNftSellerKp.publicKey),
            sellerAssetToken,
          },
          programId: PROGRAM_ID,
        }),
      ],
      [payer, buyer, newNftBuyerKp, newNftSellerKp],
    );

    // Old asset token should be closed
    expect(svm.getAccount(new PublicKey(assetTokenAddr))).toBeNull();

    // Old NFT should be burned (Uninitialized)
    const oldNftAcct = svm.getAccount(nftKp.publicKey);
    expect(oldNftAcct === null || oldNftAcct.data[0] === 0).toBe(true);

    // Buyer asset token: 40 shares, owner = buyer
    const buyerToken = decodeAssetToken(getAccountData(svm, buyerAssetToken));
    expect(buyerToken.shares).toBe(40n);
    expect(buyerToken.owner).toBe(toAddress(buyer.publicKey));
    expect(buyerToken.tokenIndex).toBe(1);

    // Seller remainder token: 60 shares, owner = seller
    const sellerRemainderToken = decodeAssetToken(getAccountData(svm, sellerAssetToken));
    expect(sellerRemainderToken.shares).toBe(60n);
    expect(sellerRemainderToken.owner).toBe(toAddress(seller.publicKey));
    expect(sellerRemainderToken.tokenIndex).toBe(2);

    // Verify new NFTs have PermanentFreezeDelegate frozen = true
    for (const nftPk of [newNftBuyerKp.publicKey, newNftSellerKp.publicKey]) {
      const acct = svm.getAccount(nftPk);
      expect(acct).not.toBeNull();
      expect(acct!.data[0]).toBe(MplCoreKey.AssetV1);
      const asset = decodeAssetV1(acct!.data);
      const freeze = asset.plugins.find(
        (pl) => pl.type === PluginType.PermanentFreezeDelegate,
      );
      expect(freeze).toBeDefined();
      expect((freeze as { frozen: boolean }).frozen).toBe(true);
    }

    // Listing closed
    expect(svm.getAccount(new PublicKey(listingPda))).toBeNull();

    // Payment: 40 × 2 = 80 USDC, 1% fee = 0.8 USDC, seller gets 79.2 USDC
    const feeBalanceAfter = getTokenBalance(svm, feeTreasury.publicKey);
    expect(feeBalanceAfter - feeBalanceBefore).toBe(800_000n);

    const sellerBalance = getTokenBalance(svm, sellerTokenAcc);
    expect(sellerBalance).toBe(79_200_000n);
  });

  // partial accept offer───

  it("make offer and accept (partial)", async () => {
    const buyer = Keypair.generate();
    svm.airdrop(buyer.publicKey, BigInt(10_000_000_000));
    const buyerUsdcAcct = createTokenAccount(svm, usdcMint, buyer.publicKey, payer);
    mintTokensTo(svm, usdcMint, buyerUsdcAcct, 500_000_000n, mintAuthority);

    const [offerPda] = await getOfferPda(
      assetTokenAddr,
      toAddress(buyer.publicKey),
      PROGRAM_ID,
    );
    const [offerEscrowPda] = await getOfferEscrowPda(offerPda, PROGRAM_ID);

    // Make offer: 40 shares at 3 USDC each = 120 USDC
    sendTx(
      svm,
      [
        makeOffer({
          config: configAddr,
          assetAccount: assetAddr,
          assetTokenAccount: assetTokenAddr,
          offerAccount: offerPda,
          escrow: offerEscrowPda,
          acceptedMint: toAddress(usdcMint),
          buyerTokenAcc: toAddress(buyerUsdcAcct),
          buyer: toAddress(buyer.publicKey),
          payer: toAddress(payer.publicKey),
          sharesRequested: 40n,
          pricePerShare: 3_000_000n,
          expiry: 0n,
          programId: PROGRAM_ID,
        }),
      ],
      [payer, buyer],
    );

    // Verify escrow has 120 USDC
    expect(getTokenBalance(svm, new PublicKey(offerEscrowPda))).toBe(120_000_000n);

    const sellerTokenAcc = getAtaAddress(seller.publicKey, usdcMint);
    const feeBalanceBefore = getTokenBalance(svm, feeTreasury.publicKey);

    // New NFT keypairs
    const newNftBuyerKp = Keypair.generate();
    const newNftSellerKp = Keypair.generate();

    const [buyerAssetToken] = await getAssetTokenPda(assetAddr, 1, PROGRAM_ID);
    const [sellerAssetToken] = await getAssetTokenPda(assetAddr, 2, PROGRAM_ID);

    // Accept offer (partial — 40 < 100 shares)
    sendTx(
      svm,
      [
        acceptOffer({
          config: configAddr,
          asset: assetAddr,
          assetToken: assetTokenAddr,
          offer: offerPda,
          escrow: offerEscrowPda,
          nft: toAddress(nftKp.publicKey),
          collection: toAddress(collectionKp.publicKey),
          collectionAuthority: collAuthAddr,
          seller: toAddress(seller.publicKey),
          buyer: toAddress(buyer.publicKey),
          sellerTokenAcc: toAddress(sellerTokenAcc),
          feeTreasuryToken: toAddress(feeTreasury.publicKey),
          payer: toAddress(payer.publicKey),
          acceptedMint: toAddress(usdcMint),
          ataProgram: toAddress(ATA_PROGRAM_ID),
          rentDestination: toAddress(payer.publicKey),
          partial: {
            newNftBuyer: toAddress(newNftBuyerKp.publicKey),
            buyerAssetToken,
            newNftSeller: toAddress(newNftSellerKp.publicKey),
            sellerAssetToken,
          },
          programId: PROGRAM_ID,
        }),
      ],
      [payer, seller, newNftBuyerKp, newNftSellerKp],
    );

    // Old asset token closed
    expect(svm.getAccount(new PublicKey(assetTokenAddr))).toBeNull();

    // Old NFT burned
    const oldNftAcct = svm.getAccount(nftKp.publicKey);
    expect(oldNftAcct === null || oldNftAcct.data[0] === 0).toBe(true);

    // Buyer asset token: 40 shares
    const buyerToken = decodeAssetToken(getAccountData(svm, buyerAssetToken));
    expect(buyerToken.shares).toBe(40n);
    expect(buyerToken.owner).toBe(toAddress(buyer.publicKey));

    // Seller remainder token: 60 shares
    const sellerRemainderToken = decodeAssetToken(getAccountData(svm, sellerAssetToken));
    expect(sellerRemainderToken.shares).toBe(60n);
    expect(sellerRemainderToken.owner).toBe(toAddress(seller.publicKey));

    // New NFTs frozen
    for (const nftPk of [newNftBuyerKp.publicKey, newNftSellerKp.publicKey]) {
      const acct = svm.getAccount(nftPk);
      expect(acct).not.toBeNull();
      expect(acct!.data[0]).toBe(MplCoreKey.AssetV1);
      const asset = decodeAssetV1(acct!.data);
      const freeze = asset.plugins.find(
        (pl) => pl.type === PluginType.PermanentFreezeDelegate,
      );
      expect(freeze).toBeDefined();
      expect((freeze as { frozen: boolean }).frozen).toBe(true);
    }

    // Offer + escrow closed
    expect(svm.getAccount(new PublicKey(offerPda))).toBeNull();
    expect(svm.getAccount(new PublicKey(offerEscrowPda))).toBeNull();

    // Payment: 40 × 3 = 120 USDC, 1% fee = 1.2 USDC, seller gets 118.8 USDC
    const feeBalanceAfter = getTokenBalance(svm, feeTreasury.publicKey);
    expect(feeBalanceAfter - feeBalanceBefore).toBe(1_200_000n);

    const sellerBalance = getTokenBalance(svm, sellerTokenAcc);
    expect(sellerBalance).toBe(118_800_000n);
  });

  // consolidate tokens─

  it("consolidate two tokens into one", async () => {
    // After beforeEach: seller has 100-share token at index 0, asset is Active.
    // Create a second fundraising round to give seller another token.

    const [round1Pda] = await getFundraisingRoundPda(assetAddr, 1, PROGRAM_ID);
    const [escrow1Pda] = await getEscrowPda(round1Pda, PROGRAM_ID);
    const END_TIME_2 = 2_000_000n;

    sendTx(
      svm,
      [
        createRound({
          config: configAddr,
          orgAccount: orgAddr,
          assetAccount: assetAddr,
          roundAccount: round1Pda,
          escrow: escrow1Pda,
          acceptedMint: toAddress(usdcMint),
          authority: toAddress(orgAuthority.publicKey),
          payer: toAddress(payer.publicKey),
          sharesOffered: 500_000n,
          pricePerShare: 1_000_000n,
          minRaise: 50_000_000n,
          maxRaise: 500_000_000_000n,
          minPerWallet: 1_000_000n,
          maxPerWallet: 250_000_000_000n,
          startTime: 0n,
          endTime: END_TIME_2,
          lockupEnd: 0n,
          termsHash: new Uint8Array(32),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, orgAuthority],
    );

    // Seller still has 100M USDC left from beforeEach funding (200M minted, 100M spent).
    // Re-use the seller's existing USDC account — we need to find it or create a new one.
    const sellerUsdcAcct = createTokenAccount(svm, usdcMint, seller.publicKey, payer);
    mintTokensTo(svm, usdcMint, sellerUsdcAcct, 100_000_000n, mintAuthority);

    const [inv1Pda] = await getInvestmentPda(
      round1Pda,
      toAddress(seller.publicKey),
      PROGRAM_ID,
    );

    sendTx(
      svm,
      [
        invest({
          config: configAddr,
          roundAccount: round1Pda,
          investmentAccount: inv1Pda,
          escrow: escrow1Pda,
          investorTokenAccount: toAddress(sellerUsdcAcct),
          investor: toAddress(seller.publicKey),
          payer: toAddress(payer.publicKey),
          shares: 100n,
          termsHash: new Uint8Array(32),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, seller],
    );

    // Warp past end time and finalize round 1
    const clock = svm.getClock();
    clock.unixTimestamp = END_TIME_2 + 1n;
    svm.setClock(clock);

    const orgTreasuryToken = getAtaAddress(orgAuthority.publicKey, usdcMint);

    sendTx(
      svm,
      [
        finalizeRound({
          config: configAddr,
          assetAccount: assetAddr,
          roundAccount: round1Pda,
          escrow: escrow1Pda,
          feeTreasuryToken: toAddress(feeTreasury.publicKey),
          orgTreasuryToken: toAddress(orgTreasuryToken),
          treasuryWallet: toAddress(orgAuthority.publicKey),
          payer: toAddress(payer.publicKey),
          acceptedMint: toAddress(usdcMint),
          ataProgram: toAddress(ATA_PROGRAM_ID),
          programId: PROGRAM_ID,
        }),
      ],
      [payer],
    );

    // Mint token at index 1 for seller
    const nft1Kp = Keypair.generate();
    const [assetToken1Addr] = await getAssetTokenPda(assetAddr, 1, PROGRAM_ID);

    sendTx(
      svm,
      [
        mintRoundTokens({
          roundAccount: round1Pda,
          assetAccount: assetAddr,
          collection: toAddress(collectionKp.publicKey),
          collectionAuthority: collAuthAddr,
          payer: toAddress(payer.publicKey),
          investors: [
            {
              investmentAccount: inv1Pda,
              assetTokenAccount: assetToken1Addr,
              nft: toAddress(nft1Kp.publicKey),
              investor: toAddress(seller.publicKey),
            },
          ],
          programId: PROGRAM_ID,
        }),
      ],
      [payer, nft1Kp],
    );

    // Now seller has 2 tokens: index 0 (100 shares) and index 1 (100 shares).
    // Consolidate into new token at index 2.
    const newNftKp = Keypair.generate();
    const [newAssetTokenAddr] = await getAssetTokenPda(assetAddr, 2, PROGRAM_ID);

    // Record collection num_minted before consolidate
    const collBefore = decodeCollectionV1(svm.getAccount(collectionKp.publicKey)!.data);
    const numMintedBefore = collBefore.numMinted;

    sendTx(
      svm,
      [
        consolidateTokens({
          config: configAddr,
          asset: assetAddr,
          collection: toAddress(collectionKp.publicKey),
          collectionAuthority: collAuthAddr,
          newNft: toAddress(newNftKp.publicKey),
          newAssetToken: newAssetTokenAddr,
          owner: toAddress(seller.publicKey),
          payer: toAddress(payer.publicKey),
          tokens: [
            { assetToken: assetTokenAddr, nft: toAddress(nftKp.publicKey) },
            { assetToken: assetToken1Addr, nft: toAddress(nft1Kp.publicKey) },
          ],
          programId: PROGRAM_ID,
        }),
      ],
      [payer, seller, newNftKp],
    );

    // New AssetToken: 200 shares, owner = seller, tokenIndex = 2
    const consolidated = decodeAssetToken(getAccountData(svm, newAssetTokenAddr));
    expect(consolidated.shares).toBe(200n);
    expect(consolidated.owner).toBe(toAddress(seller.publicKey));
    expect(consolidated.tokenIndex).toBe(2);

    // Old asset tokens closed
    expect(svm.getAccount(new PublicKey(assetTokenAddr))).toBeNull();
    expect(svm.getAccount(new PublicKey(assetToken1Addr))).toBeNull();

    // Old NFTs burned
    for (const oldNftPk of [nftKp.publicKey, nft1Kp.publicKey]) {
      const acct = svm.getAccount(oldNftPk);
      expect(acct === null || acct.data[0] === 0).toBe(true);
    }

    // New NFT created with PermanentFreezeDelegate frozen
    const newNftAcct = svm.getAccount(newNftKp.publicKey);
    expect(newNftAcct).not.toBeNull();
    expect(newNftAcct!.data[0]).toBe(MplCoreKey.AssetV1);
    const newNftAsset = decodeAssetV1(newNftAcct!.data);
    const freeze = newNftAsset.plugins.find(
      (pl) => pl.type === PluginType.PermanentFreezeDelegate,
    );
    expect(freeze).toBeDefined();
    expect((freeze as { frozen: boolean }).frozen).toBe(true);

    // Collection num_minted incremented
    const collAfter = decodeCollectionV1(svm.getAccount(collectionKp.publicKey)!.data);
    expect(collAfter.numMinted).toBe(numMintedBefore + 1);
  });

  // transfer token (direct P2P) 

  it("transfer token (direct P2P)", async () => {
    // Need to create a new asset with transferPolicy = Transferable
    // since beforeEach creates one with default (NonTransferable)
    const collectionKp2 = Keypair.generate();
    const [assetPda2] = await getAssetPda(orgAddr, 1, PROGRAM_ID);
    const [collAuthPda2] = await getCollectionAuthorityPda(
      toAddress(collectionKp2.publicKey),
      PROGRAM_ID,
    );

    sendTx(
      svm,
      [
        initAsset({
          config: configAddr,
          orgAccount: orgAddr,
          assetAccount: assetPda2,
          collection: toAddress(collectionKp2.publicKey),
          collectionAuthority: collAuthPda2,
          authority: toAddress(orgAuthority.publicKey),
          payer: toAddress(payer.publicKey),
          totalShares: 1_000_000n,
          pricePerShare: 1_000_000n,
          acceptedMint: toAddress(usdcMint),
          maturityDate: 0n,
          maturityGracePeriod: 0n,
          transferCooldown: 0n,
          maxHolders: 0,
          transferPolicy: TransferPolicy.Transferable,
          name: "Transferable",
          uri: "https://example.com/asset2.json",
          programId: PROGRAM_ID,
        }),
      ],
      [payer, orgAuthority, collectionKp2],
    );

    // Verify transfer_policy is set
    const assetData = decodeAsset(getAccountData(svm, assetPda2));
    expect(assetData.transferPolicy).toBe(TransferPolicy.Transferable);

    // Fundraise to get a minted token on this asset
    const [roundPda2] = await getFundraisingRoundPda(assetPda2, 0, PROGRAM_ID);
    const [escrowPda2] = await getEscrowPda(roundPda2, PROGRAM_ID);
    const END_TIME_3 = 3_000_000n;

    sendTx(
      svm,
      [
        createRound({
          config: configAddr,
          orgAccount: orgAddr,
          assetAccount: assetPda2,
          roundAccount: roundPda2,
          escrow: escrowPda2,
          acceptedMint: toAddress(usdcMint),
          authority: toAddress(orgAuthority.publicKey),
          payer: toAddress(payer.publicKey),
          sharesOffered: 500_000n,
          pricePerShare: 1_000_000n,
          minRaise: 50_000_000n,
          maxRaise: 500_000_000_000n,
          minPerWallet: 1_000_000n,
          maxPerWallet: 250_000_000_000n,
          startTime: 0n,
          endTime: END_TIME_3,
          lockupEnd: 0n,
          termsHash: new Uint8Array(32),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, orgAuthority],
    );

    // Investor
    const investor = Keypair.generate();
    svm.airdrop(investor.publicKey, BigInt(10_000_000_000));
    const investorUsdcAcct = createTokenAccount(svm, usdcMint, investor.publicKey, payer);
    mintTokensTo(svm, usdcMint, investorUsdcAcct, 200_000_000n, mintAuthority);

    const [invPda2] = await getInvestmentPda(
      roundPda2,
      toAddress(investor.publicKey),
      PROGRAM_ID,
    );

    sendTx(
      svm,
      [
        invest({
          config: configAddr,
          roundAccount: roundPda2,
          investmentAccount: invPda2,
          escrow: escrowPda2,
          investorTokenAccount: toAddress(investorUsdcAcct),
          investor: toAddress(investor.publicKey),
          payer: toAddress(payer.publicKey),
          shares: 100n,
          termsHash: new Uint8Array(32),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, investor],
    );

    // Finalize
    const clock = svm.getClock();
    clock.unixTimestamp = END_TIME_3 + 1n;
    svm.setClock(clock);

    const orgTreasuryToken = getAtaAddress(orgAuthority.publicKey, usdcMint);

    sendTx(
      svm,
      [
        finalizeRound({
          config: configAddr,
          assetAccount: assetPda2,
          roundAccount: roundPda2,
          escrow: escrowPda2,
          feeTreasuryToken: toAddress(feeTreasury.publicKey),
          orgTreasuryToken: toAddress(orgTreasuryToken),
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
    const nft2Kp = Keypair.generate();
    const [atPda2] = await getAssetTokenPda(assetPda2, 0, PROGRAM_ID);

    sendTx(
      svm,
      [
        mintRoundTokens({
          roundAccount: roundPda2,
          assetAccount: assetPda2,
          collection: toAddress(collectionKp2.publicKey),
          collectionAuthority: collAuthPda2,
          payer: toAddress(payer.publicKey),
          investors: [
            {
              investmentAccount: invPda2,
              assetTokenAccount: atPda2,
              nft: toAddress(nft2Kp.publicKey),
              investor: toAddress(investor.publicKey),
            },
          ],
          programId: PROGRAM_ID,
        }),
      ],
      [payer, nft2Kp],
    );

    // Now do P2P transfer from investor to a new recipient
    const recipient = Keypair.generate();
    svm.airdrop(recipient.publicKey, BigInt(10_000_000_000));

    sendTx(
      svm,
      [
        transferToken({
          config: configAddr,
          asset: assetPda2,
          assetToken: atPda2,
          nft: toAddress(nft2Kp.publicKey),
          collection: toAddress(collectionKp2.publicKey),
          collectionAuthority: collAuthPda2,
          owner: toAddress(investor.publicKey),
          newOwner: toAddress(recipient.publicKey),
          payer: toAddress(payer.publicKey),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, investor],
    );

    // Verify owner changed
    const token = decodeAssetToken(getAccountData(svm, atPda2));
    expect(token.owner).toBe(toAddress(recipient.publicKey));

    // Verify NFT still frozen
    const nftAcct = svm.getAccount(nft2Kp.publicKey);
    expect(nftAcct).not.toBeNull();
    const nftAsset = decodeAssetV1(nftAcct!.data);
    expect(nftAsset.owner).toBe(toAddress(recipient.publicKey));
    const freezePlugin = nftAsset.plugins.find(
      (p) => p.type === PluginType.PermanentFreezeDelegate,
    );
    expect(freezePlugin).toBeDefined();
    expect((freezePlugin as { frozen: boolean }).frozen).toBe(true);
  });

  // transfer token fails when non-transferable ─

  it("transfer token fails when asset is non-transferable", async () => {
    // The default asset from beforeEach has transferPolicy = 0 (NonTransferable)
    const recipient = Keypair.generate();
    svm.airdrop(recipient.publicKey, BigInt(10_000_000_000));

    expect(() =>
      sendTx(
        svm,
        [
          transferToken({
            config: configAddr,
            asset: assetAddr,
            assetToken: assetTokenAddr,
            nft: toAddress(nftKp.publicKey),
            collection: toAddress(collectionKp.publicKey),
            collectionAuthority: collAuthAddr,
            owner: toAddress(seller.publicKey),
            newOwner: toAddress(recipient.publicKey),
            payer: toAddress(payer.publicKey),
            programId: PROGRAM_ID,
          }),
        ],
        [payer, seller],
      ),
    ).toThrow("9308");
  });

  // transfer token fails on self-transfer

  it("transfer token fails on self-transfer", async () => {
    // Create a transferable asset and mint a token, then try self-transfer
    const collectionKp3 = Keypair.generate();
    const [assetPda3] = await getAssetPda(orgAddr, 1, PROGRAM_ID);
    const [collAuthPda3] = await getCollectionAuthorityPda(
      toAddress(collectionKp3.publicKey),
      PROGRAM_ID,
    );

    sendTx(
      svm,
      [
        initAsset({
          config: configAddr,
          orgAccount: orgAddr,
          assetAccount: assetPda3,
          collection: toAddress(collectionKp3.publicKey),
          collectionAuthority: collAuthPda3,
          authority: toAddress(orgAuthority.publicKey),
          payer: toAddress(payer.publicKey),
          totalShares: 1_000_000n,
          pricePerShare: 1_000_000n,
          acceptedMint: toAddress(usdcMint),
          maturityDate: 0n,
          maturityGracePeriod: 0n,
          transferCooldown: 0n,
          maxHolders: 0,
          transferPolicy: TransferPolicy.Transferable,
          name: "SelfTransfer",
          uri: "https://example.com/asset3.json",
          programId: PROGRAM_ID,
        }),
      ],
      [payer, orgAuthority, collectionKp3],
    );

    // Fundraise
    const [roundPda3] = await getFundraisingRoundPda(assetPda3, 0, PROGRAM_ID);
    const [escrowPda3] = await getEscrowPda(roundPda3, PROGRAM_ID);
    const END_TIME_4 = 4_000_000n;

    sendTx(
      svm,
      [
        createRound({
          config: configAddr,
          orgAccount: orgAddr,
          assetAccount: assetPda3,
          roundAccount: roundPda3,
          escrow: escrowPda3,
          acceptedMint: toAddress(usdcMint),
          authority: toAddress(orgAuthority.publicKey),
          payer: toAddress(payer.publicKey),
          sharesOffered: 500_000n,
          pricePerShare: 1_000_000n,
          minRaise: 50_000_000n,
          maxRaise: 500_000_000_000n,
          minPerWallet: 1_000_000n,
          maxPerWallet: 250_000_000_000n,
          startTime: 0n,
          endTime: END_TIME_4,
          lockupEnd: 0n,
          termsHash: new Uint8Array(32),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, orgAuthority],
    );

    const selfTransferUser = Keypair.generate();
    svm.airdrop(selfTransferUser.publicKey, BigInt(10_000_000_000));
    const userUsdcAcct = createTokenAccount(svm, usdcMint, selfTransferUser.publicKey, payer);
    mintTokensTo(svm, usdcMint, userUsdcAcct, 200_000_000n, mintAuthority);

    const [invPda3] = await getInvestmentPda(
      roundPda3,
      toAddress(selfTransferUser.publicKey),
      PROGRAM_ID,
    );

    sendTx(
      svm,
      [
        invest({
          config: configAddr,
          roundAccount: roundPda3,
          investmentAccount: invPda3,
          escrow: escrowPda3,
          investorTokenAccount: toAddress(userUsdcAcct),
          investor: toAddress(selfTransferUser.publicKey),
          payer: toAddress(payer.publicKey),
          shares: 100n,
          termsHash: new Uint8Array(32),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, selfTransferUser],
    );

    const clock = svm.getClock();
    clock.unixTimestamp = END_TIME_4 + 1n;
    svm.setClock(clock);

    const orgTreasuryToken = getAtaAddress(orgAuthority.publicKey, usdcMint);

    sendTx(
      svm,
      [
        finalizeRound({
          config: configAddr,
          assetAccount: assetPda3,
          roundAccount: roundPda3,
          escrow: escrowPda3,
          feeTreasuryToken: toAddress(feeTreasury.publicKey),
          orgTreasuryToken: toAddress(orgTreasuryToken),
          treasuryWallet: toAddress(orgAuthority.publicKey),
          payer: toAddress(payer.publicKey),
          acceptedMint: toAddress(usdcMint),
          ataProgram: toAddress(ATA_PROGRAM_ID),
          programId: PROGRAM_ID,
        }),
      ],
      [payer],
    );

    const nft3Kp = Keypair.generate();
    const [atPda3] = await getAssetTokenPda(assetPda3, 0, PROGRAM_ID);

    sendTx(
      svm,
      [
        mintRoundTokens({
          roundAccount: roundPda3,
          assetAccount: assetPda3,
          collection: toAddress(collectionKp3.publicKey),
          collectionAuthority: collAuthPda3,
          payer: toAddress(payer.publicKey),
          investors: [
            {
              investmentAccount: invPda3,
              assetTokenAccount: atPda3,
              nft: toAddress(nft3Kp.publicKey),
              investor: toAddress(selfTransferUser.publicKey),
            },
          ],
          programId: PROGRAM_ID,
        }),
      ],
      [payer, nft3Kp],
    );

    // Try self-transfer — should fail with error 9312
    expect(() =>
      sendTx(
        svm,
        [
          transferToken({
            config: configAddr,
            asset: assetPda3,
            assetToken: atPda3,
            nft: toAddress(nft3Kp.publicKey),
            collection: toAddress(collectionKp3.publicKey),
            collectionAuthority: collAuthPda3,
            owner: toAddress(selfTransferUser.publicKey),
            newOwner: toAddress(selfTransferUser.publicKey),
            payer: toAddress(payer.publicKey),
            programId: PROGRAM_ID,
          }),
        ],
        [payer, selfTransferUser],
      ),
    ).toThrow("9312");
  });
});
