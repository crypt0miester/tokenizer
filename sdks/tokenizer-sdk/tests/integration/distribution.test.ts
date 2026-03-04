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
import { decodeDividendDistribution } from "../../src/accounts/dividendDistribution.js";
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
  createDistribution,
  claimDistribution,
  closeDistribution,
} from "../../src/instructions/distribution.js";
import {
  getProtocolConfigPda,
  getOrganizationPda,
  getAssetPda,
  getAssetTokenPda,
  getCollectionAuthorityPda,
  getFundraisingRoundPda,
  getEscrowPda,
  getInvestmentPda,
  getDistributionPda,
  getDistributionEscrowPda,
} from "../../src/pdas.js";
import { AccountKey } from "../../src/constants.js";

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

describe("Distribution Integration", () => {
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

  // Two investors with minted tokens
  let investorA: Keypair;
  let investorB: Keypair;
  let assetTokenA: Address;
  let assetTokenB: Address;

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

    // Create fee treasury token account at feeTreasury.publicKey
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

    // Fundraising: 2 investors

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

    // Investor A: 60 shares
    investorA = Keypair.generate();
    svm.airdrop(investorA.publicKey, BigInt(10_000_000_000));
    const tokenA = createTokenAccount(svm, usdcMint, investorA.publicKey, payer);
    mintTokensTo(svm, usdcMint, tokenA, 200_000_000n, mintAuthority);
    const [invAPda] = await getInvestmentPda(
      roundPda,
      toAddress(investorA.publicKey),
      PROGRAM_ID,
    );

    sendTx(
      svm,
      [
        invest({
          config: configAddr,
          roundAccount: roundPda,
          investmentAccount: invAPda,
          escrow: escrowPda,
          investorTokenAccount: toAddress(tokenA),
          investor: toAddress(investorA.publicKey),
          payer: toAddress(payer.publicKey),
          shares: 60n,
          termsHash: new Uint8Array(32),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, investorA],
    );

    // Investor B: 40 shares
    investorB = Keypair.generate();
    svm.airdrop(investorB.publicKey, BigInt(10_000_000_000));
    const tokenB = createTokenAccount(svm, usdcMint, investorB.publicKey, payer);
    mintTokensTo(svm, usdcMint, tokenB, 200_000_000n, mintAuthority);
    const [invBPda] = await getInvestmentPda(
      roundPda,
      toAddress(investorB.publicKey),
      PROGRAM_ID,
    );

    sendTx(
      svm,
      [
        invest({
          config: configAddr,
          roundAccount: roundPda,
          investmentAccount: invBPda,
          escrow: escrowPda,
          investorTokenAccount: toAddress(tokenB),
          investor: toAddress(investorB.publicKey),
          payer: toAddress(payer.publicKey),
          shares: 40n,
          termsHash: new Uint8Array(32),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, investorB],
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

    // Mint tokens for both investors
    const nftA = Keypair.generate();
    const nftB = Keypair.generate();
    const [atAPda] = await getAssetTokenPda(assetAddr, 0, PROGRAM_ID);
    const [atBPda] = await getAssetTokenPda(assetAddr, 1, PROGRAM_ID);
    assetTokenA = atAPda;
    assetTokenB = atBPda;

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
              investmentAccount: invAPda,
              assetTokenAccount: assetTokenA,
              nft: toAddress(nftA.publicKey),
              investor: toAddress(investorA.publicKey),
            },
            {
              investmentAccount: invBPda,
              assetTokenAccount: assetTokenB,
              nft: toAddress(nftB.publicKey),
              investor: toAddress(investorB.publicKey),
            },
          ],
          programId: PROGRAM_ID,
        }),
      ],
      [payer, nftA, nftB],
    );
  });

  // create → claim → close─

  it("create distribution, claim for holders, close", async () => {
    // Asset has 100 minted shares (60 A + 40 B)
    const asset = decodeAsset(getAccountData(svm, assetAddr));
    expect(asset.mintedShares).toBe(100n);
    expect(asset.dividendEpoch).toBe(0);

    // Freshly minted tokens have last_claimed_epoch=0 and the first
    // distribution gets epoch=0. The on-chain check
    // `dist_epoch <= last_claimed_epoch` makes epoch 0 unclaimable.
    // Work around: create a small epoch-0 distribution to advance the
    // asset epoch, then create the real distribution at epoch 1.

    const depositorAcct = createTokenAccount(
      svm,
      usdcMint,
      orgAuthority.publicKey,
      payer,
    );
    mintTokensTo(svm, usdcMint, depositorAcct, 2_000_000_000n, mintAuthority);

    // Epoch 0 (unclaimable for these tokens — advances asset.dividend_epoch to 1)
    const [dist0Pda] = await getDistributionPda(assetAddr, 0, PROGRAM_ID);
    const [dist0EscrowPda] = await getDistributionEscrowPda(dist0Pda, PROGRAM_ID);

    sendTx(
      svm,
      [
        createDistribution({
          config: configAddr,
          orgAccount: orgAddr,
          assetAccount: assetAddr,
          distributionAccount: dist0Pda,
          escrow: dist0EscrowPda,
          depositorTokenAcc: toAddress(depositorAcct),
          acceptedMint: toAddress(usdcMint),
          authority: toAddress(orgAuthority.publicKey),
          payer: toAddress(payer.publicKey),
          totalAmount: 1_000_000n, // 1 USDC — just to advance epoch
          programId: PROGRAM_ID,
        }),
      ],
      [payer, orgAuthority],
    );

    // Verify epoch advanced to 1
    const assetAfter0 = decodeAsset(getAccountData(svm, assetAddr));
    expect(assetAfter0.dividendEpoch).toBe(1);

    // Epoch 1 — real distribution: 100 USDC
    const [dist1Pda] = await getDistributionPda(assetAddr, 1, PROGRAM_ID);
    const [dist1EscrowPda] = await getDistributionEscrowPda(dist1Pda, PROGRAM_ID);

    sendTx(
      svm,
      [
        createDistribution({
          config: configAddr,
          orgAccount: orgAddr,
          assetAccount: assetAddr,
          distributionAccount: dist1Pda,
          escrow: dist1EscrowPda,
          depositorTokenAcc: toAddress(depositorAcct),
          acceptedMint: toAddress(usdcMint),
          authority: toAddress(orgAuthority.publicKey),
          payer: toAddress(payer.publicKey),
          totalAmount: 100_000_000n, // 100 USDC
          programId: PROGRAM_ID,
        }),
      ],
      [payer, orgAuthority],
    );

    const dist1 = decodeDividendDistribution(
      getAccountData(svm, dist1Pda),
    );
    expect(dist1.epoch).toBe(1);
    expect(dist1.totalAmount).toBe(100_000_000n);
    expect(dist1.sharesClaimed).toBe(0n);

    // Claim A (60 shares → 60 USDC)
    const holderTokenA = getAtaAddress(investorA.publicKey, usdcMint);

    sendTx(
      svm,
      [
        claimDistribution({
          distributionAccount: dist1Pda,
          escrow: dist1EscrowPda,
          assetAccount: assetAddr,
          payer: toAddress(payer.publicKey),
          acceptedMint: toAddress(usdcMint),
          ataProgram: toAddress(ATA_PROGRAM_ID),
          claims: [
            {
              assetTokenAccount: assetTokenA,
              holderTokenAcc: toAddress(holderTokenA),
              holder: toAddress(investorA.publicKey),
            },
          ],
          programId: PROGRAM_ID,
        }),
      ],
      [payer],
    );

    expect(getTokenBalance(svm, holderTokenA)).toBe(60_000_000n);

    // Verify AssetToken A advanced last_claimed_epoch
    const atAData = decodeAssetToken(getAccountData(svm, assetTokenA));
    expect(atAData.lastClaimedEpoch).toBe(1);

    // Claim B (40 shares → 40 USDC)
    const holderTokenB = getAtaAddress(investorB.publicKey, usdcMint);

    sendTx(
      svm,
      [
        claimDistribution({
          distributionAccount: dist1Pda,
          escrow: dist1EscrowPda,
          assetAccount: assetAddr,
          payer: toAddress(payer.publicKey),
          acceptedMint: toAddress(usdcMint),
          ataProgram: toAddress(ATA_PROGRAM_ID),
          claims: [
            {
              assetTokenAccount: assetTokenB,
              holderTokenAcc: toAddress(holderTokenB),
              holder: toAddress(investorB.publicKey),
            },
          ],
          programId: PROGRAM_ID,
        }),
      ],
      [payer],
    );

    expect(getTokenBalance(svm, holderTokenB)).toBe(40_000_000n);

    // Verify distribution fully claimed
    const dist1After = decodeDividendDistribution(
      getAccountData(svm, dist1Pda),
    );
    expect(dist1After.sharesClaimed).toBe(100n);

    // Close fully-claimed distribution
    const dustRecipient = getAtaAddress(orgAuthority.publicKey, usdcMint);

    sendTx(
      svm,
      [
        closeDistribution({
          distributionAccount: dist1Pda,
          escrow: dist1EscrowPda,
          assetAccount: assetAddr,
          orgAccount: orgAddr,
          dustRecipient: toAddress(dustRecipient),
          payer: toAddress(payer.publicKey),
          rentDestination: toAddress(payer.publicKey),
          programId: PROGRAM_ID,
        }),
      ],
      [payer],
    );

    // Distribution account should be closed (zero data)
    const closedData = svm.getAccount(
      new PublicKey(dist1Pda.toString()),
    );
    expect(closedData).toBeNull();
  });
});
