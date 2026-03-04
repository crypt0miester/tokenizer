/**
 * CU (Compute Unit) Report
 *
 * Measures the compute units consumed by each tokenizer instruction
 * as reported by LiteSVM. Run with: npx vitest run cu-report
 *
 * Output: a formatted table printed after all tests complete.
 */

import { describe, it, afterAll } from "vitest";
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
  toAddress,
  toPublicKey,
  createUsdcMint,
  createTokenAccount,
  mintTokensTo,
  TOKEN_PROGRAM_ID,
  ATA_PROGRAM_ID,
  SPL_TOKEN_ACCOUNT_LEN,
} from "../helpers/setup.js";

// Instructions
import {
  initializeProtocol,
  updateConfigFeeBps,
  updateConfigFeeTreasury,
  updateConfigAddMint,
  updateConfigRemoveMint,
  updateConfigSetOperator,
  updateConfigMinProposalWeightBps,
  pauseProtocol,
  unpauseProtocol,
} from "../../src/instructions/protocol.js";
import {
  registerOrganization,
  deregisterOrganization,
  updateOrgAddMint,
  updateOrgRemoveMint,
} from "../../src/instructions/organization.js";
import { initAsset, mintToken, updateMetadata } from "../../src/instructions/asset.js";
import {
  createRound,
  invest,
  finalizeRound,
  mintRoundTokens,
  cancelRound,
  refundInvestment,
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
  createDistribution,
  claimDistribution,
  closeDistribution,
} from "../../src/instructions/distribution.js";
import { burnAndRemint, splitAndRemint } from "../../src/instructions/emergency.js";
import {
  createRegistrar,
  createVoterWeightRecord,
  createMaxVoterWeightRecord,
  createOrgRealm,
  createAssetGovernance,
} from "../../src/instructions/governance.js";
import {
  createBuyoutOffer,
  fundBuyoutOffer,
  cancelBuyout,
} from "../../src/instructions/buyout.js";

// PDAs
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
  getDistributionPda,
  getDistributionEscrowPda,
  getBuyoutOfferPda,
  getBuyoutEscrowPda,
  getRegistrarPda,
  getVoterWeightRecordPda,
  getMaxVoterWeightRecordPda,
  getEmergencyRecordPda,
} from "../../src/pdas.js";
import { AssetStatus } from "../../src/constants.js";
import {
  SPL_GOVERNANCE_PROGRAM_ID,
  VoteThresholdType,
} from "../../src/external/governance/constants.js";
import {
  getRealmAddress,
  getTokenHoldingAddress,
  getRealmConfigAddress,
  getTokenOwnerRecordAddress,
  getGovernanceAddress,
  getNativeTreasuryAddress,
} from "../../src/external/governance/pdas.js";
import {
  depositGoverningTokens,
  encodeGovernanceConfig,
  type GovernanceConfig,
} from "../../src/external/governance/instructions.js";

// ─── Constants ───

const PROGRAM_ID = address("FNDZziaztYptbydC5UpLEaLMyFN4rDmP3G2MN7o6w4ZK");
const PROGRAM_PK = new PublicKey("FNDZziaztYptbydC5UpLEaLMyFN4rDmP3G2MN7o6w4ZK");
const GOV_PROGRAM = SPL_GOVERNANCE_PROGRAM_ID;
const RENT_SYSVAR = address("SysvarRent111111111111111111111111111111111");

function getAtaAddress(wallet: PublicKey, mint: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [wallet.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM_ID,
  );
  return ata;
}

function createTokenAccountAtAddress(
  svm: LiteSVM, mint: PublicKey, owner: PublicKey,
  accountKp: Keypair, payerKp: Keypair,
): PublicKey {
  const rentExempt = svm.minimumBalanceForRentExemption(BigInt(SPL_TOKEN_ACCOUNT_LEN));
  const initData = Buffer.alloc(1);
  initData.writeUInt8(1, 0);
  const tx = new Transaction();
  tx.add(SystemProgram.createAccount({
    fromPubkey: payerKp.publicKey,
    newAccountPubkey: accountKp.publicKey,
    lamports: Number(rentExempt),
    space: SPL_TOKEN_ACCOUNT_LEN,
    programId: TOKEN_PROGRAM_ID,
  }));
  tx.add(new TransactionInstruction({
    keys: [
      { pubkey: accountKp.publicKey, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: new PublicKey("SysvarRent111111111111111111111111111111111"), isSigner: false, isWritable: false },
    ],
    programId: TOKEN_PROGRAM_ID,
    data: initData,
  }));
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = payerKp.publicKey;
  tx.sign(payerKp, accountKp);
  const result = svm.sendTransaction(tx);
  if ("err" in result && typeof (result as FailedTransactionMetadata).err === "function") {
    throw new Error(`createTokenAccountAtAddress failed: ${(result as FailedTransactionMetadata).meta().prettyLogs()}`);
  }
  return accountKp.publicKey;
}

/** Patch an asset account field directly in the SVM. */
function patchAssetField(svm: LiteSVM, assetPk: PublicKey, offset: number, bytes: Uint8Array) {
  const acct = svm.getAccount(assetPk)!;
  const data = new Uint8Array(acct.data);
  data.set(bytes, offset);
  svm.setAccount(assetPk, { ...acct, data });
}

// ─── CU Collection ───

interface CuEntry {
  category: string;
  instruction: string;
  cu: bigint;
}

const cuResults: CuEntry[] = [];

function measure(
  category: string, instruction: string,
  svm: LiteSVM, ixs: Parameters<typeof sendTx>[1], signers: Keypair[],
) {
  const result = sendTx(svm, ixs, signers);
  cuResults.push({ category, instruction, cu: result.computeUnitsConsumed() });
  return result;
}

// ─── Report Output ───

function printReport() {
  // Sort by category then instruction
  const sorted = [...cuResults].sort((a, b) =>
    a.category.localeCompare(b.category) || a.instruction.localeCompare(b.instruction),
  );

  const maxCat = Math.max(10, ...sorted.map((r) => r.category.length));
  const maxIx = Math.max(20, ...sorted.map((r) => r.instruction.length));

  const header = `| ${"Category".padEnd(maxCat)} | ${"Instruction".padEnd(maxIx)} | ${"CU".padStart(8)} |`;
  const sep = `|${"-".repeat(maxCat + 2)}|${"-".repeat(maxIx + 2)}|${"-".repeat(10)}|`;

  console.log("\n" + "=".repeat(header.length));
  console.log("  COMPUTE UNIT REPORT");
  console.log("=".repeat(header.length));
  console.log(header);
  console.log(sep);

  for (const r of sorted) {
    console.log(
      `| ${r.category.padEnd(maxCat)} | ${r.instruction.padEnd(maxIx)} | ${r.cu.toString().padStart(8)} |`,
    );
  }
  console.log(sep);

  const total = sorted.reduce((s, r) => s + r.cu, 0n);
  console.log(`  Total measured: ${sorted.length} instructions, ${total.toLocaleString()} CU\n`);
}

// ─── Tests ───

describe("CU Report", () => {
  afterAll(() => {
    printReport();
  });

  // ── Protocol ──

  describe("Protocol", () => {
    let svm: LiteSVM;
    let operator: Keypair;
    let payer: Keypair;
    let feeTreasury: Keypair;
    let mintAuthority: Keypair;
    let usdcMint: PublicKey;
    let configAddr: Address;

    it("initializeProtocol", async () => {
      svm = createTestSvm({ programId: PROGRAM_PK });
      operator = Keypair.generate();
      payer = Keypair.generate();
      feeTreasury = Keypair.generate();
      mintAuthority = Keypair.generate();
      svm.airdrop(operator.publicKey, BigInt(10e9));
      svm.airdrop(payer.publicKey, BigInt(10e9));
      usdcMint = createUsdcMint(svm, mintAuthority);
      const [pda] = await getProtocolConfigPda(PROGRAM_ID);
      configAddr = pda;

      measure("Protocol", "initializeProtocol", svm, [
        initializeProtocol({
          config: configAddr,
          operator: toAddress(operator.publicKey),
          payer: toAddress(payer.publicKey),
          feeBps: 100,
          feeTreasury: toAddress(feeTreasury.publicKey),
          acceptedMint: toAddress(usdcMint),
          programId: PROGRAM_ID,
        }),
      ], [payer, operator]);
    });

    it("updateConfigFeeBps", () => {
      measure("Protocol", "updateConfigFeeBps", svm, [
        updateConfigFeeBps({
          config: configAddr,
          operator: toAddress(operator.publicKey),
          feeBps: 250,
          programId: PROGRAM_ID,
        }),
      ], [operator]);
    });

    it("updateConfigFeeTreasury", () => {
      const newTreasury = Keypair.generate();
      measure("Protocol", "updateConfigFeeTreasury", svm, [
        updateConfigFeeTreasury({
          config: configAddr,
          operator: toAddress(operator.publicKey),
          feeTreasury: toAddress(newTreasury.publicKey),
          programId: PROGRAM_ID,
        }),
      ], [operator]);
    });

    it("updateConfigAddMint", () => {
      const newMint = createUsdcMint(svm, mintAuthority);
      measure("Protocol", "updateConfigAddMint", svm, [
        updateConfigAddMint({
          config: configAddr,
          operator: toAddress(operator.publicKey),
          mint: toAddress(newMint),
          programId: PROGRAM_ID,
        }),
      ], [operator]);
    });

    it("updateConfigRemoveMint", () => {
      measure("Protocol", "updateConfigRemoveMint", svm, [
        updateConfigRemoveMint({
          config: configAddr,
          operator: toAddress(operator.publicKey),
          mint: toAddress(usdcMint),
          programId: PROGRAM_ID,
        }),
      ], [operator]);
    });

    it("updateConfigSetOperator", () => {
      const newOp = Keypair.generate();
      svm.airdrop(newOp.publicKey, BigInt(10e9));
      measure("Protocol", "updateConfigSetOperator", svm, [
        updateConfigSetOperator({
          config: configAddr,
          operator: toAddress(operator.publicKey),
          newOperator: toAddress(newOp.publicKey),
          programId: PROGRAM_ID,
        }),
      ], [operator]);
      operator = newOp;
    });

    it("updateConfigMinProposalWeightBps", () => {
      measure("Protocol", "updateConfigMinProposalWeightBps", svm, [
        updateConfigMinProposalWeightBps({
          config: configAddr,
          operator: toAddress(operator.publicKey),
          minProposalWeightBps: 500,
          programId: PROGRAM_ID,
        }),
      ], [operator]);
    });

    it("pauseProtocol", () => {
      measure("Protocol", "pauseProtocol", svm, [
        pauseProtocol({
          config: configAddr,
          operator: toAddress(operator.publicKey),
          programId: PROGRAM_ID,
        }),
      ], [operator]);
    });

    it("unpauseProtocol", () => {
      measure("Protocol", "unpauseProtocol", svm, [
        unpauseProtocol({
          config: configAddr,
          operator: toAddress(operator.publicKey),
          programId: PROGRAM_ID,
        }),
      ], [operator]);
    });
  });

  // ── Organization ──

  describe("Organization", () => {
    let svm: LiteSVM;
    let operator: Keypair;
    let payer: Keypair;
    let mintAuthority: Keypair;
    let orgAuthority: Keypair;
    let usdcMint: PublicKey;
    let configAddr: Address;
    let orgAddr: Address;

    it("registerOrganization", async () => {
      svm = createTestSvm({ programId: PROGRAM_PK });
      operator = Keypair.generate();
      payer = Keypair.generate();
      mintAuthority = Keypair.generate();
      orgAuthority = Keypair.generate();
      svm.airdrop(operator.publicKey, BigInt(10e9));
      svm.airdrop(payer.publicKey, BigInt(10e9));
      svm.airdrop(orgAuthority.publicKey, BigInt(10e9));
      usdcMint = createUsdcMint(svm, mintAuthority);
      const [configPda] = await getProtocolConfigPda(PROGRAM_ID);
      configAddr = configPda;

      sendTx(svm, [initializeProtocol({
        config: configAddr, operator: toAddress(operator.publicKey),
        payer: toAddress(payer.publicKey), feeBps: 100,
        feeTreasury: toAddress(Keypair.generate().publicKey),
        acceptedMint: toAddress(usdcMint), programId: PROGRAM_ID,
      })], [payer, operator]);

      const [orgPda] = await getOrganizationPda(0, PROGRAM_ID);
      orgAddr = orgPda;

      measure("Organization", "registerOrganization", svm, [
        registerOrganization({
          config: configAddr, orgAccount: orgAddr,
          operator: toAddress(operator.publicKey), payer: toAddress(payer.publicKey),
          authority: toAddress(orgAuthority.publicKey),
          name: "TestOrg", registrationNumber: "REG-001", country: "US",
          programId: PROGRAM_ID,
        }),
      ], [payer, operator]);
    });

    it("updateOrgAddMint", () => {
      measure("Organization", "updateOrgAddMint", svm, [
        updateOrgAddMint({
          config: configAddr, orgAccount: orgAddr,
          authority: toAddress(orgAuthority.publicKey),
          mint: toAddress(usdcMint), programId: PROGRAM_ID,
        }),
      ], [orgAuthority]);
    });

    it("updateOrgRemoveMint", () => {
      measure("Organization", "updateOrgRemoveMint", svm, [
        updateOrgRemoveMint({
          config: configAddr, orgAccount: orgAddr,
          authority: toAddress(orgAuthority.publicKey),
          mint: toAddress(usdcMint), programId: PROGRAM_ID,
        }),
      ], [orgAuthority]);
    });

    it("deregisterOrganization", () => {
      measure("Organization", "deregisterOrganization", svm, [
        deregisterOrganization({
          config: configAddr, orgAccount: orgAddr,
          operator: toAddress(operator.publicKey),
          orgId: 0, programId: PROGRAM_ID,
        }),
      ], [operator]);
    });
  });

  // ── Asset ──

  describe("Asset", () => {
    let svm: LiteSVM;
    let payer: Keypair;
    let orgAuthority: Keypair;
    let mintAuthority: Keypair;
    let usdcMint: PublicKey;
    let configAddr: Address;
    let orgAddr: Address;
    let assetAddr: Address;
    let collectionKp: Keypair;
    let collAuthAddr: Address;

    it("initAsset", async () => {
      svm = createTestSvm({ programId: PROGRAM_PK, loadMplCore: true });
      const operator = Keypair.generate();
      payer = Keypair.generate();
      orgAuthority = Keypair.generate();
      mintAuthority = Keypair.generate();
      svm.airdrop(operator.publicKey, BigInt(10e9));
      svm.airdrop(payer.publicKey, BigInt(10e9));
      svm.airdrop(orgAuthority.publicKey, BigInt(10e9));
      usdcMint = createUsdcMint(svm, mintAuthority);

      const [configPda] = await getProtocolConfigPda(PROGRAM_ID);
      configAddr = configPda;
      sendTx(svm, [initializeProtocol({
        config: configAddr, operator: toAddress(operator.publicKey),
        payer: toAddress(payer.publicKey), feeBps: 100,
        feeTreasury: toAddress(Keypair.generate().publicKey),
        acceptedMint: toAddress(usdcMint), programId: PROGRAM_ID,
      })], [payer, operator]);

      const [orgPda] = await getOrganizationPda(0, PROGRAM_ID);
      orgAddr = orgPda;
      sendTx(svm, [registerOrganization({
        config: configAddr, orgAccount: orgAddr,
        operator: toAddress(operator.publicKey), payer: toAddress(payer.publicKey),
        authority: toAddress(orgAuthority.publicKey),
        name: "TestOrg", registrationNumber: "REG-001", country: "US",
        programId: PROGRAM_ID,
      })], [payer, operator]);
      sendTx(svm, [updateOrgAddMint({
        config: configAddr, orgAccount: orgAddr,
        authority: toAddress(orgAuthority.publicKey),
        mint: toAddress(usdcMint), programId: PROGRAM_ID,
      })], [orgAuthority]);

      collectionKp = Keypair.generate();
      const [assetPda] = await getAssetPda(orgAddr, 0, PROGRAM_ID);
      assetAddr = assetPda;
      const [collAuthPda] = await getCollectionAuthorityPda(toAddress(collectionKp.publicKey), PROGRAM_ID);
      collAuthAddr = collAuthPda;

      measure("Asset", "initAsset", svm, [
        initAsset({
          config: configAddr, orgAccount: orgAddr, assetAccount: assetAddr,
          collection: toAddress(collectionKp.publicKey), collectionAuthority: collAuthAddr,
          authority: toAddress(orgAuthority.publicKey), payer: toAddress(payer.publicKey),
          totalShares: 1_000_000n, pricePerShare: 1_000_000n,
          acceptedMint: toAddress(usdcMint),
          maturityDate: 0n, maturityGracePeriod: 0n, transferCooldown: 0n, maxHolders: 0,
          name: "TestAsset", uri: "https://example.com/asset.json",
          programId: PROGRAM_ID,
        }),
      ], [payer, orgAuthority, collectionKp]);
    });

    it("mintToken", async () => {
      // Create round to enable minting
      const [roundPda] = await getFundraisingRoundPda(assetAddr, 0, PROGRAM_ID);
      const [escrowPda] = await getEscrowPda(roundPda, PROGRAM_ID);
      sendTx(svm, [createRound({
        config: configAddr, orgAccount: orgAddr, assetAccount: assetAddr,
        roundAccount: roundPda, escrow: escrowPda, acceptedMint: toAddress(usdcMint),
        authority: toAddress(orgAuthority.publicKey), payer: toAddress(payer.publicKey),
        sharesOffered: 500_000n, pricePerShare: 1_000_000n,
        minRaise: 1_000_000n, maxRaise: 500_000_000_000n,
        minPerWallet: 1n, maxPerWallet: 250_000_000_000n,
        startTime: 0n, endTime: 9_999_999_999n, lockupEnd: 0n,
        termsHash: new Uint8Array(32), programId: PROGRAM_ID,
      })], [payer, orgAuthority]);

      const nft = Keypair.generate();
      const recipient = Keypair.generate();
      const [assetTokenPda] = await getAssetTokenPda(assetAddr, 0, PROGRAM_ID);

      measure("Asset", "mintToken", svm, [
        mintToken({
          config: configAddr, orgAccount: orgAddr, assetAccount: assetAddr,
          assetTokenAccount: assetTokenPda, collection: toAddress(collectionKp.publicKey),
          collectionAuthority: collAuthAddr, nft: toAddress(nft.publicKey),
          recipient: toAddress(recipient.publicKey),
          authority: toAddress(orgAuthority.publicKey), payer: toAddress(payer.publicKey),
          shares: 100_000n, programId: PROGRAM_ID,
        }),
      ], [payer, orgAuthority, nft]);
    });

    it("updateMetadata", () => {
      measure("Asset", "updateMetadata", svm, [
        updateMetadata({
          config: configAddr, orgAccount: orgAddr, assetAccount: assetAddr,
          collection: toAddress(collectionKp.publicKey), collectionAuthority: collAuthAddr,
          authority: toAddress(orgAuthority.publicKey), payer: toAddress(payer.publicKey),
          orgId: 0, assetId: 0,
          newName: "NewName", newUri: "https://example.com/new.json",
          programId: PROGRAM_ID,
        }),
      ], [payer, orgAuthority]);
    });
  });

  // ── Fundraising ──

  describe("Fundraising", () => {
    let svm: LiteSVM;
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

    // Round 1: full lifecycle (create → invest → finalize → mint)
    let roundPda: Address;
    let escrowPda: Address;
    let investorA: Keypair;
    let investorAToken: PublicKey;
    let invAPda: Address;

    it("createRound", async () => {
      svm = createTestSvm({ programId: PROGRAM_PK, loadMplCore: true });
      const operator = Keypair.generate();
      payer = Keypair.generate();
      orgAuthority = Keypair.generate();
      mintAuthority = Keypair.generate();
      feeTreasury = Keypair.generate();
      svm.airdrop(operator.publicKey, BigInt(10e9));
      svm.airdrop(payer.publicKey, BigInt(10e9));
      svm.airdrop(orgAuthority.publicKey, BigInt(10e9));
      usdcMint = createUsdcMint(svm, mintAuthority);
      createTokenAccountAtAddress(svm, usdcMint, payer.publicKey, feeTreasury, payer);

      const [configPda] = await getProtocolConfigPda(PROGRAM_ID);
      configAddr = configPda;
      sendTx(svm, [initializeProtocol({
        config: configAddr, operator: toAddress(operator.publicKey),
        payer: toAddress(payer.publicKey), feeBps: 100,
        feeTreasury: toAddress(feeTreasury.publicKey),
        acceptedMint: toAddress(usdcMint), programId: PROGRAM_ID,
      })], [payer, operator]);

      const [orgPda] = await getOrganizationPda(0, PROGRAM_ID);
      orgAddr = orgPda;
      sendTx(svm, [registerOrganization({
        config: configAddr, orgAccount: orgAddr,
        operator: toAddress(operator.publicKey), payer: toAddress(payer.publicKey),
        authority: toAddress(orgAuthority.publicKey),
        name: "TestOrg", registrationNumber: "REG-001", country: "US",
        programId: PROGRAM_ID,
      })], [payer, operator]);
      sendTx(svm, [updateOrgAddMint({
        config: configAddr, orgAccount: orgAddr,
        authority: toAddress(orgAuthority.publicKey),
        mint: toAddress(usdcMint), programId: PROGRAM_ID,
      })], [orgAuthority]);

      collectionKp = Keypair.generate();
      const [assetPda] = await getAssetPda(orgAddr, 0, PROGRAM_ID);
      assetAddr = assetPda;
      const [collAuthPda] = await getCollectionAuthorityPda(toAddress(collectionKp.publicKey), PROGRAM_ID);
      collAuthAddr = collAuthPda;
      sendTx(svm, [initAsset({
        config: configAddr, orgAccount: orgAddr, assetAccount: assetAddr,
        collection: toAddress(collectionKp.publicKey), collectionAuthority: collAuthAddr,
        authority: toAddress(orgAuthority.publicKey), payer: toAddress(payer.publicKey),
        totalShares: 1_000_000n, pricePerShare: 1_000_000n,
        acceptedMint: toAddress(usdcMint),
        maturityDate: 0n, maturityGracePeriod: 0n, transferCooldown: 0n, maxHolders: 0,
        name: "TestAsset", uri: "https://example.com/asset.json",
        programId: PROGRAM_ID,
      })], [payer, orgAuthority, collectionKp]);

      const [rPda] = await getFundraisingRoundPda(assetAddr, 0, PROGRAM_ID);
      roundPda = rPda;
      const [ePda] = await getEscrowPda(roundPda, PROGRAM_ID);
      escrowPda = ePda;

      measure("Fundraising", "createRound", svm, [
        createRound({
          config: configAddr, orgAccount: orgAddr, assetAccount: assetAddr,
          roundAccount: roundPda, escrow: escrowPda, acceptedMint: toAddress(usdcMint),
          authority: toAddress(orgAuthority.publicKey), payer: toAddress(payer.publicKey),
          sharesOffered: 500_000n, pricePerShare: 1_000_000n,
          minRaise: 100_000_000n, maxRaise: 500_000_000_000n,
          minPerWallet: 1n, maxPerWallet: 250_000_000_000n,
          startTime: 0n, endTime: 1_000_000n, lockupEnd: 0n,
          termsHash: new Uint8Array(32), programId: PROGRAM_ID,
        }),
      ], [payer, orgAuthority]);
    });

    it("invest", async () => {
      investorA = Keypair.generate();
      svm.airdrop(investorA.publicKey, BigInt(10e9));
      investorAToken = createTokenAccount(svm, usdcMint, investorA.publicKey, payer);
      mintTokensTo(svm, usdcMint, investorAToken, 500_000_000_000n, mintAuthority);
      const [iPda] = await getInvestmentPda(roundPda, toAddress(investorA.publicKey), PROGRAM_ID);
      invAPda = iPda;

      measure("Fundraising", "invest", svm, [
        invest({
          config: configAddr, roundAccount: roundPda, investmentAccount: invAPda,
          escrow: escrowPda, investorTokenAccount: toAddress(investorAToken),
          investor: toAddress(investorA.publicKey), payer: toAddress(payer.publicKey),
          shares: 100n, termsHash: new Uint8Array(32), programId: PROGRAM_ID,
        }),
      ], [payer, investorA]);
    });

    it("finalizeRound", () => {
      const clock = svm.getClock();
      clock.unixTimestamp = 1_000_001n;
      svm.setClock(clock);

      const orgTreasuryToken = getAtaAddress(orgAuthority.publicKey, usdcMint);

      measure("Fundraising", "finalizeRound", svm, [
        finalizeRound({
          config: configAddr, assetAccount: assetAddr, roundAccount: roundPda,
          escrow: escrowPda, feeTreasuryToken: toAddress(feeTreasury.publicKey),
          orgTreasuryToken: toAddress(orgTreasuryToken),
          treasuryWallet: toAddress(orgAuthority.publicKey),
          payer: toAddress(payer.publicKey), acceptedMint: toAddress(usdcMint),
          ataProgram: toAddress(ATA_PROGRAM_ID), programId: PROGRAM_ID,
        }),
      ], [payer]);
    });

    it("mintRoundTokens", async () => {
      const nftA = Keypair.generate();
      const [assetTokenA] = await getAssetTokenPda(assetAddr, 0, PROGRAM_ID);

      measure("Fundraising", "mintRoundTokens (1 investor)", svm, [
        mintRoundTokens({
          roundAccount: roundPda, assetAccount: assetAddr,
          collection: toAddress(collectionKp.publicKey), collectionAuthority: collAuthAddr,
          payer: toAddress(payer.publicKey),
          investors: [{
            investmentAccount: invAPda, assetTokenAccount: assetTokenA,
            nft: toAddress(nftA.publicKey), investor: toAddress(investorA.publicKey),
          }],
          programId: PROGRAM_ID,
        }),
      ], [payer, nftA]);
    });

    it("cancelRound", async () => {
      // Create a second round to cancel
      const [round2Pda] = await getFundraisingRoundPda(assetAddr, 1, PROGRAM_ID);
      const [escrow2Pda] = await getEscrowPda(round2Pda, PROGRAM_ID);
      sendTx(svm, [createRound({
        config: configAddr, orgAccount: orgAddr, assetAccount: assetAddr,
        roundAccount: round2Pda, escrow: escrow2Pda, acceptedMint: toAddress(usdcMint),
        authority: toAddress(orgAuthority.publicKey), payer: toAddress(payer.publicKey),
        sharesOffered: 100_000n, pricePerShare: 1_000_000n,
        minRaise: 100_000_000n, maxRaise: 500_000_000_000n,
        minPerWallet: 1n, maxPerWallet: 250_000_000_000n,
        startTime: 0n, endTime: 2_000_000n, lockupEnd: 0n,
        termsHash: new Uint8Array(32), programId: PROGRAM_ID,
      })], [payer, orgAuthority]);

      measure("Fundraising", "cancelRound", svm, [
        cancelRound({
          config: configAddr, orgAccount: orgAddr, assetAccount: assetAddr,
          roundAccount: round2Pda, authority: toAddress(orgAuthority.publicKey),
          programId: PROGRAM_ID,
        }),
      ], [orgAuthority]);
    });

    it("refundInvestment", async () => {
      // Create a third round, invest, cancel, then refund
      const [round3Pda] = await getFundraisingRoundPda(assetAddr, 2, PROGRAM_ID);
      const [escrow3Pda] = await getEscrowPda(round3Pda, PROGRAM_ID);
      sendTx(svm, [createRound({
        config: configAddr, orgAccount: orgAddr, assetAccount: assetAddr,
        roundAccount: round3Pda, escrow: escrow3Pda, acceptedMint: toAddress(usdcMint),
        authority: toAddress(orgAuthority.publicKey), payer: toAddress(payer.publicKey),
        sharesOffered: 100_000n, pricePerShare: 1_000_000n,
        minRaise: 100_000_000n, maxRaise: 500_000_000_000n,
        minPerWallet: 1n, maxPerWallet: 250_000_000_000n,
        startTime: 0n, endTime: 3_000_000n, lockupEnd: 0n,
        termsHash: new Uint8Array(32), programId: PROGRAM_ID,
      })], [payer, orgAuthority]);

      const refundInvestor = Keypair.generate();
      svm.airdrop(refundInvestor.publicKey, BigInt(10e9));
      const refundToken = createTokenAccount(svm, usdcMint, refundInvestor.publicKey, payer);
      mintTokensTo(svm, usdcMint, refundToken, 500_000_000_000n, mintAuthority);
      const [refundInvPda] = await getInvestmentPda(round3Pda, toAddress(refundInvestor.publicKey), PROGRAM_ID);

      sendTx(svm, [invest({
        config: configAddr, roundAccount: round3Pda, investmentAccount: refundInvPda,
        escrow: escrow3Pda, investorTokenAccount: toAddress(refundToken),
        investor: toAddress(refundInvestor.publicKey), payer: toAddress(payer.publicKey),
        shares: 100n, termsHash: new Uint8Array(32), programId: PROGRAM_ID,
      })], [payer, refundInvestor]);

      sendTx(svm, [cancelRound({
        config: configAddr, orgAccount: orgAddr, assetAccount: assetAddr,
        roundAccount: round3Pda, authority: toAddress(orgAuthority.publicKey),
        programId: PROGRAM_ID,
      })], [orgAuthority]);

      measure("Fundraising", "refundInvestment (1 investor)", svm, [
        refundInvestment({
          roundAccount: round3Pda, escrow: escrow3Pda,
          payer: toAddress(payer.publicKey), acceptedMint: toAddress(usdcMint),
          ataProgram: toAddress(ATA_PROGRAM_ID),
          investors: [{
            investmentAccount: refundInvPda,
            investorTokenAccount: toAddress(refundToken),
            investor: toAddress(refundInvestor.publicKey),
          }],
          programId: PROGRAM_ID,
        }),
      ], [payer]);
    });
  });

  // ── Market ──

  describe("Market", () => {
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
    let seller: Keypair;
    let assetTokenAddr: Address;
    let nftKp: Keypair;

    it("setup + listForSale", async () => {
      svm = createTestSvm({ programId: PROGRAM_PK, loadMplCore: true });
      operator = Keypair.generate();
      payer = Keypair.generate();
      orgAuthority = Keypair.generate();
      mintAuthority = Keypair.generate();
      feeTreasury = Keypair.generate();
      svm.airdrop(operator.publicKey, BigInt(10e9));
      svm.airdrop(payer.publicKey, BigInt(10e9));
      svm.airdrop(orgAuthority.publicKey, BigInt(10e9));
      usdcMint = createUsdcMint(svm, mintAuthority);
      createTokenAccountAtAddress(svm, usdcMint, payer.publicKey, feeTreasury, payer);

      const [configPda] = await getProtocolConfigPda(PROGRAM_ID);
      configAddr = configPda;
      sendTx(svm, [initializeProtocol({
        config: configAddr, operator: toAddress(operator.publicKey),
        payer: toAddress(payer.publicKey), feeBps: 100,
        feeTreasury: toAddress(feeTreasury.publicKey),
        acceptedMint: toAddress(usdcMint), programId: PROGRAM_ID,
      })], [payer, operator]);

      const [orgPda] = await getOrganizationPda(0, PROGRAM_ID);
      orgAddr = orgPda;
      sendTx(svm, [registerOrganization({
        config: configAddr, orgAccount: orgAddr,
        operator: toAddress(operator.publicKey), payer: toAddress(payer.publicKey),
        authority: toAddress(orgAuthority.publicKey),
        name: "TestOrg", registrationNumber: "REG-001", country: "US",
        programId: PROGRAM_ID,
      })], [payer, operator]);
      sendTx(svm, [updateOrgAddMint({
        config: configAddr, orgAccount: orgAddr,
        authority: toAddress(orgAuthority.publicKey),
        mint: toAddress(usdcMint), programId: PROGRAM_ID,
      })], [orgAuthority]);

      collectionKp = Keypair.generate();
      const [assetPda] = await getAssetPda(orgAddr, 0, PROGRAM_ID);
      assetAddr = assetPda;
      const [collAuthPda] = await getCollectionAuthorityPda(toAddress(collectionKp.publicKey), PROGRAM_ID);
      collAuthAddr = collAuthPda;
      sendTx(svm, [initAsset({
        config: configAddr, orgAccount: orgAddr, assetAccount: assetAddr,
        collection: toAddress(collectionKp.publicKey), collectionAuthority: collAuthAddr,
        authority: toAddress(orgAuthority.publicKey), payer: toAddress(payer.publicKey),
        totalShares: 1_000_000n, pricePerShare: 1_000_000n,
        acceptedMint: toAddress(usdcMint),
        maturityDate: 0n, maturityGracePeriod: 0n, transferCooldown: 0n, maxHolders: 0,
        transferPolicy: 1,
        name: "TestAsset", uri: "https://example.com/asset.json",
        programId: PROGRAM_ID,
      })], [payer, orgAuthority, collectionKp]);

      // Fundraising round + investor
      const [roundPda] = await getFundraisingRoundPda(assetAddr, 0, PROGRAM_ID);
      const [escrowPda] = await getEscrowPda(roundPda, PROGRAM_ID);
      sendTx(svm, [createRound({
        config: configAddr, orgAccount: orgAddr, assetAccount: assetAddr,
        roundAccount: roundPda, escrow: escrowPda, acceptedMint: toAddress(usdcMint),
        authority: toAddress(orgAuthority.publicKey), payer: toAddress(payer.publicKey),
        sharesOffered: 500_000n, pricePerShare: 1_000_000n,
        minRaise: 1_000_000n, maxRaise: 500_000_000_000n,
        minPerWallet: 1n, maxPerWallet: 250_000_000_000n,
        startTime: 0n, endTime: 1_000_000n, lockupEnd: 0n,
        termsHash: new Uint8Array(32), programId: PROGRAM_ID,
      })], [payer, orgAuthority]);

      seller = Keypair.generate();
      svm.airdrop(seller.publicKey, BigInt(10e9));
      const sellerToken = createTokenAccount(svm, usdcMint, seller.publicKey, payer);
      mintTokensTo(svm, usdcMint, sellerToken, 500_000_000_000n, mintAuthority);
      const [sellerInvPda] = await getInvestmentPda(roundPda, toAddress(seller.publicKey), PROGRAM_ID);

      sendTx(svm, [invest({
        config: configAddr, roundAccount: roundPda, investmentAccount: sellerInvPda,
        escrow: escrowPda, investorTokenAccount: toAddress(sellerToken),
        investor: toAddress(seller.publicKey), payer: toAddress(payer.publicKey),
        shares: 200n, termsHash: new Uint8Array(32), programId: PROGRAM_ID,
      })], [payer, seller]);

      // Finalize
      const clock = svm.getClock();
      clock.unixTimestamp = 1_000_001n;
      svm.setClock(clock);
      const orgTreasuryToken = getAtaAddress(orgAuthority.publicKey, usdcMint);
      sendTx(svm, [finalizeRound({
        config: configAddr, assetAccount: assetAddr, roundAccount: roundPda,
        escrow: escrowPda, feeTreasuryToken: toAddress(feeTreasury.publicKey),
        orgTreasuryToken: toAddress(orgTreasuryToken),
        treasuryWallet: toAddress(orgAuthority.publicKey),
        payer: toAddress(payer.publicKey), acceptedMint: toAddress(usdcMint),
        ataProgram: toAddress(ATA_PROGRAM_ID), programId: PROGRAM_ID,
      })], [payer]);

      // Mint token
      nftKp = Keypair.generate();
      const [atPda] = await getAssetTokenPda(assetAddr, 0, PROGRAM_ID);
      assetTokenAddr = atPda;
      sendTx(svm, [mintRoundTokens({
        roundAccount: roundPda, assetAccount: assetAddr,
        collection: toAddress(collectionKp.publicKey), collectionAuthority: collAuthAddr,
        payer: toAddress(payer.publicKey),
        investors: [{
          investmentAccount: sellerInvPda, assetTokenAccount: assetTokenAddr,
          nft: toAddress(nftKp.publicKey), investor: toAddress(seller.publicKey),
        }],
        programId: PROGRAM_ID,
      })], [payer, nftKp]);

      // Now measure listForSale
      const [listingPda] = await getListingPda(assetTokenAddr, PROGRAM_ID);

      measure("Market", "listForSale", svm, [
        listForSale({
          config: configAddr, assetAccount: assetAddr,
          assetTokenAccount: assetTokenAddr, listingAccount: listingPda,
          seller: toAddress(seller.publicKey), payer: toAddress(payer.publicKey),
          sharesForSale: 200n, pricePerShare: 2_000_000n,
          isPartial: false, expiry: 0n, programId: PROGRAM_ID,
        }),
      ], [payer, seller]);
    });

    it("buyListedToken (full)", async () => {
      const buyer = Keypair.generate();
      svm.airdrop(buyer.publicKey, BigInt(10e9));
      const buyerToken = createTokenAccount(svm, usdcMint, buyer.publicKey, payer);
      mintTokensTo(svm, usdcMint, buyerToken, 500_000_000_000n, mintAuthority);
      const sellerTokenAcc = getAtaAddress(seller.publicKey, usdcMint);
      const [listingPda] = await getListingPda(assetTokenAddr, PROGRAM_ID);

      measure("Market", "buyListedToken (full)", svm, [
        buyListedToken({
          config: configAddr, asset: assetAddr,
          assetToken: assetTokenAddr, listing: listingPda,
          nft: toAddress(nftKp.publicKey),
          collection: toAddress(collectionKp.publicKey), collectionAuthority: collAuthAddr,
          buyer: toAddress(buyer.publicKey), seller: toAddress(seller.publicKey),
          buyerTokenAcc: toAddress(buyerToken),
          sellerTokenAcc: toAddress(sellerTokenAcc),
          feeTreasuryToken: toAddress(feeTreasury.publicKey),
          payer: toAddress(payer.publicKey),
          acceptedMint: toAddress(usdcMint),
          ataProgram: toAddress(ATA_PROGRAM_ID),
          rentDestination: toAddress(payer.publicKey),
          programId: PROGRAM_ID,
        }),
      ], [payer, buyer]);

      // Token now belongs to buyer. Mint a new token for seller for remaining tests.
      const newNft = Keypair.generate();
      const [newAtPda] = await getAssetTokenPda(assetAddr, 1, PROGRAM_ID);
      sendTx(svm, [mintToken({
        config: configAddr, orgAccount: orgAddr, assetAccount: assetAddr,
        assetTokenAccount: newAtPda, collection: toAddress(collectionKp.publicKey),
        collectionAuthority: collAuthAddr, nft: toAddress(newNft.publicKey),
        recipient: toAddress(seller.publicKey),
        authority: toAddress(orgAuthority.publicKey), payer: toAddress(payer.publicKey),
        shares: 200n, programId: PROGRAM_ID,
      })], [payer, orgAuthority, newNft]);
      assetTokenAddr = newAtPda;
      nftKp = newNft;
    });

    it("delist + makeOffer", async () => {
      // List the seller's token then delist
      const [listingPda2] = await getListingPda(assetTokenAddr, PROGRAM_ID);
      sendTx(svm, [listForSale({
        config: configAddr, assetAccount: assetAddr,
        assetTokenAccount: assetTokenAddr, listingAccount: listingPda2,
        seller: toAddress(seller.publicKey), payer: toAddress(payer.publicKey),
        sharesForSale: 50n, pricePerShare: 2_000_000n,
        isPartial: false, expiry: 0n, programId: PROGRAM_ID,
      })], [payer, seller]);

      measure("Market", "delist", svm, [
        delist({
          assetTokenAccount: assetTokenAddr, listingAccount: listingPda2,
          seller: toAddress(seller.publicKey),
          rentDestination: toAddress(payer.publicKey),
          programId: PROGRAM_ID,
        }),
      ], [seller]);

      // Make offer on the unlisted token
      const offerBuyer = Keypair.generate();
      svm.airdrop(offerBuyer.publicKey, BigInt(10e9));
      const offerBuyerToken = createTokenAccount(svm, usdcMint, offerBuyer.publicKey, payer);
      mintTokensTo(svm, usdcMint, offerBuyerToken, 500_000_000_000n, mintAuthority);
      const [offerPda] = await getOfferPda(assetTokenAddr, toAddress(offerBuyer.publicKey), PROGRAM_ID);
      const [escrowPda] = await getOfferEscrowPda(offerPda, PROGRAM_ID);

      measure("Market", "makeOffer", svm, [
        makeOffer({
          config: configAddr, assetAccount: assetAddr,
          assetTokenAccount: assetTokenAddr, offerAccount: offerPda,
          escrow: escrowPda, buyerTokenAcc: toAddress(offerBuyerToken),
          acceptedMint: toAddress(usdcMint),
          buyer: toAddress(offerBuyer.publicKey), payer: toAddress(payer.publicKey),
          sharesRequested: 25n, pricePerShare: 2_000_000n, expiry: 0n,
          programId: PROGRAM_ID,
        }),
      ], [payer, offerBuyer]);
    });

    it("rejectOffer", async () => {
      const rejectBuyer = Keypair.generate();
      svm.airdrop(rejectBuyer.publicKey, BigInt(10e9));
      const rejectToken = createTokenAccount(svm, usdcMint, rejectBuyer.publicKey, payer);
      mintTokensTo(svm, usdcMint, rejectToken, 500_000_000_000n, mintAuthority);
      const [rejOfferPda] = await getOfferPda(assetTokenAddr, toAddress(rejectBuyer.publicKey), PROGRAM_ID);
      const [rejEscrowPda] = await getOfferEscrowPda(rejOfferPda, PROGRAM_ID);

      sendTx(svm, [makeOffer({
        config: configAddr, assetAccount: assetAddr,
        assetTokenAccount: assetTokenAddr, offerAccount: rejOfferPda,
        escrow: rejEscrowPda, buyerTokenAcc: toAddress(rejectToken),
        acceptedMint: toAddress(usdcMint),
        buyer: toAddress(rejectBuyer.publicKey), payer: toAddress(payer.publicKey),
        sharesRequested: 10n, pricePerShare: 2_000_000n, expiry: 0n,
        programId: PROGRAM_ID,
      })], [payer, rejectBuyer]);

      measure("Market", "rejectOffer", svm, [
        rejectOffer({
          assetTokenAccount: assetTokenAddr, offerAccount: rejOfferPda,
          escrow: rejEscrowPda, buyerTokenAcc: toAddress(rejectToken),
          seller: toAddress(seller.publicKey),
          buyer: toAddress(rejectBuyer.publicKey),
          acceptedMint: toAddress(usdcMint),
          ataProgram: toAddress(ATA_PROGRAM_ID),
          rentDestination: toAddress(payer.publicKey),
          programId: PROGRAM_ID,
        }),
      ], [seller]);
    });

    it("cancelOffer", async () => {
      // Create a new offer to cancel
      const cancelBuyer = Keypair.generate();
      svm.airdrop(cancelBuyer.publicKey, BigInt(10e9));
      const cancelToken = createTokenAccount(svm, usdcMint, cancelBuyer.publicKey, payer);
      mintTokensTo(svm, usdcMint, cancelToken, 500_000_000_000n, mintAuthority);
      const [canOfferPda] = await getOfferPda(assetTokenAddr, toAddress(cancelBuyer.publicKey), PROGRAM_ID);
      const [canEscrowPda] = await getOfferEscrowPda(canOfferPda, PROGRAM_ID);

      sendTx(svm, [makeOffer({
        config: configAddr, assetAccount: assetAddr,
        assetTokenAccount: assetTokenAddr, offerAccount: canOfferPda,
        escrow: canEscrowPda, buyerTokenAcc: toAddress(cancelToken),
        acceptedMint: toAddress(usdcMint),
        buyer: toAddress(cancelBuyer.publicKey), payer: toAddress(payer.publicKey),
        sharesRequested: 10n, pricePerShare: 2_000_000n, expiry: 0n,
        programId: PROGRAM_ID,
      })], [payer, cancelBuyer]);

      measure("Market", "cancelOffer", svm, [
        cancelOffer({
          offerAccount: canOfferPda,
          escrow: canEscrowPda, buyerTokenAcc: toAddress(cancelToken),
          buyer: toAddress(cancelBuyer.publicKey),
          acceptedMint: toAddress(usdcMint),
          ataProgram: toAddress(ATA_PROGRAM_ID),
          rentDestination: toAddress(payer.publicKey),
          programId: PROGRAM_ID,
        }),
      ], [cancelBuyer]);
    });

    it("acceptOffer", async () => {
      // Create a new offer and accept it (partial — 10 of 200 shares)
      const acceptBuyer = Keypair.generate();
      svm.airdrop(acceptBuyer.publicKey, BigInt(10e9));
      const acceptToken = createTokenAccount(svm, usdcMint, acceptBuyer.publicKey, payer);
      mintTokensTo(svm, usdcMint, acceptToken, 500_000_000_000n, mintAuthority);
      const [accOfferPda] = await getOfferPda(assetTokenAddr, toAddress(acceptBuyer.publicKey), PROGRAM_ID);
      const [accEscrowPda] = await getOfferEscrowPda(accOfferPda, PROGRAM_ID);

      sendTx(svm, [makeOffer({
        config: configAddr, assetAccount: assetAddr,
        assetTokenAccount: assetTokenAddr, offerAccount: accOfferPda,
        escrow: accEscrowPda, buyerTokenAcc: toAddress(acceptToken),
        acceptedMint: toAddress(usdcMint),
        buyer: toAddress(acceptBuyer.publicKey), payer: toAddress(payer.publicKey),
        sharesRequested: 10n, pricePerShare: 2_000_000n, expiry: 0n,
        programId: PROGRAM_ID,
      })], [payer, acceptBuyer]);

      const sellerReceiveToken = createTokenAccount(svm, usdcMint, seller.publicKey, payer);
      const buyerNft = Keypair.generate();
      const [buyerAtPda] = await getAssetTokenPda(assetAddr, 2, PROGRAM_ID);
      const sellerNewNft = Keypair.generate();
      const [sellerNewAtPda] = await getAssetTokenPda(assetAddr, 3, PROGRAM_ID);

      measure("Market", "acceptOffer (partial)", svm, [
        acceptOffer({
          config: configAddr, asset: assetAddr,
          assetToken: assetTokenAddr, offer: accOfferPda,
          escrow: accEscrowPda,
          nft: toAddress(nftKp.publicKey),
          collection: toAddress(collectionKp.publicKey), collectionAuthority: collAuthAddr,
          seller: toAddress(seller.publicKey),
          buyer: toAddress(acceptBuyer.publicKey),
          sellerTokenAcc: toAddress(sellerReceiveToken),
          feeTreasuryToken: toAddress(feeTreasury.publicKey),
          payer: toAddress(payer.publicKey),
          acceptedMint: toAddress(usdcMint),
          ataProgram: toAddress(ATA_PROGRAM_ID),
          rentDestination: toAddress(payer.publicKey),
          partial: {
            newNftBuyer: toAddress(buyerNft.publicKey),
            buyerAssetToken: buyerAtPda,
            newNftSeller: toAddress(sellerNewNft.publicKey),
            sellerAssetToken: sellerNewAtPda,
          },
          programId: PROGRAM_ID,
        }),
      ], [payer, seller, buyerNft, sellerNewNft]);

      // Seller now has token at index 3
      assetTokenAddr = sellerNewAtPda;
      nftKp = sellerNewNft;
    });

    it("transferToken", async () => {
      const recipient = Keypair.generate();

      measure("Market", "transferToken", svm, [
        transferToken({
          config: configAddr, asset: assetAddr,
          assetToken: assetTokenAddr,
          nft: toAddress(nftKp.publicKey),
          collection: toAddress(collectionKp.publicKey), collectionAuthority: collAuthAddr,
          owner: toAddress(seller.publicKey),
          newOwner: toAddress(recipient.publicKey),
          payer: toAddress(payer.publicKey),
          programId: PROGRAM_ID,
        }),
      ], [payer, seller]);
    });

    it("consolidateTokens", async () => {
      // transferToken transferred seller's token, so mint 2 fresh tokens to consolidate
      const nft4 = Keypair.generate();
      const [at4Pda] = await getAssetTokenPda(assetAddr, 4, PROGRAM_ID);
      sendTx(svm, [mintToken({
        config: configAddr, orgAccount: orgAddr, assetAccount: assetAddr,
        assetTokenAccount: at4Pda, collection: toAddress(collectionKp.publicKey),
        collectionAuthority: collAuthAddr, nft: toAddress(nft4.publicKey),
        recipient: toAddress(seller.publicKey),
        authority: toAddress(orgAuthority.publicKey), payer: toAddress(payer.publicKey),
        shares: 50n, programId: PROGRAM_ID,
      })], [payer, orgAuthority, nft4]);

      const nft5 = Keypair.generate();
      const [at5Pda] = await getAssetTokenPda(assetAddr, 5, PROGRAM_ID);
      sendTx(svm, [mintToken({
        config: configAddr, orgAccount: orgAddr, assetAccount: assetAddr,
        assetTokenAccount: at5Pda, collection: toAddress(collectionKp.publicKey),
        collectionAuthority: collAuthAddr, nft: toAddress(nft5.publicKey),
        recipient: toAddress(seller.publicKey),
        authority: toAddress(orgAuthority.publicKey), payer: toAddress(payer.publicKey),
        shares: 50n, programId: PROGRAM_ID,
      })], [payer, orgAuthority, nft5]);

      const newNft = Keypair.generate();
      const [newAtPda] = await getAssetTokenPda(assetAddr, 6, PROGRAM_ID);

      measure("Market", "consolidateTokens (2 sources)", svm, [
        consolidateTokens({
          config: configAddr, asset: assetAddr,
          collection: toAddress(collectionKp.publicKey),
          collectionAuthority: collAuthAddr,
          newNft: toAddress(newNft.publicKey),
          newAssetToken: newAtPda,
          owner: toAddress(seller.publicKey),
          payer: toAddress(payer.publicKey),
          tokens: [
            { assetToken: at4Pda, nft: toAddress(nft4.publicKey) },
            { assetToken: at5Pda, nft: toAddress(nft5.publicKey) },
          ],
          programId: PROGRAM_ID,
        }),
      ], [payer, seller, newNft]);
    });
  });

  // ── Distribution ──

  describe("Distribution", () => {
    let svm: LiteSVM;
    let payer: Keypair;
    let orgAuthority: Keypair;
    let mintAuthority: Keypair;
    let feeTreasury: Keypair;
    let usdcMint: PublicKey;
    let configAddr: Address;
    let orgAddr: Address;
    let assetAddr: Address;
    let assetTokenAddr: Address;
    let investor: Keypair;

    let distPda: Address;
    let distEscrowPda: Address;

    it("createDistribution", async () => {
      svm = createTestSvm({ programId: PROGRAM_PK, loadMplCore: true });
      const operator = Keypair.generate();
      payer = Keypair.generate();
      orgAuthority = Keypair.generate();
      mintAuthority = Keypair.generate();
      feeTreasury = Keypair.generate();
      svm.airdrop(operator.publicKey, BigInt(10e9));
      svm.airdrop(payer.publicKey, BigInt(10e9));
      svm.airdrop(orgAuthority.publicKey, BigInt(10e9));
      usdcMint = createUsdcMint(svm, mintAuthority);
      createTokenAccountAtAddress(svm, usdcMint, payer.publicKey, feeTreasury, payer);

      const [configPda] = await getProtocolConfigPda(PROGRAM_ID);
      configAddr = configPda;
      sendTx(svm, [initializeProtocol({
        config: configAddr, operator: toAddress(operator.publicKey),
        payer: toAddress(payer.publicKey), feeBps: 100,
        feeTreasury: toAddress(feeTreasury.publicKey),
        acceptedMint: toAddress(usdcMint), programId: PROGRAM_ID,
      })], [payer, operator]);

      const [orgPda] = await getOrganizationPda(0, PROGRAM_ID);
      orgAddr = orgPda;
      sendTx(svm, [registerOrganization({
        config: configAddr, orgAccount: orgAddr,
        operator: toAddress(operator.publicKey), payer: toAddress(payer.publicKey),
        authority: toAddress(orgAuthority.publicKey),
        name: "TestOrg", registrationNumber: "REG-001", country: "US",
        programId: PROGRAM_ID,
      })], [payer, operator]);
      sendTx(svm, [updateOrgAddMint({
        config: configAddr, orgAccount: orgAddr,
        authority: toAddress(orgAuthority.publicKey),
        mint: toAddress(usdcMint), programId: PROGRAM_ID,
      })], [orgAuthority]);

      const collectionKp = Keypair.generate();
      const [assetPda] = await getAssetPda(orgAddr, 0, PROGRAM_ID);
      assetAddr = assetPda;
      const [collAuthPda] = await getCollectionAuthorityPda(toAddress(collectionKp.publicKey), PROGRAM_ID);
      sendTx(svm, [initAsset({
        config: configAddr, orgAccount: orgAddr, assetAccount: assetAddr,
        collection: toAddress(collectionKp.publicKey), collectionAuthority: collAuthPda,
        authority: toAddress(orgAuthority.publicKey), payer: toAddress(payer.publicKey),
        totalShares: 1_000_000n, pricePerShare: 1_000_000n,
        acceptedMint: toAddress(usdcMint),
        maturityDate: 0n, maturityGracePeriod: 0n, transferCooldown: 0n, maxHolders: 0,
        name: "TestAsset", uri: "https://example.com/asset.json",
        programId: PROGRAM_ID,
      })], [payer, orgAuthority, collectionKp]);

      // Fundraise + mint
      const [roundPda] = await getFundraisingRoundPda(assetAddr, 0, PROGRAM_ID);
      const [escrowPda] = await getEscrowPda(roundPda, PROGRAM_ID);
      sendTx(svm, [createRound({
        config: configAddr, orgAccount: orgAddr, assetAccount: assetAddr,
        roundAccount: roundPda, escrow: escrowPda, acceptedMint: toAddress(usdcMint),
        authority: toAddress(orgAuthority.publicKey), payer: toAddress(payer.publicKey),
        sharesOffered: 500_000n, pricePerShare: 1_000_000n,
        minRaise: 1_000_000n, maxRaise: 500_000_000_000n,
        minPerWallet: 1n, maxPerWallet: 250_000_000_000n,
        startTime: 0n, endTime: 1_000_000n, lockupEnd: 0n,
        termsHash: new Uint8Array(32), programId: PROGRAM_ID,
      })], [payer, orgAuthority]);

      investor = Keypair.generate();
      svm.airdrop(investor.publicKey, BigInt(10e9));
      const investorToken = createTokenAccount(svm, usdcMint, investor.publicKey, payer);
      mintTokensTo(svm, usdcMint, investorToken, 500_000_000_000n, mintAuthority);
      const [invPda] = await getInvestmentPda(roundPda, toAddress(investor.publicKey), PROGRAM_ID);
      sendTx(svm, [invest({
        config: configAddr, roundAccount: roundPda, investmentAccount: invPda,
        escrow: escrowPda, investorTokenAccount: toAddress(investorToken),
        investor: toAddress(investor.publicKey), payer: toAddress(payer.publicKey),
        shares: 100n, termsHash: new Uint8Array(32), programId: PROGRAM_ID,
      })], [payer, investor]);

      const clock = svm.getClock();
      clock.unixTimestamp = 1_000_001n;
      svm.setClock(clock);
      const orgTreasuryToken = getAtaAddress(orgAuthority.publicKey, usdcMint);
      sendTx(svm, [finalizeRound({
        config: configAddr, assetAccount: assetAddr, roundAccount: roundPda,
        escrow: escrowPda, feeTreasuryToken: toAddress(feeTreasury.publicKey),
        orgTreasuryToken: toAddress(orgTreasuryToken),
        treasuryWallet: toAddress(orgAuthority.publicKey),
        payer: toAddress(payer.publicKey), acceptedMint: toAddress(usdcMint),
        ataProgram: toAddress(ATA_PROGRAM_ID), programId: PROGRAM_ID,
      })], [payer]);

      const nftKp = Keypair.generate();
      const [atPda] = await getAssetTokenPda(assetAddr, 0, PROGRAM_ID);
      assetTokenAddr = atPda;
      sendTx(svm, [mintRoundTokens({
        roundAccount: roundPda, assetAccount: assetAddr,
        collection: toAddress(collectionKp.publicKey), collectionAuthority: collAuthPda,
        payer: toAddress(payer.publicKey),
        investors: [{
          investmentAccount: invPda, assetTokenAccount: assetTokenAddr,
          nft: toAddress(nftKp.publicKey), investor: toAddress(investor.publicKey),
        }],
        programId: PROGRAM_ID,
      })], [payer, nftKp]);

      // Create epoch-0 distribution to advance asset.dividend_epoch to 1.
      // Tokens minted at epoch 0 have last_claimed_epoch=0, so they can only
      // claim distributions with epoch > 0.
      const depositorAcct = createTokenAccount(svm, usdcMint, orgAuthority.publicKey, payer);
      mintTokensTo(svm, usdcMint, depositorAcct, 200_000_000n, mintAuthority);

      const [d0Pda] = await getDistributionPda(assetAddr, 0, PROGRAM_ID);
      const [d0EscrowPda] = await getDistributionEscrowPda(d0Pda, PROGRAM_ID);
      sendTx(svm, [createDistribution({
        config: configAddr, orgAccount: orgAddr, assetAccount: assetAddr,
        distributionAccount: d0Pda, escrow: d0EscrowPda,
        depositorTokenAcc: toAddress(depositorAcct),
        acceptedMint: toAddress(usdcMint),
        authority: toAddress(orgAuthority.publicKey), payer: toAddress(payer.publicKey),
        totalAmount: 1_000_000n, programId: PROGRAM_ID,
      })], [payer, orgAuthority]);

      // Now measure createDistribution at epoch 1
      const [dPda] = await getDistributionPda(assetAddr, 1, PROGRAM_ID);
      distPda = dPda;
      const [dEscrowPda] = await getDistributionEscrowPda(distPda, PROGRAM_ID);
      distEscrowPda = dEscrowPda;

      measure("Distribution", "createDistribution", svm, [
        createDistribution({
          config: configAddr, orgAccount: orgAddr, assetAccount: assetAddr,
          distributionAccount: distPda, escrow: distEscrowPda,
          depositorTokenAcc: toAddress(depositorAcct),
          acceptedMint: toAddress(usdcMint),
          authority: toAddress(orgAuthority.publicKey), payer: toAddress(payer.publicKey),
          totalAmount: 100_000_000n, programId: PROGRAM_ID,
        }),
      ], [payer, orgAuthority]);
    });

    it("claimDistribution", async () => {
      const holderTokenAcc = createTokenAccount(svm, usdcMint, investor.publicKey, payer);

      measure("Distribution", "claimDistribution (1 claim)", svm, [
        claimDistribution({
          distributionAccount: distPda, escrow: distEscrowPda,
          assetAccount: assetAddr,
          payer: toAddress(payer.publicKey), acceptedMint: toAddress(usdcMint),
          ataProgram: toAddress(ATA_PROGRAM_ID),
          claims: [{
            assetTokenAccount: assetTokenAddr,
            holderTokenAcc: toAddress(holderTokenAcc),
            holder: toAddress(investor.publicKey),
          }],
          programId: PROGRAM_ID,
        }),
      ], [payer]);
    });

    it("closeDistribution", async () => {
      const dustRecipient = createTokenAccount(svm, usdcMint, orgAuthority.publicKey, payer);

      measure("Distribution", "closeDistribution", svm, [
        closeDistribution({
          distributionAccount: distPda, escrow: distEscrowPda,
          assetAccount: assetAddr, orgAccount: orgAddr,
          dustRecipient: toAddress(dustRecipient),
          payer: toAddress(payer.publicKey),
          rentDestination: toAddress(payer.publicKey),
          programId: PROGRAM_ID,
        }),
      ], [payer]);
    });
  });

  // ── Emergency ──

  describe("Emergency", () => {
    let svm: LiteSVM;
    let payer: Keypair;
    let orgAuthority: Keypair;
    let mintAuthority: Keypair;
    let usdcMint: PublicKey;
    let configAddr: Address;
    let orgAddr: Address;
    let assetAddr: Address;
    let collectionKp: Keypair;
    let collAuthAddr: Address;

    it("burnAndRemint", async () => {
      svm = createTestSvm({ programId: PROGRAM_PK, loadMplCore: true });
      const operator = Keypair.generate();
      payer = Keypair.generate();
      orgAuthority = Keypair.generate();
      mintAuthority = Keypair.generate();
      svm.airdrop(operator.publicKey, BigInt(10e9));
      svm.airdrop(payer.publicKey, BigInt(10e9));
      svm.airdrop(orgAuthority.publicKey, BigInt(10e9));
      usdcMint = createUsdcMint(svm, mintAuthority);

      const [configPda] = await getProtocolConfigPda(PROGRAM_ID);
      configAddr = configPda;
      sendTx(svm, [initializeProtocol({
        config: configAddr, operator: toAddress(operator.publicKey),
        payer: toAddress(payer.publicKey), feeBps: 100,
        feeTreasury: toAddress(Keypair.generate().publicKey),
        acceptedMint: toAddress(usdcMint), programId: PROGRAM_ID,
      })], [payer, operator]);

      const [orgPda] = await getOrganizationPda(0, PROGRAM_ID);
      orgAddr = orgPda;
      sendTx(svm, [registerOrganization({
        config: configAddr, orgAccount: orgAddr,
        operator: toAddress(operator.publicKey), payer: toAddress(payer.publicKey),
        authority: toAddress(orgAuthority.publicKey),
        name: "TestOrg", registrationNumber: "REG-001", country: "US",
        programId: PROGRAM_ID,
      })], [payer, operator]);
      sendTx(svm, [updateOrgAddMint({
        config: configAddr, orgAccount: orgAddr,
        authority: toAddress(orgAuthority.publicKey),
        mint: toAddress(usdcMint), programId: PROGRAM_ID,
      })], [orgAuthority]);

      collectionKp = Keypair.generate();
      const [assetPda] = await getAssetPda(orgAddr, 0, PROGRAM_ID);
      assetAddr = assetPda;
      const [collAuthPda] = await getCollectionAuthorityPda(toAddress(collectionKp.publicKey), PROGRAM_ID);
      collAuthAddr = collAuthPda;
      sendTx(svm, [initAsset({
        config: configAddr, orgAccount: orgAddr, assetAccount: assetAddr,
        collection: toAddress(collectionKp.publicKey), collectionAuthority: collAuthAddr,
        authority: toAddress(orgAuthority.publicKey), payer: toAddress(payer.publicKey),
        totalShares: 1_000_000n, pricePerShare: 1_000_000n,
        acceptedMint: toAddress(usdcMint),
        maturityDate: 0n, maturityGracePeriod: 0n, transferCooldown: 0n, maxHolders: 0,
        name: "TestAsset", uri: "https://example.com/asset.json",
        programId: PROGRAM_ID,
      })], [payer, orgAuthority, collectionKp]);

      // Create round to set asset status to Fundraising (required for mintToken)
      const [roundPda] = await getFundraisingRoundPda(assetAddr, 0, PROGRAM_ID);
      const [escrowPda] = await getEscrowPda(roundPda, PROGRAM_ID);
      sendTx(svm, [createRound({
        config: configAddr, orgAccount: orgAddr, assetAccount: assetAddr,
        roundAccount: roundPda, escrow: escrowPda, acceptedMint: toAddress(usdcMint),
        authority: toAddress(orgAuthority.publicKey), payer: toAddress(payer.publicKey),
        sharesOffered: 500_000n, pricePerShare: 1_000_000n,
        minRaise: 1_000_000n, maxRaise: 500_000_000_000n,
        minPerWallet: 1n, maxPerWallet: 250_000_000_000n,
        startTime: 0n, endTime: 1_000_000n, lockupEnd: 0n,
        termsHash: new Uint8Array(32), programId: PROGRAM_ID,
      })], [payer, orgAuthority]);

      // Mint a token (authority can mint during fundraising)
      const oldNftKp = Keypair.generate();
      const [atPda] = await getAssetTokenPda(assetAddr, 0, PROGRAM_ID);
      const oldOwner = Keypair.generate();
      sendTx(svm, [mintToken({
        config: configAddr, orgAccount: orgAddr, assetAccount: assetAddr,
        assetTokenAccount: atPda, collection: toAddress(collectionKp.publicKey),
        collectionAuthority: collAuthAddr, nft: toAddress(oldNftKp.publicKey),
        recipient: toAddress(oldOwner.publicKey),
        authority: toAddress(orgAuthority.publicKey), payer: toAddress(payer.publicKey),
        shares: 100n, programId: PROGRAM_ID,
      })], [payer, orgAuthority, oldNftKp]);

      // Burn and remint
      const newNftKp = Keypair.generate();
      const newOwner = Keypair.generate();
      const [newAtPda] = await getAssetTokenPda(assetAddr, 1, PROGRAM_ID);
      const [emergencyRecordPda] = await getEmergencyRecordPda(atPda, PROGRAM_ID);

      measure("Emergency", "burnAndRemint", svm, [
        burnAndRemint({
          orgAccount: orgAddr, assetAccount: assetAddr,
          oldAssetTokenAccount: atPda, oldNft: toAddress(oldNftKp.publicKey),
          collection: toAddress(collectionKp.publicKey), collectionAuthority: collAuthAddr,
          newNft: toAddress(newNftKp.publicKey), newAssetTokenAccount: newAtPda,
          newOwner: toAddress(newOwner.publicKey),
          emergencyRecordAccount: emergencyRecordPda,
          orgAuthority: toAddress(orgAuthority.publicKey),
          payer: toAddress(payer.publicKey),
          reason: 0, sharesToTransfer: 0n,
          programId: PROGRAM_ID,
        }),
      ], [payer, orgAuthority, newNftKp]);
    });

    it("splitAndRemint", async () => {
      // Mint another token to split
      const oldNft2 = Keypair.generate();
      const [at2Pda] = await getAssetTokenPda(assetAddr, 2, PROGRAM_ID);
      const oldOwner2 = Keypair.generate();
      sendTx(svm, [mintToken({
        config: configAddr, orgAccount: orgAddr, assetAccount: assetAddr,
        assetTokenAccount: at2Pda, collection: toAddress(collectionKp.publicKey),
        collectionAuthority: collAuthAddr, nft: toAddress(oldNft2.publicKey),
        recipient: toAddress(oldOwner2.publicKey),
        authority: toAddress(orgAuthority.publicKey), payer: toAddress(payer.publicKey),
        shares: 100n, programId: PROGRAM_ID,
      })], [payer, orgAuthority, oldNft2]);

      const newNftA = Keypair.generate();
      const newNftB = Keypair.generate();
      const [newAtA] = await getAssetTokenPda(assetAddr, 3, PROGRAM_ID);
      const [newAtB] = await getAssetTokenPda(assetAddr, 4, PROGRAM_ID);
      const recipientA = Keypair.generate();
      const recipientB = Keypair.generate();
      const [emergRecPda] = await getEmergencyRecordPda(at2Pda, PROGRAM_ID);

      measure("Emergency", "splitAndRemint (2 recipients)", svm, [
        splitAndRemint({
          orgAccount: orgAddr, assetAccount: assetAddr,
          oldAssetTokenAccount: at2Pda, oldNft: toAddress(oldNft2.publicKey),
          collection: toAddress(collectionKp.publicKey), collectionAuthority: collAuthAddr,
          emergencyRecordAccount: emergRecPda,
          orgAuthority: toAddress(orgAuthority.publicKey),
          payer: toAddress(payer.publicKey),
          recipients: [
            { newNft: toAddress(newNftA.publicKey), newAssetTokenAccount: newAtA, recipient: toAddress(recipientA.publicKey), shares: 60n },
            { newNft: toAddress(newNftB.publicKey), newAssetTokenAccount: newAtB, recipient: toAddress(recipientB.publicKey), shares: 40n },
          ],
          programId: PROGRAM_ID,
        }),
      ], [payer, orgAuthority, newNftA, newNftB]);
    });
  });

  // ── Buyout ──

  describe("Buyout", () => {
    let svm: LiteSVM;
    let payer: Keypair;
    let orgAuthority: Keypair;
    let mintAuthority: Keypair;
    let feeTreasury: Keypair;
    let usdcMint: PublicKey;
    let configAddr: Address;
    let orgAddr: Address;
    let assetAddr: Address;
    let buyer: Keypair;

    it("createBuyoutOffer", async () => {
      svm = createTestSvm({ programId: PROGRAM_PK, loadMplCore: true });
      const operator = Keypair.generate();
      payer = Keypair.generate();
      orgAuthority = Keypair.generate();
      mintAuthority = Keypair.generate();
      feeTreasury = Keypair.generate();
      buyer = Keypair.generate();
      svm.airdrop(operator.publicKey, BigInt(10e9));
      svm.airdrop(payer.publicKey, BigInt(10e9));
      svm.airdrop(orgAuthority.publicKey, BigInt(10e9));
      svm.airdrop(buyer.publicKey, BigInt(10e9));
      usdcMint = createUsdcMint(svm, mintAuthority);
      createTokenAccountAtAddress(svm, usdcMint, payer.publicKey, feeTreasury, payer);

      const [configPda] = await getProtocolConfigPda(PROGRAM_ID);
      configAddr = configPda;
      sendTx(svm, [initializeProtocol({
        config: configAddr, operator: toAddress(operator.publicKey),
        payer: toAddress(payer.publicKey), feeBps: 100,
        feeTreasury: toAddress(feeTreasury.publicKey),
        acceptedMint: toAddress(usdcMint), programId: PROGRAM_ID,
      })], [payer, operator]);

      const [orgPda] = await getOrganizationPda(0, PROGRAM_ID);
      orgAddr = orgPda;
      sendTx(svm, [registerOrganization({
        config: configAddr, orgAccount: orgAddr,
        operator: toAddress(operator.publicKey), payer: toAddress(payer.publicKey),
        authority: toAddress(orgAuthority.publicKey),
        name: "TestOrg", registrationNumber: "REG-001", country: "US",
        programId: PROGRAM_ID,
      })], [payer, operator]);
      sendTx(svm, [updateOrgAddMint({
        config: configAddr, orgAccount: orgAddr,
        authority: toAddress(orgAuthority.publicKey),
        mint: toAddress(usdcMint), programId: PROGRAM_ID,
      })], [orgAuthority]);

      const collectionKp = Keypair.generate();
      const [assetPda] = await getAssetPda(orgAddr, 0, PROGRAM_ID);
      assetAddr = assetPda;
      const [collAuthPda] = await getCollectionAuthorityPda(toAddress(collectionKp.publicKey), PROGRAM_ID);
      sendTx(svm, [initAsset({
        config: configAddr, orgAccount: orgAddr, assetAccount: assetAddr,
        collection: toAddress(collectionKp.publicKey), collectionAuthority: collAuthPda,
        authority: toAddress(orgAuthority.publicKey), payer: toAddress(payer.publicKey),
        totalShares: 1_000_000n, pricePerShare: 1_000_000n,
        acceptedMint: toAddress(usdcMint),
        maturityDate: 0n, maturityGracePeriod: 0n, transferCooldown: 0n, maxHolders: 0,
        name: "TestAsset", uri: "https://example.com/asset.json",
        programId: PROGRAM_ID,
      })], [payer, orgAuthority, collectionKp]);

      // Patch asset: set native_treasury to non-zero and status to Active
      patchAssetField(svm, toPublicKey(assetAddr), 88, new Uint8Array([AssetStatus.Active]));
      patchAssetField(svm, toPublicKey(assetAddr), 162, Keypair.generate().publicKey.toBytes());

      const [offerPda] = await getBuyoutOfferPda(assetAddr, toAddress(buyer.publicKey), PROGRAM_ID);

      measure("Buyout", "createBuyoutOffer", svm, [
        createBuyoutOffer({
          config: configAddr, org: orgAddr, asset: assetAddr,
          buyoutOffer: offerPda, acceptedMint: toAddress(usdcMint),
          buyer: toAddress(buyer.publicKey), payer: toAddress(payer.publicKey),
          pricePerShare: 1_200_000n, isCouncilBuyout: false,
          treasuryDisposition: 0,
          broker: toAddress(PublicKey.default), brokerBps: 0,
          termsHash: new Uint8Array(32), expiry: 10_000_000n,
          programId: PROGRAM_ID,
        }),
      ], [payer, buyer]);
    });

    it("fundBuyoutOffer", async () => {
      const buyerUsdcAcct = createTokenAccount(svm, usdcMint, buyer.publicKey, payer);
      mintTokensTo(svm, usdcMint, buyerUsdcAcct, 10_000_000_000n, mintAuthority);
      const [offerPda] = await getBuyoutOfferPda(assetAddr, toAddress(buyer.publicKey), PROGRAM_ID);
      const [escrowPda] = await getBuyoutEscrowPda(offerPda, PROGRAM_ID);

      measure("Buyout", "fundBuyoutOffer", svm, [
        fundBuyoutOffer({
          buyoutOffer: offerPda, asset: assetAddr, escrow: escrowPda,
          buyerTokenAcc: toAddress(buyerUsdcAcct),
          acceptedMint: toAddress(usdcMint),
          buyer: toAddress(buyer.publicKey), payer: toAddress(payer.publicKey),
          programId: PROGRAM_ID,
        }),
      ], [payer, buyer]);
    });

    it("cancelBuyout", async () => {
      const buyerUsdcAcct = createTokenAccount(svm, usdcMint, buyer.publicKey, payer);
      const [offerPda] = await getBuyoutOfferPda(assetAddr, toAddress(buyer.publicKey), PROGRAM_ID);
      const [escrowPda] = await getBuyoutEscrowPda(offerPda, PROGRAM_ID);

      measure("Buyout", "cancelBuyout", svm, [
        cancelBuyout({
          buyoutOffer: offerPda, asset: assetAddr,
          buyer: toAddress(buyer.publicKey),
          rentDestination: toAddress(payer.publicKey),
          escrow: escrowPda,
          buyerTokenAcc: toAddress(buyerUsdcAcct),
          tokenProgram: toAddress(TOKEN_PROGRAM_ID),
          programId: PROGRAM_ID,
        }),
      ], [buyer]);
    });
  });

  // ── Governance ──

  describe("Governance", () => {
    let svm: LiteSVM;
    let payer: Keypair;
    let orgAuthority: Keypair;
    let mintAuthority: Keypair;
    let usdcMint: PublicKey;
    let configAddr: Address;
    let orgAddr: Address;
    let assetAddr: Address;
    let collectionKp: Keypair;
    let collAuthAddr: Address;
    let investor: Keypair;
    let assetTokenAddr: Address;

    let realmAddr: Address;
    let communityMint: PublicKey;
    let councilMint: PublicKey;
    let realmAuthority: Keypair;
    let govAddr: Address;
    let nativeTreasuryAddr: Address;

    it("createOrgRealm", async () => {
      svm = createTestSvm({ programId: PROGRAM_PK, loadMplCore: true, loadSplGov: true });
      const operator = Keypair.generate();
      payer = Keypair.generate();
      orgAuthority = Keypair.generate();
      mintAuthority = Keypair.generate();
      const feeTreasury = Keypair.generate();
      svm.airdrop(operator.publicKey, BigInt(10e9));
      svm.airdrop(payer.publicKey, BigInt(10e9));
      svm.airdrop(orgAuthority.publicKey, BigInt(10e9));
      usdcMint = createUsdcMint(svm, mintAuthority);
      createTokenAccountAtAddress(svm, usdcMint, payer.publicKey, feeTreasury, payer);

      const [configPda] = await getProtocolConfigPda(PROGRAM_ID);
      configAddr = configPda;
      sendTx(svm, [initializeProtocol({
        config: configAddr, operator: toAddress(operator.publicKey),
        payer: toAddress(payer.publicKey), feeBps: 100,
        feeTreasury: toAddress(feeTreasury.publicKey),
        acceptedMint: toAddress(usdcMint), programId: PROGRAM_ID,
      })], [payer, operator]);

      const [orgPda] = await getOrganizationPda(0, PROGRAM_ID);
      orgAddr = orgPda;
      sendTx(svm, [registerOrganization({
        config: configAddr, orgAccount: orgAddr,
        operator: toAddress(operator.publicKey), payer: toAddress(payer.publicKey),
        authority: toAddress(orgAuthority.publicKey),
        name: "TestOrg", registrationNumber: "REG-001", country: "US",
        programId: PROGRAM_ID,
      })], [payer, operator]);
      sendTx(svm, [updateOrgAddMint({
        config: configAddr, orgAccount: orgAddr,
        authority: toAddress(orgAuthority.publicKey),
        mint: toAddress(usdcMint), programId: PROGRAM_ID,
      })], [orgAuthority]);

      collectionKp = Keypair.generate();
      const [assetPda] = await getAssetPda(orgAddr, 0, PROGRAM_ID);
      assetAddr = assetPda;
      const [collAuthPda] = await getCollectionAuthorityPda(toAddress(collectionKp.publicKey), PROGRAM_ID);
      collAuthAddr = collAuthPda;
      sendTx(svm, [initAsset({
        config: configAddr, orgAccount: orgAddr, assetAccount: assetAddr,
        collection: toAddress(collectionKp.publicKey), collectionAuthority: collAuthAddr,
        authority: toAddress(orgAuthority.publicKey), payer: toAddress(payer.publicKey),
        totalShares: 1_000_000n, pricePerShare: 1_000_000n,
        acceptedMint: toAddress(usdcMint),
        maturityDate: 0n, maturityGracePeriod: 0n, transferCooldown: 0n, maxHolders: 0,
        name: "TestAsset", uri: "https://example.com/asset.json",
        programId: PROGRAM_ID,
      })], [payer, orgAuthority, collectionKp]);

      // Fundraise + mint token for investor
      const [roundPda] = await getFundraisingRoundPda(assetAddr, 0, PROGRAM_ID);
      const [escrowPda] = await getEscrowPda(roundPda, PROGRAM_ID);
      sendTx(svm, [createRound({
        config: configAddr, orgAccount: orgAddr, assetAccount: assetAddr,
        roundAccount: roundPda, escrow: escrowPda, acceptedMint: toAddress(usdcMint),
        authority: toAddress(orgAuthority.publicKey), payer: toAddress(payer.publicKey),
        sharesOffered: 500_000n, pricePerShare: 1_000_000n,
        minRaise: 100_000_000n, maxRaise: 500_000_000_000n,
        minPerWallet: 1_000_000n, maxPerWallet: 250_000_000_000n,
        startTime: 0n, endTime: 1_000_000n, lockupEnd: 0n,
        termsHash: new Uint8Array(32), programId: PROGRAM_ID,
      })], [payer, orgAuthority]);

      investor = Keypair.generate();
      svm.airdrop(investor.publicKey, BigInt(10e9));
      const investorToken = createTokenAccount(svm, usdcMint, investor.publicKey, payer);
      mintTokensTo(svm, usdcMint, investorToken, 200_000_000n, mintAuthority);
      const [invPda] = await getInvestmentPda(roundPda, toAddress(investor.publicKey), PROGRAM_ID);
      sendTx(svm, [invest({
        config: configAddr, roundAccount: roundPda, investmentAccount: invPda,
        escrow: escrowPda, investorTokenAccount: toAddress(investorToken),
        investor: toAddress(investor.publicKey), payer: toAddress(payer.publicKey),
        shares: 100n, termsHash: new Uint8Array(32), programId: PROGRAM_ID,
      })], [payer, investor]);

      const clock = svm.getClock();
      clock.unixTimestamp = 1_000_001n;
      svm.setClock(clock);
      const orgTreasuryToken = getAtaAddress(orgAuthority.publicKey, usdcMint);
      sendTx(svm, [finalizeRound({
        config: configAddr, assetAccount: assetAddr, roundAccount: roundPda,
        escrow: escrowPda, feeTreasuryToken: toAddress(feeTreasury.publicKey),
        orgTreasuryToken: toAddress(orgTreasuryToken),
        treasuryWallet: toAddress(orgAuthority.publicKey),
        payer: toAddress(payer.publicKey), acceptedMint: toAddress(usdcMint),
        ataProgram: toAddress(ATA_PROGRAM_ID), programId: PROGRAM_ID,
      })], [payer]);

      const nftKp = Keypair.generate();
      const [atPda] = await getAssetTokenPda(assetAddr, 0, PROGRAM_ID);
      assetTokenAddr = atPda;
      sendTx(svm, [mintRoundTokens({
        roundAccount: roundPda, assetAccount: assetAddr,
        collection: toAddress(collectionKp.publicKey), collectionAuthority: collAuthAddr,
        payer: toAddress(payer.publicKey),
        investors: [{
          investmentAccount: invPda, assetTokenAccount: assetTokenAddr,
          nft: toAddress(nftKp.publicKey), investor: toAddress(investor.publicKey),
        }],
        programId: PROGRAM_ID,
      })], [payer, nftKp]);

      // Create org realm
      councilMint = createUsdcMint(svm, mintAuthority, 0);
      communityMint = createUsdcMint(svm, mintAuthority, 0);
      const realmName = "OrgRealm";
      const [rAddr] = await getRealmAddress(realmName, GOV_PROGRAM);
      realmAddr = rAddr;
      const [communityHolding] = await getTokenHoldingAddress(realmAddr, toAddress(communityMint), GOV_PROGRAM);
      const [councilHolding] = await getTokenHoldingAddress(realmAddr, toAddress(councilMint), GOV_PROGRAM);
      const [realmConfigAddr] = await getRealmConfigAddress(realmAddr, GOV_PROGRAM);
      realmAuthority = Keypair.generate();
      svm.airdrop(realmAuthority.publicKey, BigInt(10e9));
      const [gAddr] = await getGovernanceAddress(realmAddr, orgAddr, GOV_PROGRAM);
      govAddr = gAddr;
      const [ntAddr] = await getNativeTreasuryAddress(govAddr, GOV_PROGRAM);
      nativeTreasuryAddr = ntAddr;

      const govConfig: GovernanceConfig = {
        communityVoteThreshold: { type: VoteThresholdType.Disabled, value: 0 },
        minCommunityWeightToCreateProposal: 1n,
        minTransactionHoldUpTime: 0,
        votingBaseTime: 3600,
        communityVoteTipping: 0,
        councilVoteThreshold: { type: VoteThresholdType.YesVotePercentage, value: 60 },
        councilVetoVoteThreshold: { type: VoteThresholdType.Disabled, value: 0 },
        minCouncilWeightToCreateProposal: 1n,
        councilVoteTipping: 0,
        communityVetoVoteThreshold: { type: VoteThresholdType.Disabled, value: 0 },
        votingCoolOffTime: 0,
        depositExemptProposalCount: 10,
      };

      measure("Governance", "createOrgRealm", svm, [
        createOrgRealm({
          config: configAddr, orgAccount: orgAddr, realm: realmAddr,
          realmAuthority: toAddress(realmAuthority.publicKey),
          councilMint: toAddress(councilMint), councilHolding,
          communityMint: toAddress(communityMint), communityHolding,
          realmConfig: realmConfigAddr,
          authority: toAddress(orgAuthority.publicKey), payer: toAddress(payer.publicKey),
          governanceProgram: GOV_PROGRAM, splTokenProgram: toAddress(TOKEN_PROGRAM_ID),
          rentSysvar: RENT_SYSVAR, voterWeightAddin: PROGRAM_ID,
          maxVoterWeightAddin: PROGRAM_ID,
          governance: govAddr, nativeTreasury: nativeTreasuryAddr,
          realmName, governanceConfigData: encodeGovernanceConfig(govConfig),
          programId: PROGRAM_ID,
        }),
      ], [payer, orgAuthority, realmAuthority]);
    });

    it("createRegistrar", async () => {
      const govTokenMint = toAddress(councilMint);
      const [registrarAddr] = await getRegistrarPda(realmAddr, govTokenMint, PROGRAM_ID);

      measure("Governance", "createRegistrar", svm, [
        createRegistrar({
          realm: realmAddr, governingTokenMint: govTokenMint,
          assetAccount: assetAddr, registrarAccount: registrarAddr,
          realmAuthority: toAddress(realmAuthority.publicKey),
          payer: toAddress(payer.publicKey),
          governanceProgramId: GOV_PROGRAM, programId: PROGRAM_ID,
        }),
      ], [payer, realmAuthority]);
    });

    it("createVoterWeightRecord", async () => {
      const govTokenMint = toAddress(councilMint);
      const investorAddr = toAddress(investor.publicKey);
      const [vwrAddr] = await getVoterWeightRecordPda(realmAddr, govTokenMint, investorAddr, PROGRAM_ID);

      measure("Governance", "createVoterWeightRecord", svm, [
        createVoterWeightRecord({
          registrarAccount: (await getRegistrarPda(realmAddr, govTokenMint, PROGRAM_ID))[0],
          voterWeightRecordAccount: vwrAddr,
          governingTokenOwner: investorAddr,
          payer: toAddress(payer.publicKey), programId: PROGRAM_ID,
        }),
      ], [payer]);
    });

    it("createMaxVoterWeightRecord", async () => {
      const govTokenMint = toAddress(councilMint);
      const [mvwrAddr] = await getMaxVoterWeightRecordPda(realmAddr, govTokenMint, PROGRAM_ID);

      measure("Governance", "createMaxVoterWeightRecord", svm, [
        createMaxVoterWeightRecord({
          registrarAccount: (await getRegistrarPda(realmAddr, govTokenMint, PROGRAM_ID))[0],
          assetAccount: assetAddr,
          maxVoterWeightRecordAccount: mvwrAddr,
          realm: realmAddr,
          payer: toAddress(payer.publicKey), programId: PROGRAM_ID,
        }),
      ], [payer]);
    });

    it("createAssetGovernance", async () => {
      const [assetGovAddr] = await getGovernanceAddress(realmAddr, assetAddr, GOV_PROGRAM);
      const [assetNtAddr] = await getNativeTreasuryAddress(assetGovAddr, GOV_PROGRAM);
      const [realmConfigAddr] = await getRealmConfigAddress(realmAddr, GOV_PROGRAM);
      const [torAddr] = await getTokenOwnerRecordAddress(
        realmAddr, toAddress(councilMint), toAddress(realmAuthority.publicKey), GOV_PROGRAM,
      );

      // Create TOR for realm authority
      const [councilHoldingAddr] = await getTokenHoldingAddress(realmAddr, toAddress(councilMint), GOV_PROGRAM);
      const councilTokenAccount = createTokenAccount(svm, councilMint, realmAuthority.publicKey, payer);
      mintTokensTo(svm, councilMint, councilTokenAccount, 1n, mintAuthority);
      sendTx(svm, [
        depositGoverningTokens({
          realm: realmAddr,
          governingTokenHolding: councilHoldingAddr,
          governingTokenSource: toAddress(councilTokenAccount),
          governingTokenOwner: toAddress(realmAuthority.publicKey),
          governingTokenTransferAuthority: toAddress(realmAuthority.publicKey),
          tokenOwnerRecord: torAddr,
          payer: toAddress(payer.publicKey),
          splTokenProgram: toAddress(TOKEN_PROGRAM_ID),
          realmConfig: realmConfigAddr,
          amount: 1n, programId: GOV_PROGRAM,
        }),
      ], [payer, realmAuthority]);

      const govConfig: GovernanceConfig = {
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

      measure("Governance", "createAssetGovernance", svm, [
        createAssetGovernance({
          config: configAddr, organization: orgAddr, asset: assetAddr,
          authority: toAddress(orgAuthority.publicKey), realm: realmAddr,
          governance: assetGovAddr, tokenOwnerRecord: torAddr,
          governanceAuthority: toAddress(realmAuthority.publicKey),
          realmConfig: realmConfigAddr, payer: toAddress(payer.publicKey),
          governanceProgram: GOV_PROGRAM, nativeTreasury: assetNtAddr,
          governanceConfigData: encodeGovernanceConfig(govConfig),
          programId: PROGRAM_ID,
        }),
      ], [payer, realmAuthority, orgAuthority]);
    });
  });
});
