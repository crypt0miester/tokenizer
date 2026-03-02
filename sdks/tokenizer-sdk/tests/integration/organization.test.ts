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
import { decodeProtocolConfig } from "../../src/accounts/protocolConfig.js";
import { decodeOrganization } from "../../src/accounts/organization.js";
import { initializeProtocol, updateConfigAddMint } from "../../src/instructions/protocol.js";
import {
  registerOrganization,
  deregisterOrganization,
  updateOrgAddMint,
  updateOrgRemoveMint,
} from "../../src/instructions/organization.js";
import { getProtocolConfigPda, getOrganizationPda } from "../../src/pdas.js";
import { AccountKey } from "../../src/constants.js";

// ── Constants ────────────────────────────────────────────────────────

const PROGRAM_ID = address("FNDZziaztYptbydC5UpLEaLMyFN4rDmP3G2MN7o6w4ZK");
const PROGRAM_PK = new PublicKey("FNDZziaztYptbydC5UpLEaLMyFN4rDmP3G2MN7o6w4ZK");

// ── Test Suite ───────────────────────────────────────────────────────

describe("Organization Integration", () => {
  let svm: LiteSVM;
  let operator: Keypair;
  let payer: Keypair;
  let feeTreasury: Keypair;
  let mintAuthority: Keypair;
  let usdcMint: PublicKey;
  let configAddr: Address;
  let orgAuthority: Keypair;

  beforeEach(async () => {
    svm = createTestSvm({ programId: PROGRAM_PK });

    operator = Keypair.generate();
    payer = Keypair.generate();
    feeTreasury = Keypair.generate();
    mintAuthority = Keypair.generate();
    orgAuthority = Keypair.generate();

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
          feeTreasury: toAddress(feeTreasury.publicKey),
          acceptedMint: toAddress(usdcMint),
          programId: PROGRAM_ID,
        }),
      ],
      [payer, operator],
    );
  });

  it("registers an organization", async () => {
    const [orgPda] = await getOrganizationPda(0, PROGRAM_ID);

    sendTx(
      svm,
      [
        registerOrganization({
          config: configAddr,
          orgAccount: orgPda,
          operator: toAddress(operator.publicKey),
          payer: toAddress(payer.publicKey),
          authority: toAddress(orgAuthority.publicKey),
          name: "AcmeCorp",
          registrationNumber: "REG-001",
          country: "US",
          programId: PROGRAM_ID,
        }),
      ],
      [payer, operator],
    );

    const org = decodeOrganization(getAccountData(svm, orgPda));
    expect(org.accountKey).toBe(AccountKey.Organization);
    expect(org.id).toBe(0);
    expect(org.authority).toBe(toAddress(orgAuthority.publicKey));
    expect(org.name).toBe("AcmeCorp");
    expect(org.registrationNumber).toBe("REG-001");
    expect(org.country).toBe("US");
    expect(org.isActive).toBe(true);
    expect(org.assetCount).toBe(0);
    expect(org.acceptedMintCount).toBe(0);

    // Check config totalOrganizations incremented
    const config = decodeProtocolConfig(getAccountData(svm, configAddr));
    expect(config.totalOrganizations).toBe(1);
  });

  it("registers a second organization with id=1", async () => {
    const [orgPda0] = await getOrganizationPda(0, PROGRAM_ID);
    const [orgPda1] = await getOrganizationPda(1, PROGRAM_ID);

    // Register first org
    sendTx(
      svm,
      [
        registerOrganization({
          config: configAddr,
          orgAccount: orgPda0,
          operator: toAddress(operator.publicKey),
          payer: toAddress(payer.publicKey),
          authority: toAddress(orgAuthority.publicKey),
          name: "Org0",
          registrationNumber: "REG-000",
          country: "US",
          programId: PROGRAM_ID,
        }),
      ],
      [payer, operator],
    );

    // Register second org
    const auth2 = Keypair.generate();
    sendTx(
      svm,
      [
        registerOrganization({
          config: configAddr,
          orgAccount: orgPda1,
          operator: toAddress(operator.publicKey),
          payer: toAddress(payer.publicKey),
          authority: toAddress(auth2.publicKey),
          name: "Org1",
          registrationNumber: "REG-001",
          country: "BR",
          programId: PROGRAM_ID,
        }),
      ],
      [payer, operator],
    );

    const org0 = decodeOrganization(getAccountData(svm, orgPda0));
    const org1 = decodeOrganization(getAccountData(svm, orgPda1));

    expect(org0.id).toBe(0);
    expect(org1.id).toBe(1);
    expect(orgPda0).not.toBe(orgPda1);

    const config = decodeProtocolConfig(getAccountData(svm, configAddr));
    expect(config.totalOrganizations).toBe(2);
  });

  it("adds USDC mint to organization", async () => {
    const [orgPda] = await getOrganizationPda(0, PROGRAM_ID);

    sendTx(
      svm,
      [
        registerOrganization({
          config: configAddr,
          orgAccount: orgPda,
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
          orgAccount: orgPda,
          authority: toAddress(orgAuthority.publicKey),
          mint: toAddress(usdcMint),
          programId: PROGRAM_ID,
        }),
      ],
      [orgAuthority],
    );

    const org = decodeOrganization(getAccountData(svm, orgPda));
    expect(org.acceptedMintCount).toBe(1);
    expect(org.acceptedMints[0]).toBe(toAddress(usdcMint));
  });

  it("adds a second mint to organization", async () => {
    const [orgPda] = await getOrganizationPda(0, PROGRAM_ID);
    const secondMint = createUsdcMint(svm, mintAuthority, 9);

    // First add second mint to protocol accepted mints
    sendTx(
      svm,
      [
        updateConfigAddMint({
          config: configAddr,
          operator: toAddress(operator.publicKey),
          mint: toAddress(secondMint),
          programId: PROGRAM_ID,
        }),
      ],
      [operator],
    );

    sendTx(
      svm,
      [
        registerOrganization({
          config: configAddr,
          orgAccount: orgPda,
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

    // Add USDC first
    sendTx(
      svm,
      [
        updateOrgAddMint({
          config: configAddr,
          orgAccount: orgPda,
          authority: toAddress(orgAuthority.publicKey),
          mint: toAddress(usdcMint),
          programId: PROGRAM_ID,
        }),
      ],
      [orgAuthority],
    );

    // Add second mint
    sendTx(
      svm,
      [
        updateOrgAddMint({
          config: configAddr,
          orgAccount: orgPda,
          authority: toAddress(orgAuthority.publicKey),
          mint: toAddress(secondMint),
          programId: PROGRAM_ID,
        }),
      ],
      [orgAuthority],
    );

    const org = decodeOrganization(getAccountData(svm, orgPda));
    expect(org.acceptedMintCount).toBe(2);
    expect(org.acceptedMints).toContain(toAddress(usdcMint));
    expect(org.acceptedMints).toContain(toAddress(secondMint));
  });

  it("removes a mint from organization", async () => {
    const [orgPda] = await getOrganizationPda(0, PROGRAM_ID);

    sendTx(
      svm,
      [
        registerOrganization({
          config: configAddr,
          orgAccount: orgPda,
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

    // Add USDC mint
    sendTx(
      svm,
      [
        updateOrgAddMint({
          config: configAddr,
          orgAccount: orgPda,
          authority: toAddress(orgAuthority.publicKey),
          mint: toAddress(usdcMint),
          programId: PROGRAM_ID,
        }),
      ],
      [orgAuthority],
    );

    const orgAfterAdd = decodeOrganization(getAccountData(svm, orgPda));
    expect(orgAfterAdd.acceptedMintCount).toBe(1);

    // Remove USDC mint
    sendTx(
      svm,
      [
        updateOrgRemoveMint({
          config: configAddr,
          orgAccount: orgPda,
          authority: toAddress(orgAuthority.publicKey),
          mint: toAddress(usdcMint),
          programId: PROGRAM_ID,
        }),
      ],
      [orgAuthority],
    );

    const orgAfterRemove = decodeOrganization(getAccountData(svm, orgPda));
    expect(orgAfterRemove.acceptedMintCount).toBe(0);
  });

  it("deregisters an organization", async () => {
    const [orgPda] = await getOrganizationPda(0, PROGRAM_ID);

    sendTx(
      svm,
      [
        registerOrganization({
          config: configAddr,
          orgAccount: orgPda,
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
        deregisterOrganization({
          config: configAddr,
          orgAccount: orgPda,
          operator: toAddress(operator.publicKey),
          orgId: 0,
          programId: PROGRAM_ID,
        }),
      ],
      [operator],
    );

    const org = decodeOrganization(getAccountData(svm, orgPda));
    expect(org.isActive).toBe(false);
  });
});
