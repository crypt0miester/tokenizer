import { describe, it, expect, beforeEach } from "vitest";
import {
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { type LiteSVM, type FailedTransactionMetadata } from "litesvm";
import { AccountRole, address, type Address } from "gill";
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
import { decodeAssetToken } from "../../src/accounts/assetToken.js";
import { decodeFundraisingRound } from "../../src/accounts/fundraisingRound.js";
import { decodeInvestment } from "../../src/accounts/investment.js";
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
  cancelRound,
  refundInvestment,
} from "../../src/instructions/fundraising.js";
import { listForSale } from "../../src/instructions/market.js";
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
  getProposalSeedPda,
  getRegistrarPda,
  getMaxVoterWeightRecordPda,
} from "../../src/pdas.js";
import { AccountKey, AssetStatus, RoundStatus } from "../../src/constants.js";
import { MplCoreKey } from "../../src/external/mpl-core/constants.js";
import { decodeProtocolConfig } from "../../src/accounts/protocolConfig.js";
import {
  SPL_GOVERNANCE_PROGRAM_ID,
  VoteThresholdType,
} from "../../src/external/governance/constants.js";
import {
  depositGoverningTokens,
  createProposal,
  insertTransaction,
  signOffProposal,
  castVote,
  executeTransaction,
  encodeGovernanceConfig,
  VoteChoice,
  type GovernanceConfig,
} from "../../src/external/governance/instructions.js";
import {
  createOrgRealm,
  createAssetGovernance,
  createRegistrar,
  createMaxVoterWeightRecord,
} from "../../src/instructions/governance.js";
import {
  getRealmAddress,
  getTokenHoldingAddress,
  getRealmConfigAddress,
  getTokenOwnerRecordAddress,
  getGovernanceAddress,
  getNativeTreasuryAddress,
  getVoteRecordAddress,
  getProposalTransactionAddress,
  getProposalAddress,
} from "../../src/external/governance/pdas.js";

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

describe("Fundraising Integration", () => {
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

  beforeEach(async () => {
    svm = createTestSvm({ programId: PROGRAM_PK, loadMplCore: true, loadSplGov: true });

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

    // Initialize protocol (100 bps = 1% fee)
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

    // Init asset
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
          pricePerShare: 1_000_000n, // 1 USDC per share (6 decimals)
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
  });

  // Helpers───

  function fundInvestor(investor: Keypair, amount: bigint): PublicKey {
    svm.airdrop(investor.publicKey, BigInt(10_000_000_000));
    const tokenAcct = createTokenAccount(svm, usdcMint, investor.publicKey, payer);
    mintTokensTo(svm, usdcMint, tokenAcct, amount, mintAuthority);
    return tokenAcct;
  }

  function warpPastEndTime(endTime: bigint) {
    const clock = svm.getClock();
    clock.unixTimestamp = endTime + 1n;
    svm.setClock(clock);
  }

  // Success flow: create → invest × 2 → finalize → mint 

  it("USDC success flow: create round, invest, finalize, mint", async () => {
    const [roundPda] = await getFundraisingRoundPda(assetAddr, 0, PROGRAM_ID);
    const [escrowPda] = await getEscrowPda(roundPda, PROGRAM_ID);

    const END_TIME = 1_000_000n;

    // 1. Create round
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
          minRaise: 100_000_000n, // 100 USDC
          maxRaise: 500_000_000_000n,
          minPerWallet: 1_000_000n, // 1 USDC
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

    // Verify round created
    const round = decodeFundraisingRound(getAccountData(svm, roundPda));
    expect(round.accountKey).toBe(AccountKey.FundraisingRound);
    expect(round.status).toBe(RoundStatus.Active);
    expect(round.sharesOffered).toBe(500_000n);
    expect(round.pricePerShare).toBe(1_000_000n);
    expect(round.roundIndex).toBe(0);
    expect(round.totalRaised).toBe(0n);

    // Verify asset status changed to Fundraising
    const assetAfterRound = decodeAsset(getAccountData(svm, assetAddr));
    expect(assetAfterRound.status).toBe(AssetStatus.Fundraising);
    expect(assetAfterRound.fundraisingRoundCount).toBe(1);

    // 2. Invest — investor A buys 100 shares (100 USDC)
    const investorA = Keypair.generate();
    const investorAToken = fundInvestor(investorA, 200_000_000n); // 200 USDC
    const [invAPda] = await getInvestmentPda(roundPda, toAddress(investorA.publicKey), PROGRAM_ID);

    sendTx(
      svm,
      [
        invest({
          config: configAddr,
          roundAccount: roundPda,
          investmentAccount: invAPda,
          escrow: escrowPda,
          investorTokenAccount: toAddress(investorAToken),
          investor: toAddress(investorA.publicKey),
          payer: toAddress(payer.publicKey),
          shares: 100n,
          termsHash: new Uint8Array(32),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, investorA],
    );

    // Verify investment A
    const invA = decodeInvestment(getAccountData(svm, invAPda));
    expect(invA.accountKey).toBe(AccountKey.Investment);
    expect(invA.sharesReserved).toBe(100n);
    expect(invA.amountDeposited).toBe(100_000_000n); // 100 shares × 1 USDC
    expect(invA.isMinted).toBe(false);
    expect(invA.isRefunded).toBe(false);

    // 3. Invest — investor B buys 200 shares (200 USDC)
    const investorB = Keypair.generate();
    const investorBToken = fundInvestor(investorB, 300_000_000n);
    const [invBPda] = await getInvestmentPda(roundPda, toAddress(investorB.publicKey), PROGRAM_ID);

    sendTx(
      svm,
      [
        invest({
          config: configAddr,
          roundAccount: roundPda,
          investmentAccount: invBPda,
          escrow: escrowPda,
          investorTokenAccount: toAddress(investorBToken),
          investor: toAddress(investorB.publicKey),
          payer: toAddress(payer.publicKey),
          shares: 200n,
          termsHash: new Uint8Array(32),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, investorB],
    );

    // Verify round totals
    const roundAfterInvest = decodeFundraisingRound(getAccountData(svm, roundPda));
    expect(roundAfterInvest.totalRaised).toBe(300_000_000n); // 300 USDC
    expect(roundAfterInvest.sharesSold).toBe(300n);
    expect(roundAfterInvest.investorCount).toBe(2);

    // Verify escrow balance
    expect(getTokenBalance(svm, new PublicKey(escrowPda))).toBe(300_000_000n);

    // 4. Finalize round (warp past end_time)
    warpPastEndTime(END_TIME);

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

    // Verify round succeeded
    const roundFinalized = decodeFundraisingRound(getAccountData(svm, roundPda));
    expect(roundFinalized.status).toBe(RoundStatus.Succeeded);

    // Verify asset status back to Active
    const assetFinalized = decodeAsset(getAccountData(svm, assetAddr));
    expect(assetFinalized.status).toBe(AssetStatus.Active);

    // Verify fee distribution: 1% of 300 USDC = 3 USDC
    const feeBalance = getTokenBalance(svm, feeTreasury.publicKey);
    expect(feeBalance).toBe(3_000_000n); // 3 USDC

    // Verify org received remainder: 300 - 3 = 297 USDC
    const orgBalance = getTokenBalance(svm, orgTreasuryToken);
    expect(orgBalance).toBe(297_000_000n);

    // Verify escrow is empty
    expect(getTokenBalance(svm, new PublicKey(escrowPda))).toBe(0n);

    // 5. Mint round tokens for both investors
    const nftA = Keypair.generate();
    const nftB = Keypair.generate();
    const [assetTokenA] = await getAssetTokenPda(assetAddr, 0, PROGRAM_ID);
    const [assetTokenB] = await getAssetTokenPda(assetAddr, 1, PROGRAM_ID);

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

    // Verify AssetToken A
    const tokenA = decodeAssetToken(getAccountData(svm, assetTokenA));
    expect(tokenA.accountKey).toBe(AccountKey.AssetToken);
    expect(tokenA.shares).toBe(100n);
    expect(tokenA.owner).toBe(toAddress(investorA.publicKey));
    expect(tokenA.tokenIndex).toBe(0);

    // Verify AssetToken B
    const tokenB = decodeAssetToken(getAccountData(svm, assetTokenB));
    expect(tokenB.shares).toBe(200n);
    expect(tokenB.owner).toBe(toAddress(investorB.publicKey));
    expect(tokenB.tokenIndex).toBe(1);

    // Verify NFTs created
    const nftAAcct = svm.getAccount(nftA.publicKey);
    expect(nftAAcct).not.toBeNull();
    expect(nftAAcct!.data[0]).toBe(MplCoreKey.AssetV1);

    // Verify investments marked as minted
    const invAFinal = decodeInvestment(getAccountData(svm, invAPda));
    expect(invAFinal.isMinted).toBe(true);

    const invBFinal = decodeInvestment(getAccountData(svm, invBPda));
    expect(invBFinal.isMinted).toBe(true);

    // Verify asset minted shares updated
    const assetFinal = decodeAsset(getAccountData(svm, assetAddr));
    expect(assetFinal.mintedShares).toBe(300n);

    // Verify round investors_settled
    const roundFinal = decodeFundraisingRound(getAccountData(svm, roundPda));
    expect(roundFinal.investorsSettled).toBe(2);
  });

  // Cancellation flow: create → invest → cancel → refund─

  it("cancellation flow: create round, invest, cancel, refund", async () => {
    const [roundPda] = await getFundraisingRoundPda(assetAddr, 0, PROGRAM_ID);
    const [escrowPda] = await getEscrowPda(roundPda, PROGRAM_ID);

    // 1. Create round
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
          endTime: 9_999_999_999n,
          lockupEnd: 0n,
          termsHash: new Uint8Array(32),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, orgAuthority],
    );

    // 2. Invest — investor buys 50 shares (50 USDC)
    const investor = Keypair.generate();
    const investorToken = fundInvestor(investor, 100_000_000n);
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
          shares: 50n,
          termsHash: new Uint8Array(32),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, investor],
    );

    // Verify escrow has funds
    expect(getTokenBalance(svm, new PublicKey(escrowPda))).toBe(50_000_000n);

    // Record investor balance before refund
    const balanceBefore = getTokenBalance(svm, investorToken);

    // 3. Cancel round
    sendTx(
      svm,
      [
        cancelRound({
          config: configAddr,
          orgAccount: orgAddr,
          assetAccount: assetAddr,
          roundAccount: roundPda,
          authority: toAddress(orgAuthority.publicKey),
          programId: PROGRAM_ID,
        }),
      ],
      [orgAuthority],
    );

    // Verify round cancelled
    const roundCancelled = decodeFundraisingRound(getAccountData(svm, roundPda));
    expect(roundCancelled.status).toBe(RoundStatus.Cancelled);

    // Verify asset reverted to Draft
    const assetCancelled = decodeAsset(getAccountData(svm, assetAddr));
    expect(assetCancelled.status).toBe(AssetStatus.Draft);

    // 4. Refund investor
    sendTx(
      svm,
      [
        refundInvestment({
          roundAccount: roundPda,
          escrow: escrowPda,
          payer: toAddress(payer.publicKey),
          acceptedMint: toAddress(usdcMint),
          ataProgram: toAddress(ATA_PROGRAM_ID),
          investors: [
            {
              investmentAccount: invPda,
              investorTokenAccount: toAddress(investorToken),
              investor: toAddress(investor.publicKey),
            },
          ],
          programId: PROGRAM_ID,
        }),
      ],
      [payer],
    );

    // Verify investor got their USDC back
    const balanceAfter = getTokenBalance(svm, investorToken);
    expect(balanceAfter).toBe(balanceBefore + 50_000_000n);

    // Verify escrow token account was closed (all investors refunded)
    expect(svm.getAccount(new PublicKey(escrowPda))).toBeNull();

    // Verify investment marked as refunded
    const invRefunded = decodeInvestment(getAccountData(svm, invPda));
    expect(invRefunded.isRefunded).toBe(true);

    // Verify round investors_settled
    const roundFinal = decodeFundraisingRound(getAccountData(svm, roundPda));
    expect(roundFinal.investorsSettled).toBe(1);
  });

  // Failure flow: min_raise not met → finalize as Failed → refund

  it("failure flow: finalize as failed when min_raise not met, then refund", async () => {
    const [roundPda] = await getFundraisingRoundPda(assetAddr, 0, PROGRAM_ID);
    const [escrowPda] = await getEscrowPda(roundPda, PROGRAM_ID);

    const END_TIME = 500_000n;

    // 1. Create round with high min_raise
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
          minRaise: 1_000_000_000n, // 1000 USDC min
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

    // 2. Invest only 10 USDC (below min_raise of 1000)
    const investor = Keypair.generate();
    const investorToken = fundInvestor(investor, 100_000_000n);
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
          shares: 10n, // 10 USDC
          termsHash: new Uint8Array(32),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, investor],
    );

    const balanceBefore = getTokenBalance(svm, investorToken);

    // 3. Warp past end_time and finalize (should fail since 10 < 1000)
    warpPastEndTime(END_TIME);

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

    // Verify round failed
    const roundFailed = decodeFundraisingRound(getAccountData(svm, roundPda));
    expect(roundFailed.status).toBe(RoundStatus.Failed);

    // Verify asset reverted to Draft
    const assetFailed = decodeAsset(getAccountData(svm, assetAddr));
    expect(assetFailed.status).toBe(AssetStatus.Draft);

    // Escrow still has funds (not distributed)
    expect(getTokenBalance(svm, new PublicKey(escrowPda))).toBe(10_000_000n);

    // 4. Refund investor
    sendTx(
      svm,
      [
        refundInvestment({
          roundAccount: roundPda,
          escrow: escrowPda,
          payer: toAddress(payer.publicKey),
          acceptedMint: toAddress(usdcMint),
          ataProgram: toAddress(ATA_PROGRAM_ID),
          investors: [
            {
              investmentAccount: invPda,
              investorTokenAccount: toAddress(investorToken),
              investor: toAddress(investor.publicKey),
            },
          ],
          programId: PROGRAM_ID,
        }),
      ],
      [payer],
    );

    // Verify refund
    const balanceAfter = getTokenBalance(svm, investorToken);
    expect(balanceAfter).toBe(balanceBefore + 10_000_000n);

    const invRefunded = decodeInvestment(getAccountData(svm, invPda));
    expect(invRefunded.isRefunded).toBe(true);
  });

  // Second fundraising round

  it("second fundraising round on same asset", async () => {
    const [round0Pda] = await getFundraisingRoundPda(assetAddr, 0, PROGRAM_ID);
    const [escrow0Pda] = await getEscrowPda(round0Pda, PROGRAM_ID);
    const END_TIME_0 = 1_000_000n;

    // 1. Create round 0
    sendTx(
      svm,
      [
        createRound({
          config: configAddr,
          orgAccount: orgAddr,
          assetAccount: assetAddr,
          roundAccount: round0Pda,
          escrow: escrow0Pda,
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
          endTime: END_TIME_0,
          lockupEnd: 0n,
          termsHash: new Uint8Array(32),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, orgAuthority],
    );

    // Invest 100 shares in round 0
    const investorA = Keypair.generate();
    const investorAToken = fundInvestor(investorA, 200_000_000n);
    const [invAPda] = await getInvestmentPda(round0Pda, toAddress(investorA.publicKey), PROGRAM_ID);

    sendTx(
      svm,
      [
        invest({
          config: configAddr,
          roundAccount: round0Pda,
          investmentAccount: invAPda,
          escrow: escrow0Pda,
          investorTokenAccount: toAddress(investorAToken),
          investor: toAddress(investorA.publicKey),
          payer: toAddress(payer.publicKey),
          shares: 100n,
          termsHash: new Uint8Array(32),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, investorA],
    );

    // Finalize round 0
    warpPastEndTime(END_TIME_0);

    const orgTreasuryToken0 = getAtaAddress(orgAuthority.publicKey, usdcMint);

    sendTx(
      svm,
      [
        finalizeRound({
          config: configAddr,
          assetAccount: assetAddr,
          roundAccount: round0Pda,
          escrow: escrow0Pda,
          feeTreasuryToken: toAddress(feeTreasury.publicKey),
          orgTreasuryToken: toAddress(orgTreasuryToken0),
          treasuryWallet: toAddress(orgAuthority.publicKey),
          payer: toAddress(payer.publicKey),
          acceptedMint: toAddress(usdcMint),
          ataProgram: toAddress(ATA_PROGRAM_ID),
          programId: PROGRAM_ID,
        }),
      ],
      [payer],
    );

    // Mint round 0 token
    const nft0Kp = Keypair.generate();
    const [assetToken0] = await getAssetTokenPda(assetAddr, 0, PROGRAM_ID);

    sendTx(
      svm,
      [
        mintRoundTokens({
          roundAccount: round0Pda,
          assetAccount: assetAddr,
          collection: toAddress(collectionKp.publicKey),
          collectionAuthority: collAuthAddr,
          payer: toAddress(payer.publicKey),
          investors: [
            {
              investmentAccount: invAPda,
              assetTokenAccount: assetToken0,
              nft: toAddress(nft0Kp.publicKey),
              investor: toAddress(investorA.publicKey),
            },
          ],
          programId: PROGRAM_ID,
        }),
      ],
      [payer, nft0Kp],
    );

    // Verify asset is Active with roundCount=1
    const assetAfterR0 = decodeAsset(getAccountData(svm, assetAddr));
    expect(assetAfterR0.status).toBe(AssetStatus.Active);
    expect(assetAfterR0.fundraisingRoundCount).toBe(1);
    expect(assetAfterR0.mintedShares).toBe(100n);

    // 2. Create round 1 with different price
    const [round1Pda] = await getFundraisingRoundPda(assetAddr, 1, PROGRAM_ID);
    const [escrow1Pda] = await getEscrowPda(round1Pda, PROGRAM_ID);
    const END_TIME_1 = 2_000_000n;

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
          pricePerShare: 2_000_000n, // different price for round 1
          minRaise: 100_000_000n,
          maxRaise: 500_000_000_000n,
          minPerWallet: 1_000_000n,
          maxPerWallet: 250_000_000_000n,
          startTime: 0n,
          endTime: END_TIME_1,
          lockupEnd: 0n,
          termsHash: new Uint8Array(32),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, orgAuthority],
    );

    // Invest 200 shares in round 1 (200 × 2 USDC = 400 USDC)
    const investorB = Keypair.generate();
    const investorBToken = fundInvestor(investorB, 500_000_000n);
    const [invBPda] = await getInvestmentPda(round1Pda, toAddress(investorB.publicKey), PROGRAM_ID);

    sendTx(
      svm,
      [
        invest({
          config: configAddr,
          roundAccount: round1Pda,
          investmentAccount: invBPda,
          escrow: escrow1Pda,
          investorTokenAccount: toAddress(investorBToken),
          investor: toAddress(investorB.publicKey),
          payer: toAddress(payer.publicKey),
          shares: 200n,
          termsHash: new Uint8Array(32),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, investorB],
    );

    // Finalize round 1
    warpPastEndTime(END_TIME_1);

    sendTx(
      svm,
      [
        finalizeRound({
          config: configAddr,
          assetAccount: assetAddr,
          roundAccount: round1Pda,
          escrow: escrow1Pda,
          feeTreasuryToken: toAddress(feeTreasury.publicKey),
          orgTreasuryToken: toAddress(orgTreasuryToken0),
          treasuryWallet: toAddress(orgAuthority.publicKey),
          payer: toAddress(payer.publicKey),
          acceptedMint: toAddress(usdcMint),
          ataProgram: toAddress(ATA_PROGRAM_ID),
          programId: PROGRAM_ID,
        }),
      ],
      [payer],
    );

    // Mint round 1 token
    const nft1Kp = Keypair.generate();
    const [assetToken1] = await getAssetTokenPda(assetAddr, 1, PROGRAM_ID);

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
              investmentAccount: invBPda,
              assetTokenAccount: assetToken1,
              nft: toAddress(nft1Kp.publicKey),
              investor: toAddress(investorB.publicKey),
            },
          ],
          programId: PROGRAM_ID,
        }),
      ],
      [payer, nft1Kp],
    );

    // 3. Verify round 1
    const round1 = decodeFundraisingRound(getAccountData(svm, round1Pda));
    expect(round1.roundIndex).toBe(1);
    expect(round1.status).toBe(RoundStatus.Succeeded);
    expect(round1.pricePerShare).toBe(2_000_000n);
    expect(round1.sharesSold).toBe(200n);
    expect(round1.investorsSettled).toBe(1);

    // Verify asset state
    const assetFinal = decodeAsset(getAccountData(svm, assetAddr));
    expect(assetFinal.fundraisingRoundCount).toBe(2);
    expect(assetFinal.mintedShares).toBe(300n); // 100 from round 0 + 200 from round 1
    expect(assetFinal.status).toBe(AssetStatus.Active);

    // Verify round 1 token
    const token1 = decodeAssetToken(getAccountData(svm, assetToken1));
    expect(token1.shares).toBe(200n);
    expect(token1.owner).toBe(toAddress(investorB.publicKey));
    expect(token1.tokenIndex).toBe(1);
  });

  // Governance-gated fundraising─

  it("governance-gated fundraising: council DAO controls create_round", async () => {
    const GOV_PROGRAM = SPL_GOVERNANCE_PROGRAM_ID;
    const GOV_PK = new PublicKey(GOV_PROGRAM);
    const RENT_SYSVAR = address("SysvarRent111111111111111111111111111111111");

    // Phase 1: Setup──

    // a. Create council mint (decimals=0) and a dormant community mint
    const councilMint = createUsdcMint(svm, mintAuthority, 0);
    const councilMintAddr = toAddress(councilMint);
    const communityMint = createUsdcMint(svm, mintAuthority, 0);
    const communityMintAddr = toAddress(communityMint);

    // b. Create 4 council members, mint 1 council token each
    const members = Array.from({ length: 4 }, () => Keypair.generate());
    const memberTokenAccts: PublicKey[] = [];
    for (const m of members) {
      svm.airdrop(m.publicKey, BigInt(10_000_000_000));
      const ta = createTokenAccount(svm, councilMint, m.publicKey, payer);
      mintTokensTo(svm, councilMint, ta, 1n, mintAuthority);
      memberTokenAccts.push(ta);
    }

    // c. Pre-compute org PDA, realm, governance, native treasury
    const configData = decodeProtocolConfig(getAccountData(svm, configAddr));
    const nextOrgId = configData.totalOrganizations; // 1 (beforeEach created org 0)
    const [govOrgAddr] = await getOrganizationPda(nextOrgId, PROGRAM_ID);

    const realmName = "GovFundRealm";
    const [realmAddr] = await getRealmAddress(realmName, GOV_PROGRAM);
    const [communityHolding] = await getTokenHoldingAddress(realmAddr, communityMintAddr, GOV_PROGRAM);
    const [councilHolding] = await getTokenHoldingAddress(realmAddr, councilMintAddr, GOV_PROGRAM);
    const [realmConfigAddr] = await getRealmConfigAddress(realmAddr, GOV_PROGRAM);
    const [govPdaAddr] = await getGovernanceAddress(realmAddr, govOrgAddr, GOV_PROGRAM);
    const [nativeTreasuryAddr] = await getNativeTreasuryAddress(govPdaAddr, GOV_PROGRAM);

    // Pre-compute TORs for members
    const memberTors: Address[] = [];
    for (const m of members) {
      const [tor] = await getTokenOwnerRecordAddress(
        realmAddr, councilMintAddr, toAddress(m.publicKey), GOV_PROGRAM,
      );
      memberTors.push(tor);
    }

    const realmAuthority = Keypair.generate();
    svm.airdrop(realmAuthority.publicKey, BigInt(10_000_000_000));

    // Phase 2: Register org + create realm─

    // d. Register org with governance PDA as authority
    sendTx(
      svm,
      [
        registerOrganization({
          config: configAddr,
          orgAccount: govOrgAddr,
          operator: toAddress(operator.publicKey),
          payer: toAddress(payer.publicKey),
          authority: govPdaAddr, // governance PDA is the authority
          name: "GovOrg",
          registrationNumber: "GOV-001",
          country: "US",
          programId: PROGRAM_ID,
        }),
      ],
      [payer, operator],
    );

    // e. createOrgRealm — creates realm + governance + treasury
    const govConfig: GovernanceConfig = {
      communityVoteThreshold: { type: VoteThresholdType.Disabled, value: 0 },
      minCommunityWeightToCreateProposal: BigInt("18446744073709551615"),
      minTransactionHoldUpTime: 0,
      votingBaseTime: 100000,
      communityVoteTipping: 0,
      councilVoteThreshold: { type: VoteThresholdType.YesVotePercentage, value: 60 },
      councilVetoVoteThreshold: { type: VoteThresholdType.Disabled, value: 0 },
      minCouncilWeightToCreateProposal: 1n,
      councilVoteTipping: 1, // Early tipping
      communityVetoVoteThreshold: { type: VoteThresholdType.Disabled, value: 0 },
      votingCoolOffTime: 0,
      depositExemptProposalCount: 10,
    };

    sendTx(
      svm,
      [
        createOrgRealm({
          config: configAddr,
          orgAccount: govOrgAddr,
          realm: realmAddr,
          realmAuthority: toAddress(realmAuthority.publicKey),
          councilMint: councilMintAddr,
          councilHolding,
          communityMint: communityMintAddr,
          communityHolding,
          realmConfig: realmConfigAddr,
          authority: toAddress(operator.publicKey),
          payer: toAddress(payer.publicKey),
          governanceProgram: GOV_PROGRAM,
          splTokenProgram: toAddress(TOKEN_PROGRAM_ID),
          rentSysvar: RENT_SYSVAR,
          voterWeightAddin: PROGRAM_ID,
          maxVoterWeightAddin: PROGRAM_ID,
          governance: govPdaAddr,
          nativeTreasury: nativeTreasuryAddr,
          realmName,
          governanceConfigData: encodeGovernanceConfig(govConfig),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, operator, realmAuthority],
    );

    // Deposit governing tokens for each member (separate txs due to tx size)
    for (let i = 0; i < 4; i++) {
      sendTx(
        svm,
        [
          depositGoverningTokens({
            realm: realmAddr,
            governingTokenHolding: councilHolding,
            governingTokenSource: toAddress(memberTokenAccts[i]),
            governingTokenOwner: toAddress(members[i].publicKey),
            governingTokenTransferAuthority: toAddress(members[i].publicKey),
            tokenOwnerRecord: memberTors[i],
            payer: toAddress(payer.publicKey),
            splTokenProgram: toAddress(TOKEN_PROGRAM_ID),
            realmConfig: realmConfigAddr,
            amount: 1n,
            programId: GOV_PROGRAM,
          }),
        ],
        [payer, members[i]],
      );
    }

    // f. Add accepted mint via operator
    sendTx(
      svm,
      [
        updateOrgAddMint({
          config: configAddr,
          orgAccount: govOrgAddr,
          authority: toAddress(operator.publicKey),
          mint: toAddress(usdcMint),
          programId: PROGRAM_ID,
        }),
      ],
      [operator],
    );

    // Helper: execute an instruction through governance proposal─

    let proposalCount = 0;
    async function executeViaGovernance(
      embeddedIx: ReturnType<typeof createRound>,
      extraSigners: Keypair[] = [],
    ) {
      const index = proposalCount++;
      const [proposalSeedAddr] = await getProposalSeedPda(govPdaAddr, index, PROGRAM_ID);
      const [proposalAddr] = await getProposalAddress(
        govPdaAddr, councilMintAddr, proposalSeedAddr, GOV_PROGRAM,
      );

      // Create proposal
      sendTx(
        svm,
        [
          createProposal({
            realm: realmAddr,
            proposal: proposalAddr,
            governance: govPdaAddr,
            tokenOwnerRecord: memberTors[0],
            governingTokenMint: councilMintAddr,
            governanceAuthority: toAddress(members[0].publicKey),
            payer: toAddress(payer.publicKey),
            realmConfig: realmConfigAddr,
            name: `Proposal ${index}`,
            descriptionLink: "",
            options: [{ label: "Approve" }],
            useDenyOption: true,
            proposalSeed: proposalSeedAddr,
            programId: GOV_PROGRAM,
          }),
        ],
        [payer, members[0]],
      );

      // Insert transaction
      const [proposalTxAddr] = await getProposalTransactionAddress(
        proposalAddr, 0, 0, GOV_PROGRAM,
      );
      sendTx(
        svm,
        [
          insertTransaction({
            governance: govPdaAddr,
            proposal: proposalAddr,
            tokenOwnerRecord: memberTors[0],
            governanceAuthority: toAddress(members[0].publicKey),
            proposalTransaction: proposalTxAddr,
            payer: toAddress(payer.publicKey),
            optionIndex: 0,
            instructionIndex: 0,
            instructions: [embeddedIx],
            programId: GOV_PROGRAM,
          }),
        ],
        [payer, members[0]],
      );

      // Sign off proposal (moves Draft → Voting)
      sendTx(
        svm,
        [
          signOffProposal({
            realm: realmAddr,
            governance: govPdaAddr,
            proposal: proposalAddr,
            signatory: toAddress(members[0].publicKey),
            signatoryRecord: memberTors[0],
            programId: GOV_PROGRAM,
          }),
        ],
        [members[0]],
      );

      // Council members vote until early tipping triggers
      for (let i = 0; i < 4; i++) {
        // Check if proposal already tipped (e.g. early tipping after enough votes)
        const pAcct = svm.getAccount(new PublicKey(proposalAddr));
        if (pAcct!.data[65] !== 2) break; // no longer Voting

        const [voteRecordAddr] = await getVoteRecordAddress(
          proposalAddr, memberTors[i], GOV_PROGRAM,
        );
        sendTx(
          svm,
          [
            castVote({
              realm: realmAddr,
              governance: govPdaAddr,
              proposal: proposalAddr,
              proposalTokenOwnerRecord: memberTors[0],
              voterTokenOwnerRecord: memberTors[i],
              governanceAuthority: toAddress(members[i].publicKey),
              voteRecord: voteRecordAddr,
              governingTokenMint: councilMintAddr,
              payer: toAddress(payer.publicKey),
              realmConfig: realmConfigAddr,
              vote: VoteChoice.Approve,
              programId: GOV_PROGRAM,
            }),
          ],
          [payer, members[i]],
        );
      }

      // Verify proposal succeeded (tipped early)
      const finalState = svm.getAccount(new PublicKey(proposalAddr))!.data[65];
      if (finalState !== 3) {
        throw new Error(`Proposal did not succeed, state=${finalState}`);
      }

      // Warp clock past voting_completed_at + hold_up_time so execution is allowed
      const clock = svm.getClock();
      clock.unixTimestamp = clock.unixTimestamp + 1n;
      svm.setClock(clock);

      // Execute transaction — governance PDA signs via invoke_signed
      // Downgrade governance PDA from signer to non-signer (invoke_signed handles it)
      const ixAccounts = embeddedIx.accounts!.map((a) => {
        if (a.address === govPdaAddr) {
          const role =
            a.role === AccountRole.READONLY_SIGNER ? AccountRole.READONLY :
            a.role === AccountRole.WRITABLE_SIGNER ? AccountRole.WRITABLE :
            a.role;
          return { address: a.address, role };
        }
        return { address: a.address, role: a.role };
      });
      // Append the invoked program at the end
      ixAccounts.push({ address: embeddedIx.programAddress, role: AccountRole.READONLY });

      sendTx(
        svm,
        [
          executeTransaction({
            governance: govPdaAddr,
            proposal: proposalAddr,
            proposalTransaction: proposalTxAddr,
            instructionAccounts: ixAccounts,
            programId: GOV_PROGRAM,
          }),
        ],
        [payer, ...extraSigners],
      );
    }

    // Phase 2b: Init asset via governance

    const govCollectionKp = Keypair.generate();
    const [govAssetAddr] = await getAssetPda(govOrgAddr, 0, PROGRAM_ID);
    const [govCollAuthAddr] = await getCollectionAuthorityPda(
      toAddress(govCollectionKp.publicKey), PROGRAM_ID,
    );

    await executeViaGovernance(
      initAsset({
        config: configAddr,
        orgAccount: govOrgAddr,
        assetAccount: govAssetAddr,
        collection: toAddress(govCollectionKp.publicKey),
        collectionAuthority: govCollAuthAddr,
        authority: govPdaAddr,
        payer: toAddress(payer.publicKey),
        totalShares: 1_000_000n,
        pricePerShare: 1_000_000n,
        acceptedMint: toAddress(usdcMint),
        maturityDate: 0n,
        maturityGracePeriod: 0n,
        transferCooldown: 0n,
        maxHolders: 0,
        name: "GovAsset",
        uri: "https://example.com/gov-asset.json",
        programId: PROGRAM_ID,
      }),
      [govCollectionKp], // collection keypair must sign outer tx too
    );

    // Verify asset created
    const govAsset = decodeAsset(getAccountData(svm, govAssetAddr));
    expect(govAsset.status).toBe(AssetStatus.Draft);

    // Phase 3: DAO-controlled create_round

    const [govRoundPda] = await getFundraisingRoundPda(govAssetAddr, 0, PROGRAM_ID);
    const [govEscrowPda] = await getEscrowPda(govRoundPda, PROGRAM_ID);
    const GOV_END_TIME = 2_000_000n;

    await executeViaGovernance(
      createRound({
        config: configAddr,
        orgAccount: govOrgAddr,
        assetAccount: govAssetAddr,
        roundAccount: govRoundPda,
        escrow: govEscrowPda,
        acceptedMint: toAddress(usdcMint),
        authority: govPdaAddr,
        payer: toAddress(payer.publicKey),
        sharesOffered: 500_000n,
        pricePerShare: 1_000_000n,
        minRaise: 100_000_000n,
        maxRaise: 500_000_000_000n,
        minPerWallet: 1_000_000n,
        maxPerWallet: 250_000_000_000n,
        startTime: 0n,
        endTime: GOV_END_TIME,
        lockupEnd: 0n,
        termsHash: new Uint8Array(32),
        programId: PROGRAM_ID,
      }),
    );

    // Verify round created
    const round = decodeFundraisingRound(getAccountData(svm, govRoundPda));
    expect(round.accountKey).toBe(AccountKey.FundraisingRound);
    expect(round.status).toBe(RoundStatus.Active);
    expect(round.sharesOffered).toBe(500_000n);

    // Phase 4: Normal fundraising continues 

    // r. invest
    const govInvestor = Keypair.generate();
    svm.airdrop(govInvestor.publicKey, BigInt(10_000_000_000));
    const govInvestorToken = createTokenAccount(svm, usdcMint, govInvestor.publicKey, payer);
    mintTokensTo(svm, usdcMint, govInvestorToken, 200_000_000n, mintAuthority);
    const [govInvPda] = await getInvestmentPda(
      govRoundPda, toAddress(govInvestor.publicKey), PROGRAM_ID,
    );

    sendTx(
      svm,
      [
        invest({
          config: configAddr,
          roundAccount: govRoundPda,
          investmentAccount: govInvPda,
          escrow: govEscrowPda,
          investorTokenAccount: toAddress(govInvestorToken),
          investor: toAddress(govInvestor.publicKey),
          payer: toAddress(payer.publicKey),
          shares: 100n,
          termsHash: new Uint8Array(32),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, govInvestor],
    );

    // s. finalize round (advance clock past end_time)
    warpPastEndTime(GOV_END_TIME);

    const govOrgTreasuryToken = getAtaAddress(new PublicKey(govPdaAddr), usdcMint);

    sendTx(
      svm,
      [
        finalizeRound({
          config: configAddr,
          assetAccount: govAssetAddr,
          roundAccount: govRoundPda,
          escrow: govEscrowPda,
          feeTreasuryToken: toAddress(feeTreasury.publicKey),
          orgTreasuryToken: toAddress(govOrgTreasuryToken),
          treasuryWallet: govPdaAddr,
          payer: toAddress(payer.publicKey),
          acceptedMint: toAddress(usdcMint),
          ataProgram: toAddress(ATA_PROGRAM_ID),
          programId: PROGRAM_ID,
        }),
      ],
      [payer],
    );

    const roundFinalized = decodeFundraisingRound(getAccountData(svm, govRoundPda));
    expect(roundFinalized.status).toBe(RoundStatus.Succeeded);

    // t. mint tokens
    const govNftKp = Keypair.generate();
    const [govAssetTokenPda] = await getAssetTokenPda(govAssetAddr, 0, PROGRAM_ID);

    sendTx(
      svm,
      [
        mintRoundTokens({
          roundAccount: govRoundPda,
          assetAccount: govAssetAddr,
          collection: toAddress(govCollectionKp.publicKey),
          collectionAuthority: govCollAuthAddr,
          payer: toAddress(payer.publicKey),
          investors: [
            {
              investmentAccount: govInvPda,
              assetTokenAccount: govAssetTokenPda,
              nft: toAddress(govNftKp.publicKey),
              investor: toAddress(govInvestor.publicKey),
            },
          ],
          programId: PROGRAM_ID,
        }),
      ],
      [payer, govNftKp],
    );

    // Verify───

    // Investor received minted token
    const assetToken = decodeAssetToken(getAccountData(svm, govAssetTokenPda));
    expect(assetToken.shares).toBe(100n);
    expect(assetToken.owner).toBe(toAddress(govInvestor.publicKey));

    // Asset minted shares updated
    const assetFinal = decodeAsset(getAccountData(svm, govAssetAddr));
    expect(assetFinal.mintedShares).toBe(100n);

    // Round investors settled
    const roundFinal = decodeFundraisingRound(getAccountData(svm, govRoundPda));
    expect(roundFinal.investorsSettled).toBe(1);
  });

  // Asset governance native treasury routing

  it("routes funds to asset governance native treasury", async () => {
    const GOV_PROGRAM = SPL_GOVERNANCE_PROGRAM_ID;
    const RENT_SYSVAR = address("SysvarRent111111111111111111111111111111111");

    // 1. Set up council mint + one council member
    const councilMint = createUsdcMint(svm, mintAuthority, 0);
    const councilMintAddr = toAddress(councilMint);
    const communityMint = createUsdcMint(svm, mintAuthority, 0);
    const communityMintAddr = toAddress(communityMint);

    const councilMember = Keypair.generate();
    svm.airdrop(councilMember.publicKey, BigInt(10_000_000_000));
    const councilTokenAcct = createTokenAccount(svm, councilMint, councilMember.publicKey, payer);
    mintTokensTo(svm, councilMint, councilTokenAcct, 1n, mintAuthority);

    // 2. Create org realm for the default org
    const realmName = "AssetGovTreasuryRealm";
    const [realmAddr] = await getRealmAddress(realmName, GOV_PROGRAM);
    const [communityHolding] = await getTokenHoldingAddress(realmAddr, communityMintAddr, GOV_PROGRAM);
    const [councilHolding] = await getTokenHoldingAddress(realmAddr, councilMintAddr, GOV_PROGRAM);
    const [realmConfigAddr] = await getRealmConfigAddress(realmAddr, GOV_PROGRAM);
    const [orgGovAddr] = await getGovernanceAddress(realmAddr, orgAddr, GOV_PROGRAM);
    const [orgNativeTreasuryAddr] = await getNativeTreasuryAddress(orgGovAddr, GOV_PROGRAM);

    const [memberTor] = await getTokenOwnerRecordAddress(
      realmAddr, councilMintAddr, toAddress(councilMember.publicKey), GOV_PROGRAM,
    );

    const realmAuthority = Keypair.generate();
    svm.airdrop(realmAuthority.publicKey, BigInt(10_000_000_000));

    const govConfig: GovernanceConfig = {
      communityVoteThreshold: { type: VoteThresholdType.Disabled, value: 0 },
      minCommunityWeightToCreateProposal: BigInt("18446744073709551615"),
      minTransactionHoldUpTime: 0,
      votingBaseTime: 100000,
      communityVoteTipping: 0,
      councilVoteThreshold: { type: VoteThresholdType.YesVotePercentage, value: 60 },
      councilVetoVoteThreshold: { type: VoteThresholdType.Disabled, value: 0 },
      minCouncilWeightToCreateProposal: 1n,
      councilVoteTipping: 1,
      communityVetoVoteThreshold: { type: VoteThresholdType.Disabled, value: 0 },
      votingCoolOffTime: 0,
      depositExemptProposalCount: 10,
    };

    sendTx(
      svm,
      [
        createOrgRealm({
          config: configAddr,
          orgAccount: orgAddr,
          realm: realmAddr,
          realmAuthority: toAddress(realmAuthority.publicKey),
          councilMint: councilMintAddr,
          councilHolding,
          communityMint: communityMintAddr,
          communityHolding,
          realmConfig: realmConfigAddr,
          authority: toAddress(orgAuthority.publicKey),
          payer: toAddress(payer.publicKey),
          governanceProgram: GOV_PROGRAM,
          splTokenProgram: toAddress(TOKEN_PROGRAM_ID),
          rentSysvar: RENT_SYSVAR,
          voterWeightAddin: PROGRAM_ID,
          maxVoterWeightAddin: PROGRAM_ID,
          governance: orgGovAddr,
          nativeTreasury: orgNativeTreasuryAddr,
          realmName,
          governanceConfigData: encodeGovernanceConfig(govConfig),
          members: [{
            tokenSource: toAddress(councilTokenAcct),
            wallet: toAddress(councilMember.publicKey),
            tokenOwnerRecord: memberTor,
          }],
          programId: PROGRAM_ID,
        }),
      ],
      [payer, orgAuthority, realmAuthority, councilMember],
    );

    // 3. Create asset governance (sets native_treasury on the asset)
    const [assetGovAddr] = await getGovernanceAddress(realmAddr, assetAddr, GOV_PROGRAM);
    const [assetNativeTreasuryAddr] = await getNativeTreasuryAddress(assetGovAddr, GOV_PROGRAM);

    const assetGovConfig: GovernanceConfig = {
      communityVoteThreshold: { type: VoteThresholdType.YesVotePercentage, value: 60 },
      minCommunityWeightToCreateProposal: 1n,
      minTransactionHoldUpTime: 0,
      votingBaseTime: 3600,
      communityVoteTipping: 0,
      councilVoteThreshold: { type: VoteThresholdType.YesVotePercentage, value: 60 },
      councilVetoVoteThreshold: { type: VoteThresholdType.YesVotePercentage, value: 60 },
      minCouncilWeightToCreateProposal: 1n,
      councilVoteTipping: 0,
      communityVetoVoteThreshold: { type: VoteThresholdType.Disabled, value: 0 },
      votingCoolOffTime: 0,
      depositExemptProposalCount: 10,
    };

    sendTx(
      svm,
      [
        createAssetGovernance({
          config: configAddr,
          organization: orgAddr,
          asset: assetAddr,
          authority: toAddress(orgAuthority.publicKey),
          realm: realmAddr,
          governance: assetGovAddr,
          tokenOwnerRecord: memberTor,
          governanceAuthority: toAddress(realmAuthority.publicKey),
          realmConfig: realmConfigAddr,
          payer: toAddress(payer.publicKey),
          governanceProgram: GOV_PROGRAM,
          nativeTreasury: assetNativeTreasuryAddr,
          governanceConfigData: encodeGovernanceConfig(assetGovConfig),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, realmAuthority, orgAuthority],
    );

    // 4. Verify asset.native_treasury is set
    const assetAfterGov = decodeAsset(getAccountData(svm, assetAddr));
    expect(assetAfterGov.nativeTreasury).toBe(assetNativeTreasuryAddr);

    // 5. Create round → verify round.treasury = native_treasury
    const [roundPda] = await getFundraisingRoundPda(assetAddr, 0, PROGRAM_ID);
    const [escrowPda] = await getEscrowPda(roundPda, PROGRAM_ID);
    const END_TIME = 3_000_000n;

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
          sharesOffered: 100n,
          pricePerShare: 1_000_000n,
          minRaise: 1n,
          maxRaise: 1_000_000_000n,
          minPerWallet: 0n,
          maxPerWallet: 0n,
          startTime: 0n,
          endTime: END_TIME,
          lockupEnd: 0n,
          termsHash: new Uint8Array(32),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, orgAuthority],
    );

    const round = decodeFundraisingRound(getAccountData(svm, roundPda));
    expect(round.treasury).toBe(assetNativeTreasuryAddr);

    // 6. Invest
    const investor = Keypair.generate();
    const investorToken = fundInvestor(investor, 100_000_000n);
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
          shares: 10n,
          termsHash: new Uint8Array(32),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, investor],
    );

    // 7. Finalize with treasuryWallet = native treasury
    warpPastEndTime(END_TIME);

    const treasuryTokenAta = getAtaAddress(new PublicKey(assetNativeTreasuryAddr), usdcMint);

    sendTx(
      svm,
      [
        finalizeRound({
          config: configAddr,
          assetAccount: assetAddr,
          roundAccount: roundPda,
          escrow: escrowPda,
          feeTreasuryToken: toAddress(feeTreasury.publicKey),
          orgTreasuryToken: toAddress(treasuryTokenAta),
          treasuryWallet: assetNativeTreasuryAddr,
          payer: toAddress(payer.publicKey),
          acceptedMint: toAddress(usdcMint),
          ataProgram: toAddress(ATA_PROGRAM_ID),
          programId: PROGRAM_ID,
        }),
      ],
      [payer],
    );

    // 8. Verify
    const roundFinalized = decodeFundraisingRound(getAccountData(svm, roundPda));
    expect(roundFinalized.status).toBe(RoundStatus.Succeeded);

    // Funds arrived at native treasury ATA (10 USDC - 1% fee = 9.9 USDC)
    const treasuryBalance = getTokenBalance(svm, treasuryTokenAta);
    expect(treasuryBalance).toBe(9_900_000n);

    // Fee went to fee treasury
    const feeBalance = getTokenBalance(svm, feeTreasury.publicKey);
    expect(feeBalance).toBe(100_000n);
  });

  // Failure tests───

  describe("create_round failures", () => {
    it("rejects when asset is already in Fundraising status", async () => {
      const [roundPda] = await getFundraisingRoundPda(assetAddr, 0, PROGRAM_ID);
      const [escrowPda] = await getEscrowPda(roundPda, PROGRAM_ID);

      // Create first round → asset becomes Fundraising
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
            sharesOffered: 100n,
            pricePerShare: 1_000_000n,
            minRaise: 1n,
            maxRaise: 1_000_000_000n,
            minPerWallet: 0n,
            maxPerWallet: 0n,
            startTime: 0n,
            endTime: 1_000_000n,
            lockupEnd: 0n,
            termsHash: new Uint8Array(32),
            programId: PROGRAM_ID,
          }),
        ],
        [payer, orgAuthority],
      );

      // Second create_round should fail (asset is Fundraising, not Draft/Active)
      const [round1Pda] = await getFundraisingRoundPda(assetAddr, 1, PROGRAM_ID);
      const [escrow1Pda] = await getEscrowPda(round1Pda, PROGRAM_ID);

      sendTxExpectFail(
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
            sharesOffered: 100n,
            pricePerShare: 1_000_000n,
            minRaise: 1n,
            maxRaise: 1_000_000_000n,
            minPerWallet: 0n,
            maxPerWallet: 0n,
            startTime: 0n,
            endTime: 1_000_000n,
            lockupEnd: 0n,
            termsHash: new Uint8Array(32),
            programId: PROGRAM_ID,
          }),
        ],
        [payer, orgAuthority],
      );
    });

    it("rejects wrong authority", async () => {
      const [roundPda] = await getFundraisingRoundPda(assetAddr, 0, PROGRAM_ID);
      const [escrowPda] = await getEscrowPda(roundPda, PROGRAM_ID);
      const wrongAuth = Keypair.generate();
      svm.airdrop(wrongAuth.publicKey, BigInt(1_000_000_000));

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
            authority: toAddress(wrongAuth.publicKey),
            payer: toAddress(payer.publicKey),
            sharesOffered: 100n,
            pricePerShare: 1_000_000n,
            minRaise: 1n,
            maxRaise: 1_000_000_000n,
            minPerWallet: 0n,
            maxPerWallet: 0n,
            startTime: 0n,
            endTime: 1_000_000n,
            lockupEnd: 0n,
            termsHash: new Uint8Array(32),
            programId: PROGRAM_ID,
          }),
        ],
        [payer, wrongAuth],
      );
    });

    it("rejects shares_offered = 0", async () => {
      const [roundPda] = await getFundraisingRoundPda(assetAddr, 0, PROGRAM_ID);
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
            sharesOffered: 0n,
            pricePerShare: 1_000_000n,
            minRaise: 1n,
            maxRaise: 1_000_000_000n,
            minPerWallet: 0n,
            maxPerWallet: 0n,
            startTime: 0n,
            endTime: 1_000_000n,
            lockupEnd: 0n,
            termsHash: new Uint8Array(32),
            programId: PROGRAM_ID,
          }),
        ],
        [payer, orgAuthority],
      );
    });

    it("rejects price_per_share = 0", async () => {
      const [roundPda] = await getFundraisingRoundPda(assetAddr, 0, PROGRAM_ID);
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
            sharesOffered: 100n,
            pricePerShare: 0n,
            minRaise: 1n,
            maxRaise: 1_000_000_000n,
            minPerWallet: 0n,
            maxPerWallet: 0n,
            startTime: 0n,
            endTime: 1_000_000n,
            lockupEnd: 0n,
            termsHash: new Uint8Array(32),
            programId: PROGRAM_ID,
          }),
        ],
        [payer, orgAuthority],
      );
    });

    it("rejects min_raise > max_raise", async () => {
      const [roundPda] = await getFundraisingRoundPda(assetAddr, 0, PROGRAM_ID);
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
            sharesOffered: 100n,
            pricePerShare: 1_000_000n,
            minRaise: 1_000_000_000n,
            maxRaise: 100n, // less than minRaise
            minPerWallet: 0n,
            maxPerWallet: 0n,
            startTime: 0n,
            endTime: 1_000_000n,
            lockupEnd: 0n,
            termsHash: new Uint8Array(32),
            programId: PROGRAM_ID,
          }),
        ],
        [payer, orgAuthority],
      );
    });

    it("rejects start_time >= end_time", async () => {
      const [roundPda] = await getFundraisingRoundPda(assetAddr, 0, PROGRAM_ID);
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
            sharesOffered: 100n,
            pricePerShare: 1_000_000n,
            minRaise: 1n,
            maxRaise: 1_000_000_000n,
            minPerWallet: 0n,
            maxPerWallet: 0n,
            startTime: 1_000_000n,
            endTime: 1_000_000n, // equal to start
            lockupEnd: 0n,
            termsHash: new Uint8Array(32),
            programId: PROGRAM_ID,
          }),
        ],
        [payer, orgAuthority],
      );
    });

    it("rejects shares_offered exceeding available shares", async () => {
      const [roundPda] = await getFundraisingRoundPda(assetAddr, 0, PROGRAM_ID);
      const [escrowPda] = await getEscrowPda(roundPda, PROGRAM_ID);

      // Asset has 1_000_000 total shares, 0 minted — offering more than total
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
            sharesOffered: 1_000_001n, // 1 more than total
            pricePerShare: 1_000_000n,
            minRaise: 1n,
            maxRaise: 2_000_000_000_000n,
            minPerWallet: 0n,
            maxPerWallet: 0n,
            startTime: 0n,
            endTime: 1_000_000n,
            lockupEnd: 0n,
            termsHash: new Uint8Array(32),
            programId: PROGRAM_ID,
          }),
        ],
        [payer, orgAuthority],
      );
    });

    it("rejects min_per_wallet > max_per_wallet when max != 0", async () => {
      const [roundPda] = await getFundraisingRoundPda(assetAddr, 0, PROGRAM_ID);
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
            sharesOffered: 100n,
            pricePerShare: 1_000_000n,
            minRaise: 1n,
            maxRaise: 1_000_000_000n,
            minPerWallet: 1_000_000_000n,
            maxPerWallet: 1_000_000n, // less than min
            startTime: 0n,
            endTime: 1_000_000n,
            lockupEnd: 0n,
            termsHash: new Uint8Array(32),
            programId: PROGRAM_ID,
          }),
        ],
        [payer, orgAuthority],
      );
    });
  });

  describe("invest failures", () => {
    let roundPda: Address;
    let escrowPda: Address;
    const END_TIME = 1_000_000n;
    const START_TIME = 500n;

    beforeEach(async () => {
      [roundPda] = await getFundraisingRoundPda(assetAddr, 0, PROGRAM_ID);
      [escrowPda] = await getEscrowPda(roundPda, PROGRAM_ID);

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
            sharesOffered: 100n,
            pricePerShare: 1_000_000n,
            minRaise: 1n,
            maxRaise: 200_000_000n, // 200 USDC max
            minPerWallet: 10_000_000n, // 10 USDC min
            maxPerWallet: 50_000_000n, // 50 USDC max
            startTime: START_TIME,
            endTime: END_TIME,
            lockupEnd: 0n,
            termsHash: new Uint8Array(32),
            programId: PROGRAM_ID,
          }),
        ],
        [payer, orgAuthority],
      );

      // Warp past start time so most tests can invest
      const clock = svm.getClock();
      clock.unixTimestamp = START_TIME + 1n;
      svm.setClock(clock);
    });

    it("rejects invest before start_time", async () => {
      // Reset clock to before start
      const clock = svm.getClock();
      clock.unixTimestamp = START_TIME - 1n;
      svm.setClock(clock);

      const investor = Keypair.generate();
      const investorToken = fundInvestor(investor, 100_000_000n);
      const [invPda] = await getInvestmentPda(roundPda, toAddress(investor.publicKey), PROGRAM_ID);

      sendTxExpectFail(
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
            shares: 20n,
            termsHash: new Uint8Array(32),
            programId: PROGRAM_ID,
          }),
        ],
        [payer, investor],
      );
    });

    it("rejects invest after end_time", async () => {
      warpPastEndTime(END_TIME);

      const investor = Keypair.generate();
      const investorToken = fundInvestor(investor, 100_000_000n);
      const [invPda] = await getInvestmentPda(roundPda, toAddress(investor.publicKey), PROGRAM_ID);

      sendTxExpectFail(
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
            shares: 20n,
            termsHash: new Uint8Array(32),
            programId: PROGRAM_ID,
          }),
        ],
        [payer, investor],
      );
    });

    it("rejects zero shares", async () => {
      const investor = Keypair.generate();
      const investorToken = fundInvestor(investor, 100_000_000n);
      const [invPda] = await getInvestmentPda(roundPda, toAddress(investor.publicKey), PROGRAM_ID);

      sendTxExpectFail(
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
            shares: 0n,
            termsHash: new Uint8Array(32),
            programId: PROGRAM_ID,
          }),
        ],
        [payer, investor],
      );
    });

    it("rejects shares exceeding offered", async () => {
      const investor = Keypair.generate();
      const investorToken = fundInvestor(investor, 500_000_000n);
      const [invPda] = await getInvestmentPda(roundPda, toAddress(investor.publicKey), PROGRAM_ID);

      // Round offers 100 shares, try to buy 101
      sendTxExpectFail(
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
            shares: 101n,
            termsHash: new Uint8Array(32),
            programId: PROGRAM_ID,
          }),
        ],
        [payer, investor],
      );
    });

    it("rejects investment below min_per_wallet", async () => {
      const investor = Keypair.generate();
      const investorToken = fundInvestor(investor, 100_000_000n);
      const [invPda] = await getInvestmentPda(roundPda, toAddress(investor.publicKey), PROGRAM_ID);

      // min_per_wallet = 10 USDC (10_000_000), buying 5 shares = 5 USDC → below
      sendTxExpectFail(
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
            shares: 5n, // 5 USDC < 10 USDC min
            termsHash: new Uint8Array(32),
            programId: PROGRAM_ID,
          }),
        ],
        [payer, investor],
      );
    });

    it("rejects investment above max_per_wallet", async () => {
      const investor = Keypair.generate();
      const investorToken = fundInvestor(investor, 200_000_000n);
      const [invPda] = await getInvestmentPda(roundPda, toAddress(investor.publicKey), PROGRAM_ID);

      // max_per_wallet = 50 USDC (50_000_000), buying 51 shares = 51 USDC → above
      sendTxExpectFail(
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
            shares: 51n, // 51 USDC > 50 USDC max
            termsHash: new Uint8Array(32),
            programId: PROGRAM_ID,
          }),
        ],
        [payer, investor],
      );
    });

    it("rejects additive investment that exceeds max_per_wallet", async () => {
      const investor = Keypair.generate();
      const investorToken = fundInvestor(investor, 200_000_000n);
      const [invPda] = await getInvestmentPda(roundPda, toAddress(investor.publicKey), PROGRAM_ID);

      // First invest 40 shares = 40 USDC (within 50 max)
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
            shares: 40n,
            termsHash: new Uint8Array(32),
            programId: PROGRAM_ID,
          }),
        ],
        [payer, investor],
      );

      // Second invest 11 shares = 11 USDC → total 51 USDC > 50 max
      sendTxExpectFail(
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
            shares: 11n,
            termsHash: new Uint8Array(32),
            programId: PROGRAM_ID,
          }),
        ],
        [payer, investor],
      );
    });
  });

  describe("finalize_round failures", () => {
    it("rejects finalize before end_time", async () => {
      const [roundPda] = await getFundraisingRoundPda(assetAddr, 0, PROGRAM_ID);
      const [escrowPda] = await getEscrowPda(roundPda, PROGRAM_ID);

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
            sharesOffered: 100n,
            pricePerShare: 1_000_000n,
            minRaise: 1n,
            maxRaise: 1_000_000_000n,
            minPerWallet: 0n,
            maxPerWallet: 0n,
            startTime: 0n,
            endTime: 9_999_999_999n,
            lockupEnd: 0n,
            termsHash: new Uint8Array(32),
            programId: PROGRAM_ID,
          }),
        ],
        [payer, orgAuthority],
      );

      const orgTreasuryToken = getAtaAddress(orgAuthority.publicKey, usdcMint);

      // Try to finalize while round still active (before end_time)
      sendTxExpectFail(
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
    });

    it("rejects double finalize", async () => {
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
            sharesOffered: 100n,
            pricePerShare: 1_000_000n,
            minRaise: 1n,
            maxRaise: 1_000_000_000n,
            minPerWallet: 0n,
            maxPerWallet: 0n,
            startTime: 0n,
            endTime: END_TIME,
            lockupEnd: 0n,
            termsHash: new Uint8Array(32),
            programId: PROGRAM_ID,
          }),
        ],
        [payer, orgAuthority],
      );

      // Invest to meet min_raise
      const investor = Keypair.generate();
      const investorToken = fundInvestor(investor, 100_000_000n);
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
            shares: 10n,
            termsHash: new Uint8Array(32),
            programId: PROGRAM_ID,
          }),
        ],
        [payer, investor],
      );

      warpPastEndTime(END_TIME);

      const orgTreasuryToken = getAtaAddress(orgAuthority.publicKey, usdcMint);

      // First finalize succeeds
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

      // Second finalize should fail (round is Succeeded, not Active)
      sendTxExpectFail(
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
    });
  });

  describe("cancel_round failures", () => {
    it("rejects cancel by wrong authority", async () => {
      const [roundPda] = await getFundraisingRoundPda(assetAddr, 0, PROGRAM_ID);
      const [escrowPda] = await getEscrowPda(roundPda, PROGRAM_ID);

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
            sharesOffered: 100n,
            pricePerShare: 1_000_000n,
            minRaise: 1n,
            maxRaise: 1_000_000_000n,
            minPerWallet: 0n,
            maxPerWallet: 0n,
            startTime: 0n,
            endTime: 9_999_999_999n,
            lockupEnd: 0n,
            termsHash: new Uint8Array(32),
            programId: PROGRAM_ID,
          }),
        ],
        [payer, orgAuthority],
      );

      const wrongAuth = Keypair.generate();
      svm.airdrop(wrongAuth.publicKey, BigInt(1_000_000_000));

      sendTxExpectFail(
        svm,
        [
          cancelRound({
            config: configAddr,
            orgAccount: orgAddr,
            assetAccount: assetAddr,
            roundAccount: roundPda,
            authority: toAddress(wrongAuth.publicKey),
            programId: PROGRAM_ID,
          }),
        ],
        [wrongAuth],
      );
    });

    it("rejects cancel of already cancelled round", async () => {
      const [roundPda] = await getFundraisingRoundPda(assetAddr, 0, PROGRAM_ID);
      const [escrowPda] = await getEscrowPda(roundPda, PROGRAM_ID);

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
            sharesOffered: 100n,
            pricePerShare: 1_000_000n,
            minRaise: 1n,
            maxRaise: 1_000_000_000n,
            minPerWallet: 0n,
            maxPerWallet: 0n,
            startTime: 0n,
            endTime: 9_999_999_999n,
            lockupEnd: 0n,
            termsHash: new Uint8Array(32),
            programId: PROGRAM_ID,
          }),
        ],
        [payer, orgAuthority],
      );

      // Cancel once (succeeds)
      sendTx(
        svm,
        [
          cancelRound({
            config: configAddr,
            orgAccount: orgAddr,
            assetAccount: assetAddr,
            roundAccount: roundPda,
            authority: toAddress(orgAuthority.publicKey),
            programId: PROGRAM_ID,
          }),
        ],
        [orgAuthority],
      );

      // Cancel again (fails — round is Cancelled, not Active)
      sendTxExpectFail(
        svm,
        [
          cancelRound({
            config: configAddr,
            orgAccount: orgAddr,
            assetAccount: assetAddr,
            roundAccount: roundPda,
            authority: toAddress(orgAuthority.publicKey),
            programId: PROGRAM_ID,
          }),
        ],
        [orgAuthority],
      );
    });
  });

  describe("mint_round_tokens failures", () => {
    it("rejects mint when round not succeeded", async () => {
      const [roundPda] = await getFundraisingRoundPda(assetAddr, 0, PROGRAM_ID);
      const [escrowPda] = await getEscrowPda(roundPda, PROGRAM_ID);

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
            sharesOffered: 100n,
            pricePerShare: 1_000_000n,
            minRaise: 1n,
            maxRaise: 1_000_000_000n,
            minPerWallet: 0n,
            maxPerWallet: 0n,
            startTime: 0n,
            endTime: 9_999_999_999n,
            lockupEnd: 0n,
            termsHash: new Uint8Array(32),
            programId: PROGRAM_ID,
          }),
        ],
        [payer, orgAuthority],
      );

      // Invest
      const investor = Keypair.generate();
      const investorToken = fundInvestor(investor, 100_000_000n);
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
            shares: 10n,
            termsHash: new Uint8Array(32),
            programId: PROGRAM_ID,
          }),
        ],
        [payer, investor],
      );

      // Try to mint without finalizing (round still Active)
      const nftKp = Keypair.generate();
      const [assetTokenPda] = await getAssetTokenPda(assetAddr, 0, PROGRAM_ID);

      sendTxExpectFail(
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
                assetTokenAccount: assetTokenPda,
                nft: toAddress(nftKp.publicKey),
                investor: toAddress(investor.publicKey),
              },
            ],
            programId: PROGRAM_ID,
          }),
        ],
        [payer, nftKp],
      );
    });

    it("rejects double mint for same investment", async () => {
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
            sharesOffered: 100n,
            pricePerShare: 1_000_000n,
            minRaise: 1n,
            maxRaise: 1_000_000_000n,
            minPerWallet: 0n,
            maxPerWallet: 0n,
            startTime: 0n,
            endTime: END_TIME,
            lockupEnd: 0n,
            termsHash: new Uint8Array(32),
            programId: PROGRAM_ID,
          }),
        ],
        [payer, orgAuthority],
      );

      const investor = Keypair.generate();
      const investorToken = fundInvestor(investor, 100_000_000n);
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
            shares: 10n,
            termsHash: new Uint8Array(32),
            programId: PROGRAM_ID,
          }),
        ],
        [payer, investor],
      );

      warpPastEndTime(END_TIME);

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

      // First mint succeeds
      const nft1 = Keypair.generate();
      const [assetToken0] = await getAssetTokenPda(assetAddr, 0, PROGRAM_ID);

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
                assetTokenAccount: assetToken0,
                nft: toAddress(nft1.publicKey),
                investor: toAddress(investor.publicKey),
              },
            ],
            programId: PROGRAM_ID,
          }),
        ],
        [payer, nft1],
      );

      // Second mint should fail (already minted)
      const nft2 = Keypair.generate();
      const [assetToken1] = await getAssetTokenPda(assetAddr, 1, PROGRAM_ID);

      sendTxExpectFail(
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
                assetTokenAccount: assetToken1,
                nft: toAddress(nft2.publicKey),
                investor: toAddress(investor.publicKey),
              },
            ],
            programId: PROGRAM_ID,
          }),
        ],
        [payer, nft2],
      );
    });
  });

  describe("refund_investment failures", () => {
    it("rejects refund when round still active", async () => {
      const [roundPda] = await getFundraisingRoundPda(assetAddr, 0, PROGRAM_ID);
      const [escrowPda] = await getEscrowPda(roundPda, PROGRAM_ID);

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
            sharesOffered: 100n,
            pricePerShare: 1_000_000n,
            minRaise: 1n,
            maxRaise: 1_000_000_000n,
            minPerWallet: 0n,
            maxPerWallet: 0n,
            startTime: 0n,
            endTime: 9_999_999_999n,
            lockupEnd: 0n,
            termsHash: new Uint8Array(32),
            programId: PROGRAM_ID,
          }),
        ],
        [payer, orgAuthority],
      );

      const investor = Keypair.generate();
      const investorToken = fundInvestor(investor, 100_000_000n);
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
            shares: 10n,
            termsHash: new Uint8Array(32),
            programId: PROGRAM_ID,
          }),
        ],
        [payer, investor],
      );

      // Try to refund while round is still Active
      sendTxExpectFail(
        svm,
        [
          refundInvestment({
            roundAccount: roundPda,
            escrow: escrowPda,
            payer: toAddress(payer.publicKey),
            acceptedMint: toAddress(usdcMint),
            ataProgram: toAddress(ATA_PROGRAM_ID),
            investors: [
              {
                investmentAccount: invPda,
                investorTokenAccount: toAddress(investorToken),
                investor: toAddress(investor.publicKey),
              },
            ],
            programId: PROGRAM_ID,
          }),
        ],
        [payer],
      );
    });

    it("rejects double refund", async () => {
      const [roundPda] = await getFundraisingRoundPda(assetAddr, 0, PROGRAM_ID);
      const [escrowPda] = await getEscrowPda(roundPda, PROGRAM_ID);

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
            sharesOffered: 100n,
            pricePerShare: 1_000_000n,
            minRaise: 1n,
            maxRaise: 1_000_000_000n,
            minPerWallet: 0n,
            maxPerWallet: 0n,
            startTime: 0n,
            endTime: 9_999_999_999n,
            lockupEnd: 0n,
            termsHash: new Uint8Array(32),
            programId: PROGRAM_ID,
          }),
        ],
        [payer, orgAuthority],
      );

      const investor = Keypair.generate();
      const investorToken = fundInvestor(investor, 100_000_000n);
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
            shares: 10n,
            termsHash: new Uint8Array(32),
            programId: PROGRAM_ID,
          }),
        ],
        [payer, investor],
      );

      // Cancel to enable refunds
      sendTx(
        svm,
        [
          cancelRound({
            config: configAddr,
            orgAccount: orgAddr,
            assetAccount: assetAddr,
            roundAccount: roundPda,
            authority: toAddress(orgAuthority.publicKey),
            programId: PROGRAM_ID,
          }),
        ],
        [orgAuthority],
      );

      // First refund succeeds
      sendTx(
        svm,
        [
          refundInvestment({
            roundAccount: roundPda,
            escrow: escrowPda,
            payer: toAddress(payer.publicKey),
            acceptedMint: toAddress(usdcMint),
            ataProgram: toAddress(ATA_PROGRAM_ID),
            investors: [
              {
                investmentAccount: invPda,
                investorTokenAccount: toAddress(investorToken),
                investor: toAddress(investor.publicKey),
              },
            ],
            programId: PROGRAM_ID,
          }),
        ],
        [payer],
      );

      // Second refund should fail (already refunded)
      sendTxExpectFail(
        svm,
        [
          refundInvestment({
            roundAccount: roundPda,
            escrow: escrowPda,
            payer: toAddress(payer.publicKey),
            acceptedMint: toAddress(usdcMint),
            ataProgram: toAddress(ATA_PROGRAM_ID),
            investors: [
              {
                investmentAccount: invPda,
                investorTokenAccount: toAddress(investorToken),
                investor: toAddress(investor.publicKey),
              },
            ],
            programId: PROGRAM_ID,
          }),
        ],
        [payer],
      );
    });

    it("rejects refund when round succeeded", async () => {
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
            sharesOffered: 100n,
            pricePerShare: 1_000_000n,
            minRaise: 1n,
            maxRaise: 1_000_000_000n,
            minPerWallet: 0n,
            maxPerWallet: 0n,
            startTime: 0n,
            endTime: END_TIME,
            lockupEnd: 0n,
            termsHash: new Uint8Array(32),
            programId: PROGRAM_ID,
          }),
        ],
        [payer, orgAuthority],
      );

      const investor = Keypair.generate();
      const investorToken = fundInvestor(investor, 100_000_000n);
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
            shares: 10n,
            termsHash: new Uint8Array(32),
            programId: PROGRAM_ID,
          }),
        ],
        [payer, investor],
      );

      warpPastEndTime(END_TIME);

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

      // Try to refund after success (should fail — round is Succeeded, not Failed/Cancelled)
      sendTxExpectFail(
        svm,
        [
          refundInvestment({
            roundAccount: roundPda,
            escrow: escrowPda,
            payer: toAddress(payer.publicKey),
            acceptedMint: toAddress(usdcMint),
            ataProgram: toAddress(ATA_PROGRAM_ID),
            investors: [
              {
                investmentAccount: invPda,
                investorTokenAccount: toAddress(investorToken),
                investor: toAddress(investor.publicKey),
              },
            ],
            programId: PROGRAM_ID,
          }),
        ],
        [payer],
      );
    });
  });

  // T&C enforcement───

  it("terms hash mismatch rejects invest", async () => {
    const [roundPda] = await getFundraisingRoundPda(assetAddr, 0, PROGRAM_ID);
    const [escrowPda] = await getEscrowPda(roundPda, PROGRAM_ID);

    // A non-zero 32-byte terms hash for the round
    const roundTermsHash = new Uint8Array(32);
    roundTermsHash[0] = 0xab;
    roundTermsHash[1] = 0xcd;

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
          endTime: 1_000_000n,
          lockupEnd: 0n,
          termsHash: roundTermsHash,
          programId: PROGRAM_ID,
        }),
      ],
      [payer, orgAuthority],
    );

    // Invest with a DIFFERENT terms hash → should fail with TermsHashMismatch (9300)
    const investor = Keypair.generate();
    const investorToken = fundInvestor(investor, 200_000_000n);
    const [invPda] = await getInvestmentPda(roundPda, toAddress(investor.publicKey), PROGRAM_ID);

    const wrongTermsHash = new Uint8Array(32);
    wrongTermsHash[0] = 0xff; // different from roundTermsHash

    sendTxExpectFail(
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
          termsHash: wrongTermsHash,
          programId: PROGRAM_ID,
        }),
      ],
      [payer, investor],
    );
  });

  it("maturity date blocks create_round", async () => {
    // Create a NEW asset with maturityDate already in the past
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
          maturityDate: 100n,
          maturityGracePeriod: 0n,
          transferCooldown: 0n,
          maxHolders: 0,
          name: "MaturedAsset",
          uri: "https://example.com/matured.json",
          programId: PROGRAM_ID,
        }),
      ],
      [payer, orgAuthority, collectionKp2],
    );

    // Warp clock past the maturity date
    const clock = svm.getClock();
    clock.unixTimestamp = 200n;
    svm.setClock(clock);

    // Try to create a round on the matured asset → should fail with AssetMatured (9304)
    const [roundPda] = await getFundraisingRoundPda(assetPda2, 0, PROGRAM_ID);
    const [escrowPda] = await getEscrowPda(roundPda, PROGRAM_ID);

    sendTxExpectFail(
      svm,
      [
        createRound({
          config: configAddr,
          orgAccount: orgAddr,
          assetAccount: assetPda2,
          roundAccount: roundPda,
          escrow: escrowPda,
          acceptedMint: toAddress(usdcMint),
          authority: toAddress(orgAuthority.publicKey),
          payer: toAddress(payer.publicKey),
          sharesOffered: 100n,
          pricePerShare: 1_000_000n,
          minRaise: 1n,
          maxRaise: 1_000_000_000n,
          minPerWallet: 0n,
          maxPerWallet: 0n,
          startTime: 0n,
          endTime: 1_000_000n,
          lockupEnd: 0n,
          termsHash: new Uint8Array(32),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, orgAuthority],
    );
  });

  it("lockup blocks listing after round mint", async () => {
    const [roundPda] = await getFundraisingRoundPda(assetAddr, 0, PROGRAM_ID);
    const [escrowPda] = await getEscrowPda(roundPda, PROGRAM_ID);
    const END_TIME = 1_000_000n;
    const LOCKUP_END = 2_000_000n;

    // 1. Create round with a far-future lockupEnd
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
          lockupEnd: LOCKUP_END,
          termsHash: new Uint8Array(32),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, orgAuthority],
    );

    // 2. Invest
    const investor = Keypair.generate();
    const investorToken = fundInvestor(investor, 200_000_000n);
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

    // 3. Warp past end_time and finalize
    warpPastEndTime(END_TIME);

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

    // 4. Mint round tokens
    const nft = Keypair.generate();
    const [assetTokenAddr] = await getAssetTokenPda(assetAddr, 0, PROGRAM_ID);

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
              nft: toAddress(nft.publicKey),
              investor: toAddress(investor.publicKey),
            },
          ],
          programId: PROGRAM_ID,
        }),
      ],
      [payer, nft],
    );

    // 5. Try to list for sale while still in lockup → should fail with TokenLocked (9301)
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
          sharesForSale: 100n,
          pricePerShare: 2_000_000n,
          isPartial: false,
          expiry: 0n,
          programId: PROGRAM_ID,
        }),
      ],
      [payer, investor],
    );
  });
});
