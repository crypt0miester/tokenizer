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
import { decodeProtocolConfig } from "../../src/accounts/protocolConfig.js";
import {
  initializeProtocol,
  updateConfigFeeBps,
  updateConfigFeeTreasury,
  updateConfigAddMint,
  updateConfigRemoveMint,
  updateConfigSetOperator,
  pauseProtocol,
  unpauseProtocol,
} from "../../src/instructions/protocol.js";
import { getProtocolConfigPda } from "../../src/pdas.js";
import { AccountKey } from "../../src/constants.js";

// Constants─

const PROGRAM_ID = address("FNDZziaztYptbydC5UpLEaLMyFN4rDmP3G2MN7o6w4ZK");
const PROGRAM_PK = new PublicKey("FNDZziaztYptbydC5UpLEaLMyFN4rDmP3G2MN7o6w4ZK");

// Test Suite

describe("Protocol Integration", () => {
  let svm: LiteSVM;
  let operator: Keypair;
  let payer: Keypair;
  let feeTreasury: Keypair;
  let mintAuthority: Keypair;
  let usdcMint: PublicKey;
  let configAddr: Address;

  beforeEach(async () => {
    svm = createTestSvm({ programId: PROGRAM_PK });

    operator = Keypair.generate();
    payer = Keypair.generate();
    feeTreasury = Keypair.generate();
    mintAuthority = Keypair.generate();

    svm.airdrop(operator.publicKey, BigInt(10_000_000_000));
    svm.airdrop(payer.publicKey, BigInt(10_000_000_000));

    usdcMint = createUsdcMint(svm, mintAuthority);

    const [configPda] = await getProtocolConfigPda(PROGRAM_ID);
    configAddr = configPda;
  });

  async function initProtocol() {
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
  }

  it("initializes protocol config correctly", async () => {
    await initProtocol();

    const data = getAccountData(svm, configAddr);
    const config = decodeProtocolConfig(data);

    expect(config.accountKey).toBe(AccountKey.ProtocolConfig);
    expect(config.version).toBe(1);
    expect(config.operator).toBe(toAddress(operator.publicKey));
    expect(config.feeBps).toBe(100);
    expect(config.feeTreasury).toBe(toAddress(feeTreasury.publicKey));
    expect(config.paused).toBe(false);
    expect(config.acceptedMintCount).toBe(1);
    expect(config.acceptedMints[0]).toBe(toAddress(usdcMint));
    expect(config.totalOrganizations).toBe(0);
  });

  it("updates fee bps", async () => {
    await initProtocol();

    sendTx(
      svm,
      [
        updateConfigFeeBps({
          config: configAddr,
          operator: toAddress(operator.publicKey),
          feeBps: 250,
          programId: PROGRAM_ID,
        }),
      ],
      [operator],
    );

    const config = decodeProtocolConfig(getAccountData(svm, configAddr));
    expect(config.feeBps).toBe(250);
  });

  it("updates fee treasury", async () => {
    await initProtocol();
    const newTreasury = Keypair.generate();

    sendTx(
      svm,
      [
        updateConfigFeeTreasury({
          config: configAddr,
          operator: toAddress(operator.publicKey),
          feeTreasury: toAddress(newTreasury.publicKey),
          programId: PROGRAM_ID,
        }),
      ],
      [operator],
    );

    const config = decodeProtocolConfig(getAccountData(svm, configAddr));
    expect(config.feeTreasury).toBe(toAddress(newTreasury.publicKey));
  });

  it("adds an accepted mint", async () => {
    await initProtocol();
    const newMint = createUsdcMint(svm, mintAuthority);

    sendTx(
      svm,
      [
        updateConfigAddMint({
          config: configAddr,
          operator: toAddress(operator.publicKey),
          mint: toAddress(newMint),
          programId: PROGRAM_ID,
        }),
      ],
      [operator],
    );

    const config = decodeProtocolConfig(getAccountData(svm, configAddr));
    expect(config.acceptedMintCount).toBe(2);
    expect(config.acceptedMints).toContain(toAddress(newMint));
  });

  it("removes an accepted mint", async () => {
    await initProtocol();

    sendTx(
      svm,
      [
        updateConfigRemoveMint({
          config: configAddr,
          operator: toAddress(operator.publicKey),
          mint: toAddress(usdcMint),
          programId: PROGRAM_ID,
        }),
      ],
      [operator],
    );

    const config = decodeProtocolConfig(getAccountData(svm, configAddr));
    expect(config.acceptedMintCount).toBe(0);
    expect(config.acceptedMints).toHaveLength(0);
  });

  it("sets a new operator", async () => {
    await initProtocol();
    const newOperator = Keypair.generate();

    sendTx(
      svm,
      [
        updateConfigSetOperator({
          config: configAddr,
          operator: toAddress(operator.publicKey),
          newOperator: toAddress(newOperator.publicKey),
          programId: PROGRAM_ID,
        }),
      ],
      [operator],
    );

    const config = decodeProtocolConfig(getAccountData(svm, configAddr));
    expect(config.operator).toBe(toAddress(newOperator.publicKey));
  });

  it("pauses and unpauses", async () => {
    await initProtocol();

    sendTx(
      svm,
      [
        pauseProtocol({
          config: configAddr,
          operator: toAddress(operator.publicKey),
          programId: PROGRAM_ID,
        }),
      ],
      [operator],
    );

    let config = decodeProtocolConfig(getAccountData(svm, configAddr));
    expect(config.paused).toBe(true);

    sendTx(
      svm,
      [
        unpauseProtocol({
          config: configAddr,
          operator: toAddress(operator.publicKey),
          programId: PROGRAM_ID,
        }),
      ],
      [operator],
    );

    config = decodeProtocolConfig(getAccountData(svm, configAddr));
    expect(config.paused).toBe(false);
  });

  it("rejects unauthorized operator", async () => {
    await initProtocol();
    const unauthorized = Keypair.generate();
    svm.airdrop(unauthorized.publicKey, BigInt(1_000_000_000));

    sendTxExpectFail(
      svm,
      [
        updateConfigFeeBps({
          config: configAddr,
          operator: toAddress(unauthorized.publicKey),
          feeBps: 999,
          programId: PROGRAM_ID,
        }),
      ],
      [unauthorized],
    );

    // Config should be unchanged
    const config = decodeProtocolConfig(getAccountData(svm, configAddr));
    expect(config.feeBps).toBe(100);
  });
});
