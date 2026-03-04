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
import { decodeAssetToken } from "../../src/accounts/assetToken.js";
import { decodeEmergencyRecord } from "../../src/accounts/emergencyRecord.js";
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
  burnAndRemint,
  splitAndRemint,
} from "../../src/instructions/emergency.js";
import {
  getProtocolConfigPda,
  getOrganizationPda,
  getAssetPda,
  getAssetTokenPda,
  getCollectionAuthorityPda,
  getFundraisingRoundPda,
  getEscrowPda,
  getInvestmentPda,
  getEmergencyRecordPda,
} from "../../src/pdas.js";
import { AccountKey } from "../../src/constants.js";
import { decodeAssetV1 } from "../../src/external/mpl-core/accounts.js";
import { MplCoreKey, PluginType } from "../../src/external/mpl-core/constants.js";

// Constants

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

describe("Emergency Integration", () => {
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

  // Token holder whose token will be recovered
  let oldOwner: Keypair;
  let assetTokenAddr: Address;
  let oldNftKp: Keypair;

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

    // Fundraising to get a minted token

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

    oldOwner = Keypair.generate();
    svm.airdrop(oldOwner.publicKey, BigInt(10_000_000_000));
    const ownerUsdcAcct = createTokenAccount(
      svm,
      usdcMint,
      oldOwner.publicKey,
      payer,
    );
    mintTokensTo(svm, usdcMint, ownerUsdcAcct, 200_000_000n, mintAuthority);
    const [invPda] = await getInvestmentPda(
      roundPda,
      toAddress(oldOwner.publicKey),
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
          investorTokenAccount: toAddress(ownerUsdcAcct),
          investor: toAddress(oldOwner.publicKey),
          payer: toAddress(payer.publicKey),
          shares: 100n,
          termsHash: new Uint8Array(32),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, oldOwner],
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
    oldNftKp = Keypair.generate();
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
              nft: toAddress(oldNftKp.publicKey),
              investor: toAddress(oldOwner.publicKey),
            },
          ],
          programId: PROGRAM_ID,
        }),
      ],
      [payer, oldNftKp],
    );
  });

  // burn and remint

  it("burn and remint to new owner", async () => {
    // Verify old token exists
    const oldToken = decodeAssetToken(getAccountData(svm, assetTokenAddr));
    expect(oldToken.shares).toBe(100n);
    expect(oldToken.owner).toBe(toAddress(oldOwner.publicKey));

    const newOwner = Keypair.generate();
    const newNftKp = Keypair.generate();

    // collection.num_minted is currently 1 (from the initial mint)
    // After burn, num_minted stays 1 (burn decrements current_size but not num_minted... actually let me check)
    // After remint, the new token_index = collection.num_minted (after burn)
    // The new AssetToken PDA uses the new token_index

    // The new token_index will be collection.num_minted after the burn
    // For burn_and_remint, it reads collection.num_minted after the burn
    // After burning 1 NFT and it being the only one, num_minted might be 0 or 1
    // Actually, in MPL Core, num_minted tracks total ever minted (not current count)
    // So num_minted after burn = 1, and new token gets index 1
    const [newAssetTokenPda] = await getAssetTokenPda(assetAddr, 1, PROGRAM_ID);
    const [emergencyRecordPda] = await getEmergencyRecordPda(
      assetTokenAddr,
      PROGRAM_ID,
    );

    sendTx(
      svm,
      [
        burnAndRemint({
          orgAccount: orgAddr,
          assetAccount: assetAddr,
          oldAssetTokenAccount: assetTokenAddr,
          oldNft: toAddress(oldNftKp.publicKey),
          collection: toAddress(collectionKp.publicKey),
          collectionAuthority: collAuthAddr,
          newNft: toAddress(newNftKp.publicKey),
          newAssetTokenAccount: newAssetTokenPda,
          newOwner: toAddress(newOwner.publicKey),
          emergencyRecordAccount: emergencyRecordPda,
          orgAuthority: toAddress(orgAuthority.publicKey),
          payer: toAddress(payer.publicKey),
          reason: 0,
          sharesToTransfer: 0n,
          programId: PROGRAM_ID,
        }),
      ],
      [payer, orgAuthority, newNftKp],
    );

    // Verify old token shares zeroed
    const oldTokenAfter = decodeAssetToken(getAccountData(svm, assetTokenAddr));
    expect(oldTokenAfter.shares).toBe(0n);

    // Verify new token created
    const newToken = decodeAssetToken(getAccountData(svm, newAssetTokenPda));
    expect(newToken.accountKey).toBe(AccountKey.AssetToken);
    expect(newToken.shares).toBe(100n);
    expect(newToken.owner).toBe(toAddress(newOwner.publicKey));
    expect(newToken.nft).toBe(toAddress(newNftKp.publicKey));
    expect(newToken.parentToken).toBe(assetTokenAddr);
    expect(newToken.tokenIndex).toBe(1);

    // Verify new NFT created
    const nftAcct = svm.getAccount(newNftKp.publicKey);
    expect(nftAcct).not.toBeNull();
    expect(nftAcct!.data[0]).toBe(MplCoreKey.AssetV1);

    // Verify PermanentFreezeDelegate frozen on new NFT
    const nftAsset = decodeAssetV1(nftAcct!.data);
    const freezePlugin = nftAsset.plugins.find(
      (p) => p.type === PluginType.PermanentFreezeDelegate,
    );
    expect(freezePlugin).toBeDefined();
    expect((freezePlugin as { frozen: boolean }).frozen).toBe(true);

    // Verify old NFT burned (MPL Core leaves a 1-byte Uninitialized tombstone)
    const oldNftAcct = svm.getAccount(oldNftKp.publicKey);
    expect(oldNftAcct!.data[0]).toBe(MplCoreKey.Uninitialized);

    // Verify emergency record created
    const er = decodeEmergencyRecord(getAccountData(svm, emergencyRecordPda));
    expect(er.accountKey).toBe(AccountKey.EmergencyRecord);
    expect(er.asset).toBe(assetAddr);
    expect(er.oldAssetToken).toBe(assetTokenAddr);
    expect(er.oldOwner).toBe(toAddress(oldOwner.publicKey));
    expect(er.recoveryType).toBe(0); // burn_and_remint
  });

  // split and remint

  it("split and remint to multiple recipients", async () => {
    const recipientA = Keypair.generate();
    const recipientB = Keypair.generate();
    const newNftA = Keypair.generate();
    const newNftB = Keypair.generate();

    // After burn, collection.num_minted = 1 (MPL Core doesn't decrement)
    // Recipient A gets token_index = 1, Recipient B gets token_index = 2
    const [newAssetTokenA] = await getAssetTokenPda(assetAddr, 1, PROGRAM_ID);
    const [newAssetTokenB] = await getAssetTokenPda(assetAddr, 2, PROGRAM_ID);
    const [emergencyRecordPda] = await getEmergencyRecordPda(
      assetTokenAddr,
      PROGRAM_ID,
    );

    // Split 100 shares: 60 to A, 40 to B
    sendTx(
      svm,
      [
        splitAndRemint({
          orgAccount: orgAddr,
          assetAccount: assetAddr,
          oldAssetTokenAccount: assetTokenAddr,
          oldNft: toAddress(oldNftKp.publicKey),
          collection: toAddress(collectionKp.publicKey),
          collectionAuthority: collAuthAddr,
          emergencyRecordAccount: emergencyRecordPda,
          orgAuthority: toAddress(orgAuthority.publicKey),
          payer: toAddress(payer.publicKey),
          recipients: [
            {
              newNft: toAddress(newNftA.publicKey),
              newAssetTokenAccount: newAssetTokenA,
              recipient: toAddress(recipientA.publicKey),
              shares: 60n,
            },
            {
              newNft: toAddress(newNftB.publicKey),
              newAssetTokenAccount: newAssetTokenB,
              recipient: toAddress(recipientB.publicKey),
              shares: 40n,
            },
          ],
          programId: PROGRAM_ID,
        }),
      ],
      [payer, orgAuthority, newNftA, newNftB],
    );

    // Verify old token shares zeroed
    const oldTokenAfter = decodeAssetToken(getAccountData(svm, assetTokenAddr));
    expect(oldTokenAfter.shares).toBe(0n);

    // Verify old NFT burned (MPL Core leaves a 1-byte Uninitialized tombstone)
    expect(svm.getAccount(oldNftKp.publicKey)!.data[0]).toBe(MplCoreKey.Uninitialized);

    // Verify new token A
    const tokenA = decodeAssetToken(getAccountData(svm, newAssetTokenA));
    expect(tokenA.shares).toBe(60n);
    expect(tokenA.owner).toBe(toAddress(recipientA.publicKey));
    expect(tokenA.parentToken).toBe(assetTokenAddr);
    expect(tokenA.tokenIndex).toBe(1);

    // Verify new token B
    const tokenB = decodeAssetToken(getAccountData(svm, newAssetTokenB));
    expect(tokenB.shares).toBe(40n);
    expect(tokenB.owner).toBe(toAddress(recipientB.publicKey));
    expect(tokenB.parentToken).toBe(assetTokenAddr);
    expect(tokenB.tokenIndex).toBe(2);

    // Verify both NFTs created
    expect(svm.getAccount(newNftA.publicKey)!.data[0]).toBe(MplCoreKey.AssetV1);
    expect(svm.getAccount(newNftB.publicKey)!.data[0]).toBe(MplCoreKey.AssetV1);

    // Verify PermanentFreezeDelegate frozen on both new NFTs
    const nftAssetA = decodeAssetV1(svm.getAccount(newNftA.publicKey)!.data);
    const freezeA = nftAssetA.plugins.find(
      (p) => p.type === PluginType.PermanentFreezeDelegate,
    );
    expect(freezeA).toBeDefined();
    expect((freezeA as { frozen: boolean }).frozen).toBe(true);

    const nftAssetB = decodeAssetV1(svm.getAccount(newNftB.publicKey)!.data);
    const freezeB = nftAssetB.plugins.find(
      (p) => p.type === PluginType.PermanentFreezeDelegate,
    );
    expect(freezeB).toBeDefined();
    expect((freezeB as { frozen: boolean }).frozen).toBe(true);

    // Verify emergency record
    const er = decodeEmergencyRecord(getAccountData(svm, emergencyRecordPda));
    expect(er.accountKey).toBe(AccountKey.EmergencyRecord);
    expect(er.asset).toBe(assetAddr);
    expect(er.oldAssetToken).toBe(assetTokenAddr);
    expect(er.oldOwner).toBe(toAddress(oldOwner.publicKey));
    expect(er.recoveryType).toBe(1); // split_and_remint
  });

  // T&C enforcement

  it("burn_and_remint with CourtOrder reason", async () => {
    const newOwner = Keypair.generate();
    const newNftKp = Keypair.generate();

    const [newAssetTokenPda] = await getAssetTokenPda(assetAddr, 1, PROGRAM_ID);
    const [emergencyRecordPda] = await getEmergencyRecordPda(
      assetTokenAddr,
      PROGRAM_ID,
    );

    sendTx(
      svm,
      [
        burnAndRemint({
          orgAccount: orgAddr,
          assetAccount: assetAddr,
          oldAssetTokenAccount: assetTokenAddr,
          oldNft: toAddress(oldNftKp.publicKey),
          collection: toAddress(collectionKp.publicKey),
          collectionAuthority: collAuthAddr,
          newNft: toAddress(newNftKp.publicKey),
          newAssetTokenAccount: newAssetTokenPda,
          newOwner: toAddress(newOwner.publicKey),
          emergencyRecordAccount: emergencyRecordPda,
          orgAuthority: toAddress(orgAuthority.publicKey),
          payer: toAddress(payer.publicKey),
          reason: 1, // CourtOrder
          sharesToTransfer: 0n, // full transfer
          programId: PROGRAM_ID,
        }),
      ],
      [payer, orgAuthority, newNftKp],
    );

    // Verify old token shares zeroed
    const oldTokenAfter = decodeAssetToken(getAccountData(svm, assetTokenAddr));
    expect(oldTokenAfter.shares).toBe(0n);

    // Verify new token created with all 100 shares
    const newToken = decodeAssetToken(getAccountData(svm, newAssetTokenPda));
    expect(newToken.shares).toBe(100n);
    expect(newToken.owner).toBe(toAddress(newOwner.publicKey));
    expect(newToken.tokenIndex).toBe(1);

    // Verify emergency record has reason = 1 (CourtOrder)
    const er = decodeEmergencyRecord(getAccountData(svm, emergencyRecordPda));
    expect(er.accountKey).toBe(AccountKey.EmergencyRecord);
    expect(er.reason).toBe(1);
    expect(er.recoveryType).toBe(0); // burn_and_remint
    expect(er.asset).toBe(assetAddr);
    expect(er.oldAssetToken).toBe(assetTokenAddr);
    expect(er.oldOwner).toBe(toAddress(oldOwner.publicKey));
  });

  it("partial burn_and_remint creates two tokens", async () => {
    const newOwner = Keypair.generate();
    const newNftKp = Keypair.generate();
    const remainderNftKp = Keypair.generate();

    // Recipient gets token index 1, remainder gets token index 2
    const [newAssetTokenPda] = await getAssetTokenPda(assetAddr, 1, PROGRAM_ID);
    const [remainderAssetTokenPda] = await getAssetTokenPda(assetAddr, 2, PROGRAM_ID);
    const [emergencyRecordPda] = await getEmergencyRecordPda(
      assetTokenAddr,
      PROGRAM_ID,
    );

    sendTx(
      svm,
      [
        burnAndRemint({
          orgAccount: orgAddr,
          assetAccount: assetAddr,
          oldAssetTokenAccount: assetTokenAddr,
          oldNft: toAddress(oldNftKp.publicKey),
          collection: toAddress(collectionKp.publicKey),
          collectionAuthority: collAuthAddr,
          newNft: toAddress(newNftKp.publicKey),
          newAssetTokenAccount: newAssetTokenPda,
          newOwner: toAddress(newOwner.publicKey),
          emergencyRecordAccount: emergencyRecordPda,
          orgAuthority: toAddress(orgAuthority.publicKey),
          payer: toAddress(payer.publicKey),
          reason: 1, // CourtOrder
          sharesToTransfer: 40n,
          remainderNft: toAddress(remainderNftKp.publicKey),
          remainderAssetToken: remainderAssetTokenPda,
          oldOwner: toAddress(oldOwner.publicKey),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, orgAuthority, newNftKp, remainderNftKp],
    );

    // Verify old token shares zeroed
    const oldTokenAfter = decodeAssetToken(getAccountData(svm, assetTokenAddr));
    expect(oldTokenAfter.shares).toBe(0n);

    // Verify recipient token = 40 shares
    const recipientToken = decodeAssetToken(getAccountData(svm, newAssetTokenPda));
    expect(recipientToken.shares).toBe(40n);
    expect(recipientToken.owner).toBe(toAddress(newOwner.publicKey));
    expect(recipientToken.tokenIndex).toBe(1);
    expect(recipientToken.parentToken).toBe(assetTokenAddr);

    // Verify remainder token = 60 shares (stays with old owner)
    const remainderToken = decodeAssetToken(getAccountData(svm, remainderAssetTokenPda));
    expect(remainderToken.shares).toBe(60n);
    expect(remainderToken.owner).toBe(toAddress(oldOwner.publicKey));
    expect(remainderToken.tokenIndex).toBe(2);
    expect(remainderToken.parentToken).toBe(assetTokenAddr);

    // Verify both NFTs created
    expect(svm.getAccount(newNftKp.publicKey)!.data[0]).toBe(MplCoreKey.AssetV1);
    expect(svm.getAccount(remainderNftKp.publicKey)!.data[0]).toBe(MplCoreKey.AssetV1);

    // Verify old NFT burned
    expect(svm.getAccount(oldNftKp.publicKey)!.data[0]).toBe(MplCoreKey.Uninitialized);

    // Verify emergency record
    const er = decodeEmergencyRecord(getAccountData(svm, emergencyRecordPda));
    expect(er.accountKey).toBe(AccountKey.EmergencyRecord);
    expect(er.reason).toBe(1);
    expect(er.sharesTransferred).toBe(40n);
    expect(er.remainderToken).toBe(remainderAssetTokenPda);
  });

  it("burn_and_remint clears lockup for legal transfer", async () => {
    // Create a second round (index 1) with a lockup period
    const LOCKUP_END = 1_500_000n;
    const [round1Pda] = await getFundraisingRoundPda(assetAddr, 1, PROGRAM_ID);
    const [escrow1Pda] = await getEscrowPda(round1Pda, PROGRAM_ID);
    const ROUND1_END_TIME = 2_000_000n;

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
          minRaise: 100_000_000n,
          maxRaise: 500_000_000_000n,
          minPerWallet: 1_000_000n,
          maxPerWallet: 250_000_000_000n,
          startTime: 0n,
          endTime: ROUND1_END_TIME,
          lockupEnd: LOCKUP_END,
          termsHash: new Uint8Array(32),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, orgAuthority],
    );

    // Invest in round 1
    const lockedOwner = Keypair.generate();
    svm.airdrop(lockedOwner.publicKey, BigInt(10_000_000_000));
    const lockedOwnerUsdc = createTokenAccount(
      svm,
      usdcMint,
      lockedOwner.publicKey,
      payer,
    );
    mintTokensTo(svm, usdcMint, lockedOwnerUsdc, 200_000_000n, mintAuthority);
    const [inv1Pda] = await getInvestmentPda(
      round1Pda,
      toAddress(lockedOwner.publicKey),
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
          investorTokenAccount: toAddress(lockedOwnerUsdc),
          investor: toAddress(lockedOwner.publicKey),
          payer: toAddress(payer.publicKey),
          shares: 100n,
          termsHash: new Uint8Array(32),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, lockedOwner],
    );

    // Finalize round 1
    const clock = svm.getClock();
    clock.unixTimestamp = ROUND1_END_TIME + 1n;
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

    // Mint token from round 1 — token index 1 (round 0 minted index 0)
    const lockedNftKp = Keypair.generate();
    const [lockedAssetTokenPda] = await getAssetTokenPda(assetAddr, 1, PROGRAM_ID);

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
              assetTokenAccount: lockedAssetTokenPda,
              nft: toAddress(lockedNftKp.publicKey),
              investor: toAddress(lockedOwner.publicKey),
            },
          ],
          programId: PROGRAM_ID,
        }),
      ],
      [payer, lockedNftKp],
    );

    // Verify the minted token has lockupEnd set
    const lockedToken = decodeAssetToken(getAccountData(svm, lockedAssetTokenPda));
    expect(lockedToken.shares).toBe(100n);
    expect(lockedToken.lockupEnd).toBe(LOCKUP_END);

    // burn_and_remint with reason=1 (CourtOrder) should clear lockup
    const newOwner = Keypair.generate();
    const newNftKp = Keypair.generate();

    // After burning index-1 NFT, new token gets index 2
    const [newAssetTokenPda] = await getAssetTokenPda(assetAddr, 2, PROGRAM_ID);
    const [emergencyRecordPda] = await getEmergencyRecordPda(
      lockedAssetTokenPda,
      PROGRAM_ID,
    );

    sendTx(
      svm,
      [
        burnAndRemint({
          orgAccount: orgAddr,
          assetAccount: assetAddr,
          oldAssetTokenAccount: lockedAssetTokenPda,
          oldNft: toAddress(lockedNftKp.publicKey),
          collection: toAddress(collectionKp.publicKey),
          collectionAuthority: collAuthAddr,
          newNft: toAddress(newNftKp.publicKey),
          newAssetTokenAccount: newAssetTokenPda,
          newOwner: toAddress(newOwner.publicKey),
          emergencyRecordAccount: emergencyRecordPda,
          orgAuthority: toAddress(orgAuthority.publicKey),
          payer: toAddress(payer.publicKey),
          reason: 1, // CourtOrder — legal transfer should clear lockup
          sharesToTransfer: 0n,
          programId: PROGRAM_ID,
        }),
      ],
      [payer, orgAuthority, newNftKp],
    );

    // Verify new token has lockupEnd cleared to 0
    const newToken = decodeAssetToken(getAccountData(svm, newAssetTokenPda));
    expect(newToken.shares).toBe(100n);
    expect(newToken.owner).toBe(toAddress(newOwner.publicKey));
    expect(newToken.lockupEnd).toBe(0n);

    // Verify emergency record
    const er = decodeEmergencyRecord(getAccountData(svm, emergencyRecordPda));
    expect(er.reason).toBe(1);
    expect(er.oldAssetToken).toBe(lockedAssetTokenPda);
    expect(er.oldOwner).toBe(toAddress(lockedOwner.publicKey));
  });
});
