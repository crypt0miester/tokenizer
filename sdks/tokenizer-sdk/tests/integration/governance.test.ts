import { describe, it, expect, beforeEach } from "vitest";
import {
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { type LiteSVM, type FailedTransactionMetadata } from "litesvm";
import {
  address,
  type Address,
  getAddressEncoder,
  getProgramDerivedAddress,
  getUtf8Encoder,
} from "gill";
import {
  createTestSvm,
  sendTx,
  getAccountData,
  toAddress,
  toPublicKey,
  createUsdcMint,
  createTokenAccount,
  mintTokensTo,
  TOKEN_PROGRAM_ID,
  ATA_PROGRAM_ID,
  SPL_TOKEN_ACCOUNT_LEN,
} from "../helpers/setup.js";
import { decodeProtocolConfig } from "../../src/accounts/protocolConfig.js";
import { decodeOrganization } from "../../src/accounts/organization.js";
import { decodeAsset } from "../../src/accounts/asset.js";
import { decodeAssetToken } from "../../src/accounts/assetToken.js";
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
  createRegistrar,
  createVoterWeightRecord,
  createMaxVoterWeightRecord,
  updateVoterWeightRecord,
  relinquishVoterWeight,
  createProtocolRealm,
  createOrgRealm,
  createAssetGovernance,
} from "../../src/instructions/governance.js";
import {
  getProtocolConfigPda,
  getOrganizationPda,
  getAssetPda,
  getAssetTokenPda,
  getCollectionAuthorityPda,
  getFundraisingRoundPda,
  getEscrowPda,
  getInvestmentPda,
  getProposalSeedPda,
} from "../../src/pdas.js";
import {
  REGISTRAR_SEED,
  VOTER_WEIGHT_RECORD_SEED,
  MAX_VOTER_WEIGHT_RECORD_SEED,
  AccountKey,
} from "../../src/constants.js";
import {
  SPL_GOVERNANCE_PROGRAM_ID,
  GovernanceAccountType,
  VoteThresholdType,
} from "../../src/external/governance/constants.js";
import {
  getRealmAddress,
  getTokenHoldingAddress,
  getRealmConfigAddress,
  getTokenOwnerRecordAddress,
  getGovernanceAddress,
  getNativeTreasuryAddress,
  getProposalAddress,
} from "../../src/external/governance/pdas.js";
import {
  depositGoverningTokens,
  createProposal,
  cancelProposal,
  encodeGovernanceConfig,
  type GovernanceConfig,
} from "../../src/external/governance/instructions.js";

// ── Constants ────────────────────────────────────────────────────────

const PROGRAM_ID = address("FNDZziaztYptbydC5UpLEaLMyFN4rDmP3G2MN7o6w4ZK");
const PROGRAM_PK = new PublicKey("FNDZziaztYptbydC5UpLEaLMyFN4rDmP3G2MN7o6w4ZK");
const GOV_PROGRAM = SPL_GOVERNANCE_PROGRAM_ID;
const GOV_PK = new PublicKey(GOV_PROGRAM);
const RENT_SYSVAR = address("SysvarRent111111111111111111111111111111111");

const utf8Enc = getUtf8Encoder();
const addrEnc = getAddressEncoder();

function seed(s: string) {
  return utf8Enc.encode(s);
}
function addrSeed(a: Address) {
  return addrEnc.encode(a);
}

/** Derive registrar PDA: ["registrar", realm, governingTokenMint] */
async function getRegistrarPda(
  realm: Address,
  governingTokenMint: Address,
): Promise<[Address, number]> {
  const [addr, bump] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ID,
    seeds: [seed(REGISTRAR_SEED), addrSeed(realm), addrSeed(governingTokenMint)],
  });
  return [addr, bump];
}

/** Derive voter weight record PDA */
async function getVoterWeightRecordPda(
  realm: Address,
  governingTokenMint: Address,
  governingTokenOwner: Address,
): Promise<[Address, number]> {
  const [addr, bump] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ID,
    seeds: [
      seed(VOTER_WEIGHT_RECORD_SEED),
      addrSeed(realm),
      addrSeed(governingTokenMint),
      addrSeed(governingTokenOwner),
    ],
  });
  return [addr, bump];
}

/** Derive max voter weight record PDA */
async function getMaxVoterWeightRecordPda(
  realm: Address,
  governingTokenMint: Address,
): Promise<[Address, number]> {
  const [addr, bump] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ID,
    seeds: [
      seed(MAX_VOTER_WEIGHT_RECORD_SEED),
      addrSeed(realm),
      addrSeed(governingTokenMint),
    ],
  });
  return [addr, bump];
}

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

// ── Test Suite ───────────────────────────────────────────────────────

describe("Governance Integration", () => {
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

  // Investor with minted tokens
  let investor: Keypair;
  let assetTokenAddr: Address;

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

    // ── Fundraising: 1 investor, 100 shares ──

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
    const [invPda] = await getInvestmentPda(
      roundPda,
      toAddress(investor.publicKey),
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

    // Mint tokens
    const nftKp = Keypair.generate();
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
  });

  // ── Test 1: org realm creation ───────────────────────────────────────

  it("create org realm stores realm in org account", async () => {
    const asset = decodeAsset(getAccountData(svm, assetAddr));
    expect(asset.mintedShares).toBe(100n);

    // Create mints for realm
    const councilMint = createUsdcMint(svm, mintAuthority, 0);
    const communityMint = createUsdcMint(svm, mintAuthority, 0);

    const realmName = "OrgRealm";
    const [realmAddr] = await getRealmAddress(realmName, GOV_PROGRAM);
    const [communityHolding] = await getTokenHoldingAddress(
      realmAddr,
      toAddress(communityMint),
      GOV_PROGRAM,
    );
    const [councilHolding] = await getTokenHoldingAddress(
      realmAddr,
      toAddress(councilMint),
      GOV_PROGRAM,
    );
    const [realmConfigAddr] = await getRealmConfigAddress(realmAddr, GOV_PROGRAM);

    // Realm authority must sign (needed for CreateGovernance CPI)
    const realmAuthority = Keypair.generate();
    svm.airdrop(realmAuthority.publicKey, BigInt(10_000_000_000));

    // Derive governance + native treasury PDAs
    const [govAddr] = await getGovernanceAddress(realmAddr, orgAddr, GOV_PROGRAM);
    const [nativeTreasuryAddr] = await getNativeTreasuryAddress(govAddr, GOV_PROGRAM);

    // Org governance is council-only: communityVoteThreshold = Disabled
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

    sendTx(
      svm,
      [
        createOrgRealm({
          config: configAddr,
          orgAccount: orgAddr,
          realm: realmAddr,
          realmAuthority: toAddress(realmAuthority.publicKey),
          councilMint: toAddress(councilMint),
          councilHolding,
          communityMint: toAddress(communityMint),
          communityHolding,
          realmConfig: realmConfigAddr,
          authority: toAddress(orgAuthority.publicKey),
          payer: toAddress(payer.publicKey),
          governanceProgram: GOV_PROGRAM,
          splTokenProgram: toAddress(TOKEN_PROGRAM_ID),
          rentSysvar: RENT_SYSVAR,
          voterWeightAddin: PROGRAM_ID,
          maxVoterWeightAddin: PROGRAM_ID,
          governance: govAddr,
          nativeTreasury: nativeTreasuryAddr,
          realmName,
          governanceConfigData: encodeGovernanceConfig(govConfig),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, orgAuthority, realmAuthority],
    );

    // Verify org.realm is set
    const org = decodeOrganization(getAccountData(svm, orgAddr));
    expect(org.realm).toBe(realmAddr);

    // Verify realm account exists and is owned by governance program
    const realmAcct = svm.getAccount(toPublicKey(realmAddr));
    expect(realmAcct).not.toBeNull();
    expect(toAddress(realmAcct!.owner)).toBe(GOV_PROGRAM);
    // Byte 0 should be RealmV2 account type (16)
    expect(realmAcct!.data[0]).toBe(GovernanceAccountType.RealmV2);

    // Verify governance account exists
    const govAcct = svm.getAccount(toPublicKey(govAddr));
    expect(govAcct).not.toBeNull();
    expect(toAddress(govAcct!.owner)).toBe(GOV_PROGRAM);
    expect(govAcct!.data[0]).toBe(GovernanceAccountType.GovernanceV2);

    // Verify native treasury account exists
    const treasuryAcct = svm.getAccount(toPublicKey(nativeTreasuryAddr));
    expect(treasuryAcct).not.toBeNull();
  });

  // ── Test 2: protocol realm creation ─────────────────────────────────

  it("create protocol realm stores realm and governance in config and transfers operator", async () => {
    const councilMint = createUsdcMint(svm, mintAuthority, 0);
    const communityMint = createUsdcMint(svm, mintAuthority, 0);

    const realmName = "ProtocolRealm";
    const [realmAddr] = await getRealmAddress(realmName, GOV_PROGRAM);
    const [communityHolding] = await getTokenHoldingAddress(
      realmAddr,
      toAddress(communityMint),
      GOV_PROGRAM,
    );
    const [councilHolding] = await getTokenHoldingAddress(
      realmAddr,
      toAddress(councilMint),
      GOV_PROGRAM,
    );
    const [realmConfigAddr] = await getRealmConfigAddress(realmAddr, GOV_PROGRAM);

    // Derive governance PDA (governance_seed = config)
    const [govAddr] = await getGovernanceAddress(realmAddr, configAddr, GOV_PROGRAM);
    const [nativeTreasuryAddr] = await getNativeTreasuryAddress(govAddr, GOV_PROGRAM);

    const govConfig: GovernanceConfig = {
      communityVoteThreshold: { type: VoteThresholdType.YesVotePercentage, value: 60 },
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

    // Create a council token source for the initial member (operator)
    const councilTokenSource = createTokenAccount(svm, councilMint, operator.publicKey, payer);
    mintTokensTo(svm, councilMint, councilTokenSource, 1n, mintAuthority);

    const [operatorTor] = await getTokenOwnerRecordAddress(
      realmAddr,
      toAddress(councilMint),
      toAddress(operator.publicKey),
      GOV_PROGRAM,
    );

    sendTx(
      svm,
      [
        createProtocolRealm({
          config: configAddr,
          realm: realmAddr,
          realmAuthority: toAddress(operator.publicKey),
          communityMint: toAddress(communityMint),
          communityHolding,
          councilMint: toAddress(councilMint),
          councilHolding,
          realmConfig: realmConfigAddr,
          payer: toAddress(payer.publicKey),
          governanceProgram: GOV_PROGRAM,
          splTokenProgram: toAddress(TOKEN_PROGRAM_ID),
          rentSysvar: RENT_SYSVAR,
          governance: govAddr,
          nativeTreasury: nativeTreasuryAddr,
          realmName,
          governanceConfigData: encodeGovernanceConfig(govConfig),
          members: [
            {
              tokenSource: toAddress(councilTokenSource),
              wallet: toAddress(operator.publicKey),
              tokenOwnerRecord: operatorTor,
            },
          ],
          programId: PROGRAM_ID,
        }),
      ],
      [payer, operator],
    );

    // Verify config.realm, config.governance, and operator transfer
    const config = decodeProtocolConfig(getAccountData(svm, configAddr));
    expect(config.realm).toBe(realmAddr);
    expect(config.governance).toBe(govAddr);
    expect(config.operator).toBe(govAddr);

    // Verify realm account exists
    const realmAcct = svm.getAccount(toPublicKey(realmAddr));
    expect(realmAcct).not.toBeNull();
    expect(toAddress(realmAcct!.owner)).toBe(GOV_PROGRAM);
    expect(realmAcct!.data[0]).toBe(GovernanceAccountType.RealmV2);

    // Verify governance account exists
    const govAcct = svm.getAccount(toPublicKey(govAddr));
    expect(govAcct).not.toBeNull();
    expect(toAddress(govAcct!.owner)).toBe(GOV_PROGRAM);
    expect(govAcct!.data[0]).toBe(GovernanceAccountType.GovernanceV2);

    // Verify native treasury account exists
    const treasuryAcct = svm.getAccount(toPublicKey(nativeTreasuryAddr));
    expect(treasuryAcct).not.toBeNull();
  });

  // ── Test 3: voter weight plugin full flow ──────────────────────────

  it("registrar + voter weight records + update + relinquish", async () => {
    // 1. Create org realm first (needed for registrar)
    const councilMint = createUsdcMint(svm, mintAuthority, 0);
    const communityMint = createUsdcMint(svm, mintAuthority, 0);

    const realmName = "VoterTestRealm";
    const [realmAddr] = await getRealmAddress(realmName, GOV_PROGRAM);
    const [communityHolding] = await getTokenHoldingAddress(
      realmAddr,
      toAddress(communityMint),
      GOV_PROGRAM,
    );
    const [councilHolding] = await getTokenHoldingAddress(
      realmAddr,
      toAddress(councilMint),
      GOV_PROGRAM,
    );
    const [realmConfigAddr] = await getRealmConfigAddress(realmAddr, GOV_PROGRAM);
    const realmAuthority = Keypair.generate();
    svm.airdrop(realmAuthority.publicKey, BigInt(10_000_000_000));

    // Derive governance + native treasury PDAs
    const [vtGovAddr] = await getGovernanceAddress(realmAddr, orgAddr, GOV_PROGRAM);
    const [vtNativeTreasuryAddr] = await getNativeTreasuryAddress(vtGovAddr, GOV_PROGRAM);

    // Org governance is council-only: communityVoteThreshold = Disabled
    const vtGovConfig: GovernanceConfig = {
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

    sendTx(
      svm,
      [
        createOrgRealm({
          config: configAddr,
          orgAccount: orgAddr,
          realm: realmAddr,
          realmAuthority: toAddress(realmAuthority.publicKey),
          councilMint: toAddress(councilMint),
          councilHolding,
          communityMint: toAddress(communityMint),
          communityHolding,
          realmConfig: realmConfigAddr,
          authority: toAddress(orgAuthority.publicKey),
          payer: toAddress(payer.publicKey),
          governanceProgram: GOV_PROGRAM,
          splTokenProgram: toAddress(TOKEN_PROGRAM_ID),
          rentSysvar: RENT_SYSVAR,
          voterWeightAddin: PROGRAM_ID,
          maxVoterWeightAddin: PROGRAM_ID,
          governance: vtGovAddr,
          nativeTreasury: vtNativeTreasuryAddr,
          realmName,
          governanceConfigData: encodeGovernanceConfig(vtGovConfig),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, orgAuthority, realmAuthority],
    );

    // 2. Create registrar
    const govTokenMint = toAddress(communityMint); // community mint = governing token mint
    const [registrarAddr] = await getRegistrarPda(realmAddr, govTokenMint);

    sendTx(
      svm,
      [
        createRegistrar({
          realm: realmAddr,
          governingTokenMint: govTokenMint,
          assetAccount: assetAddr,
          registrarAccount: registrarAddr,
          realmAuthority: toAddress(realmAuthority.publicKey),
          payer: toAddress(payer.publicKey),
          governanceProgramId: GOV_PROGRAM,
          programId: PROGRAM_ID,
        }),
      ],
      [payer, realmAuthority],
    );

    // Verify registrar state
    const regData = getAccountData(svm, registrarAddr);
    expect(regData[0]).toBe(AccountKey.Registrar);
    expect(regData[1]).toBe(1); // version

    // 3. Create voter weight record for investor
    const investorAddr = toAddress(investor.publicKey);
    const [vwrAddr] = await getVoterWeightRecordPda(realmAddr, govTokenMint, investorAddr);

    sendTx(
      svm,
      [
        createVoterWeightRecord({
          registrarAccount: registrarAddr,
          voterWeightRecordAccount: vwrAddr,
          governingTokenOwner: investorAddr,
          payer: toAddress(payer.publicKey),
          programId: PROGRAM_ID,
        }),
      ],
      [payer],
    );

    // Verify voter weight record created with 0 weight
    const vwrData = getAccountData(svm, vwrAddr);
    expect(vwrData.length).toBe(164);
    // Discriminator: [46, 249, 155, 75, 153, 248, 116, 9]
    expect(vwrData[0]).toBe(46);
    expect(vwrData[1]).toBe(249);
    // voter_weight at offset 104..112 should be 0
    const dv = new DataView(vwrData.buffer, vwrData.byteOffset, vwrData.byteLength);
    expect(dv.getBigUint64(104, true)).toBe(0n);

    // 4. Create max voter weight record
    const [mvwrAddr] = await getMaxVoterWeightRecordPda(realmAddr, govTokenMint);

    sendTx(
      svm,
      [
        createMaxVoterWeightRecord({
          registrarAccount: registrarAddr,
          assetAccount: assetAddr,
          maxVoterWeightRecordAccount: mvwrAddr,
          realm: realmAddr,
          payer: toAddress(payer.publicKey),
          programId: PROGRAM_ID,
        }),
      ],
      [payer],
    );

    // Verify max voter weight = 100 (minted_shares)
    const mvwrData = getAccountData(svm, mvwrAddr);
    expect(mvwrData.length).toBe(97);
    // Discriminator: [157, 95, 242, 151, 16, 98, 26, 118]
    expect(mvwrData[0]).toBe(157);
    expect(mvwrData[1]).toBe(95);
    const mvwrDv = new DataView(mvwrData.buffer, mvwrData.byteOffset, mvwrData.byteLength);
    expect(mvwrDv.getBigUint64(72, true)).toBe(100n); // max_voter_weight = minted shares

    // 5. Update voter weight record (CastVote action=0)
    const actionTarget = Keypair.generate(); // some proposal-like target
    sendTx(
      svm,
      [
        updateVoterWeightRecord({
          registrarAccount: registrarAddr,
          voterWeightRecordAccount: vwrAddr,
          governingTokenOwner: investorAddr,
          assetTokenAccounts: [assetTokenAddr],
          action: 0, // CastVote
          actionTarget: toAddress(actionTarget.publicKey),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, investor],
    );

    // Verify voter_weight = 100 (investor's shares)
    const vwrDataAfter = getAccountData(svm, vwrAddr);
    const dvAfter = new DataView(
      vwrDataAfter.buffer,
      vwrDataAfter.byteOffset,
      vwrDataAfter.byteLength,
    );
    expect(dvAfter.getBigUint64(104, true)).toBe(100n);
    // Option tag at 112 should be 1 (Some), expiry = clock.slot (may be 0 in LiteSVM)
    expect(vwrDataAfter[112]).toBe(1);
    // action at 122 should be 0 (CastVote)
    expect(vwrDataAfter[122]).toBe(0);

    // Verify active_votes incremented on asset token
    const atAfterUpdate = decodeAssetToken(getAccountData(svm, assetTokenAddr));
    expect(atAfterUpdate.activeVotes).toBe(1);

    // 6. For relinquish, we need a terminal proposal.
    // Create a council token owner record, governance, and proposal via SPL Governance,
    // then cancel the proposal to reach terminal state.

    // Deposit council tokens to get a token owner record for realmAuthority
    const councilTokenAccount = createTokenAccount(
      svm,
      councilMint,
      realmAuthority.publicKey,
      payer,
    );
    mintTokensTo(svm, councilMint, councilTokenAccount, 1n, mintAuthority);

    const [torAddr] = await getTokenOwnerRecordAddress(
      realmAddr,
      toAddress(councilMint),
      toAddress(realmAuthority.publicKey),
      GOV_PROGRAM,
    );

    sendTx(
      svm,
      [
        depositGoverningTokens({
          realm: realmAddr,
          governingTokenHolding: councilHolding,
          governingTokenSource: toAddress(councilTokenAccount),
          governingTokenOwner: toAddress(realmAuthority.publicKey),
          governingTokenTransferAuthority: toAddress(realmAuthority.publicKey),
          tokenOwnerRecord: torAddr,
          payer: toAddress(payer.publicKey),
          splTokenProgram: toAddress(TOKEN_PROGRAM_ID),
          realmConfig: realmConfigAddr,
          amount: 1n,
          programId: GOV_PROGRAM,
        }),
      ],
      [payer, realmAuthority],
    );

    // Create governance
    const [govAddr] = await getGovernanceAddress(
      realmAddr,
      assetAddr,
      GOV_PROGRAM,
    );

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

    const [nativeTreasuryAddr] = await getNativeTreasuryAddress(govAddr, GOV_PROGRAM);

    sendTx(
      svm,
      [
        createAssetGovernance({
          config: configAddr,
          organization: orgAddr,
          asset: assetAddr,
          authority: toAddress(orgAuthority.publicKey),
          realm: realmAddr,
          governance: govAddr,
          tokenOwnerRecord: torAddr,
          governanceAuthority: toAddress(realmAuthority.publicKey),
          realmConfig: realmConfigAddr,
          payer: toAddress(payer.publicKey),
          governanceProgram: GOV_PROGRAM,
          nativeTreasury: nativeTreasuryAddr,
          governanceConfigData: encodeGovernanceConfig(govConfig),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, realmAuthority, orgAuthority],
    );

    // Create proposal (using deterministic seed)
    const [proposalSeedAddr] = await getProposalSeedPda(govAddr, 0, PROGRAM_ID);
    const [proposalAddr] = await getProposalAddress(
      govAddr, toAddress(councilMint), proposalSeedAddr, GOV_PROGRAM,
    );

    sendTx(
      svm,
      [
        createProposal({
          realm: realmAddr,
          proposal: proposalAddr,
          governance: govAddr,
          tokenOwnerRecord: torAddr,
          governingTokenMint: toAddress(councilMint),
          governanceAuthority: toAddress(realmAuthority.publicKey),
          payer: toAddress(payer.publicKey),
          realmConfig: realmConfigAddr,
          name: "Test Proposal",
          descriptionLink: "https://example.com",
          options: [{ label: "Approve" }],
          useDenyOption: true,
          proposalSeed: proposalSeedAddr,
          programId: GOV_PROGRAM,
        }),
      ],
      [payer, realmAuthority],
    );

    // Cancel proposal → terminal state (Cancelled = 6)
    sendTx(
      svm,
      [
        cancelProposal({
          realm: realmAddr,
          governance: govAddr,
          proposal: proposalAddr,
          tokenOwnerRecord: torAddr,
          governanceAuthority: toAddress(realmAuthority.publicKey),
          programId: GOV_PROGRAM,
        }),
      ],
      [realmAuthority],
    );

    // Verify proposal is cancelled (state at byte 65 = 6)
    const proposalData = getAccountData(svm, proposalAddr);
    expect(proposalData[65]).toBe(6); // ProposalState::Cancelled

    // 7. Relinquish voter weight
    sendTx(
      svm,
      [
        relinquishVoterWeight({
          registrarAccount: registrarAddr,
          governanceProgram: GOV_PROGRAM,
          proposal: proposalAddr,
          assetTokenAccounts: [assetTokenAddr],
          programId: PROGRAM_ID,
        }),
      ],
      [payer],
    );

    // Verify active_votes decremented
    const atAfterRelinquish = decodeAssetToken(getAccountData(svm, assetTokenAddr));
    expect(atAfterRelinquish.activeVotes).toBe(0);
  });
});
