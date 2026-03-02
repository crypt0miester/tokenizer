import { LiteSVM, type FailedTransactionMetadata, type TransactionMetadata } from "litesvm";
import {
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import { type Address, address, AccountRole, type Instruction } from "gill";
import path from "node:path";

// ── Constants ────────────────────────────────────────────────────────

const DEPLOY_DIR = path.resolve(__dirname, "../../../../target/deploy");
const TOKENIZER_SO = path.join(DEPLOY_DIR, "tokenizer.so");
const MPL_CORE_SO = path.join(DEPLOY_DIR, "mpl_core.so");
const SPL_GOV_SO = path.join(DEPLOY_DIR, "spl_governance.so");

export const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ATA_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

// ── Bridge helpers ───────────────────────────────────────────────────

export function toPublicKey(addr: Address): PublicKey {
  return new PublicKey(addr);
}

export function toAddress(pk: PublicKey): Address {
  return address(pk.toBase58());
}

export function toWeb3Ix(ix: Instruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programAddress),
    keys: ix.accounts!.map((a) => ({
      pubkey: new PublicKey(a.address),
      isSigner:
        a.role === AccountRole.READONLY_SIGNER ||
        a.role === AccountRole.WRITABLE_SIGNER,
      isWritable:
        a.role === AccountRole.WRITABLE ||
        a.role === AccountRole.WRITABLE_SIGNER,
    })),
    data: Buffer.from(ix.data!),
  });
}

// ── SVM Factory ──────────────────────────────────────────────────────

export interface CreateTestSvmOpts {
  programId?: PublicKey;
  mplCoreSoPath?: string;
  splGovSoPath?: string;
  /** Load mpl_core.so from default deploy dir */
  loadMplCore?: boolean;
  /** Load spl_governance.so from default deploy dir */
  loadSplGov?: boolean;
}

export function createTestSvm(opts: CreateTestSvmOpts = {}): LiteSVM {
  const svm = new LiteSVM();

  const programId = opts.programId ?? new PublicKey("FNDZziaztYptbydC5UpLEaLMyFN4rDmP3G2MN7o6w4ZK");
  svm.addProgramFromFile(programId, TOKENIZER_SO);

  const mplPath = opts.mplCoreSoPath ?? (opts.loadMplCore ? MPL_CORE_SO : undefined);
  if (mplPath) {
    svm.addProgramFromFile(
      new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"),
      mplPath,
    );
  }

  const govPath = opts.splGovSoPath ?? (opts.loadSplGov ? SPL_GOV_SO : undefined);
  if (govPath) {
    svm.addProgramFromFile(
      new PublicKey("GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw"),
      govPath,
    );
  }

  return svm;
}

// ── SPL Token helpers ────────────────────────────────────────────────

/** Builds an InitializeMint instruction (SPL Token instruction index 0). */
function initMintIx(
  mint: PublicKey,
  decimals: number,
  mintAuthority: PublicKey,
  freezeAuthority: PublicKey | null,
): TransactionInstruction {
  const data = Buffer.alloc(67);
  data.writeUInt8(0, 0); // InitializeMint
  data.writeUInt8(decimals, 1);
  mintAuthority.toBuffer().copy(data, 2);
  if (freezeAuthority) {
    data.writeUInt8(1, 34); // COption Some
    freezeAuthority.toBuffer().copy(data, 35);
  } else {
    data.writeUInt8(0, 34); // COption None
  }
  return new TransactionInstruction({
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: new PublicKey("SysvarRent111111111111111111111111111111111"), isSigner: false, isWritable: false },
    ],
    programId: TOKEN_PROGRAM_ID,
    data,
  });
}

/** Builds an InitializeAccount instruction (SPL Token instruction index 1). */
function initAccountIx(
  account: PublicKey,
  mint: PublicKey,
  owner: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(1, 0); // InitializeAccount
  return new TransactionInstruction({
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: new PublicKey("SysvarRent111111111111111111111111111111111"), isSigner: false, isWritable: false },
    ],
    programId: TOKEN_PROGRAM_ID,
    data,
  });
}

/** Builds a MintTo instruction (SPL Token instruction index 7). */
function mintToIx(
  mint: PublicKey,
  destination: PublicKey,
  authority: PublicKey,
  amount: bigint,
): TransactionInstruction {
  const data = Buffer.alloc(9);
  data.writeUInt8(7, 0); // MintTo
  data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    programId: TOKEN_PROGRAM_ID,
    data,
  });
}

/** Builds a SyncNative instruction (SPL Token instruction index 17). */
function syncNativeIx(account: PublicKey): TransactionInstruction {
  const data = Buffer.alloc(1);
  data.writeUInt8(17, 0);
  return new TransactionInstruction({
    keys: [{ pubkey: account, isSigner: false, isWritable: true }],
    programId: TOKEN_PROGRAM_ID,
    data,
  });
}

export const SPL_TOKEN_ACCOUNT_LEN = 165;
const MINT_LEN = 82;

/**
 * Creates an SPL Token mint with the given decimals.
 * Returns the mint PublicKey.
 */
export function createUsdcMint(
  svm: LiteSVM,
  mintAuthority: Keypair,
  decimals = 6,
): PublicKey {
  const mint = Keypair.generate();
  const payer = Keypair.generate();
  svm.airdrop(payer.publicKey, BigInt(10_000_000_000));

  const rentExempt = svm.minimumBalanceForRentExemption(BigInt(MINT_LEN));

  const tx = new Transaction();
  tx.add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      lamports: Number(rentExempt),
      space: MINT_LEN,
      programId: TOKEN_PROGRAM_ID,
    }),
  );
  tx.add(initMintIx(mint.publicKey, decimals, mintAuthority.publicKey, null));

  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = payer.publicKey;
  tx.sign(payer, mint);

  const result = svm.sendTransaction(tx);
  if ("err" in result && typeof (result as FailedTransactionMetadata).err === "function") {
    throw new Error(`createUsdcMint failed: ${(result as FailedTransactionMetadata).meta().prettyLogs()}`);
  }

  return mint.publicKey;
}

/**
 * Creates an SPL Token account for the given mint and owner.
 * Returns the token account PublicKey.
 */
export function createTokenAccount(
  svm: LiteSVM,
  mint: PublicKey,
  owner: PublicKey,
  payer: Keypair,
): PublicKey {
  const tokenAcct = Keypair.generate();
  const rentExempt = svm.minimumBalanceForRentExemption(BigInt(SPL_TOKEN_ACCOUNT_LEN));

  const tx = new Transaction();
  tx.add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: tokenAcct.publicKey,
      lamports: Number(rentExempt),
      space: SPL_TOKEN_ACCOUNT_LEN,
      programId: TOKEN_PROGRAM_ID,
    }),
  );
  tx.add(initAccountIx(tokenAcct.publicKey, mint, owner));

  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = payer.publicKey;
  tx.sign(payer, tokenAcct);

  const result = svm.sendTransaction(tx);
  if ("err" in result && typeof (result as FailedTransactionMetadata).err === "function") {
    throw new Error(`createTokenAccount failed: ${(result as FailedTransactionMetadata).meta().prettyLogs()}`);
  }

  return tokenAcct.publicKey;
}

/**
 * Mints tokens to a destination token account.
 */
export function mintTokensTo(
  svm: LiteSVM,
  mint: PublicKey,
  destination: PublicKey,
  amount: bigint,
  mintAuthority: Keypair,
): void {
  const payer = Keypair.generate();
  svm.airdrop(payer.publicKey, BigInt(1_000_000_000));

  const tx = new Transaction();
  tx.add(mintToIx(mint, destination, mintAuthority.publicKey, amount));

  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = payer.publicKey;
  tx.sign(payer, mintAuthority);

  const result = svm.sendTransaction(tx);
  if ("err" in result && typeof (result as FailedTransactionMetadata).err === "function") {
    throw new Error(`mintTokensTo failed: ${(result as FailedTransactionMetadata).meta().prettyLogs()}`);
  }
}

/**
 * Creates and funds a wSOL token account.
 */
export function fundWsolAccount(
  svm: LiteSVM,
  owner: PublicKey,
  payer: Keypair,
  lamports: bigint,
): PublicKey {
  const wsolAcct = Keypair.generate();
  const rentExempt = svm.minimumBalanceForRentExemption(BigInt(SPL_TOKEN_ACCOUNT_LEN));

  const tx = new Transaction();
  tx.add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: wsolAcct.publicKey,
      lamports: Number(rentExempt + lamports),
      space: SPL_TOKEN_ACCOUNT_LEN,
      programId: TOKEN_PROGRAM_ID,
    }),
  );
  tx.add(initAccountIx(wsolAcct.publicKey, NATIVE_MINT, owner));
  tx.add(syncNativeIx(wsolAcct.publicKey));

  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = payer.publicKey;
  tx.sign(payer, wsolAcct);

  const result = svm.sendTransaction(tx);
  if ("err" in result && typeof (result as FailedTransactionMetadata).err === "function") {
    throw new Error(`fundWsolAccount failed: ${(result as FailedTransactionMetadata).meta().prettyLogs()}`);
  }

  return wsolAcct.publicKey;
}

// ── Transaction helpers ──────────────────────────────────────────────

function isFailedTx(result: TransactionMetadata | FailedTransactionMetadata): result is FailedTransactionMetadata {
  return typeof (result as FailedTransactionMetadata).err === "function";
}

/**
 * Builds, signs, and sends a transaction. Throws on failure with prettyLogs.
 */
export function sendTx(
  svm: LiteSVM,
  ixs: (TransactionInstruction | Instruction)[],
  signers: Keypair[],
): TransactionMetadata {
  const tx = new Transaction();
  for (const ix of ixs) {
    if ("programAddress" in ix) {
      tx.add(toWeb3Ix(ix));
    } else {
      tx.add(ix);
    }
  }

  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);

  const result = svm.sendTransaction(tx);
  if (isFailedTx(result)) {
    const logs = result.meta().prettyLogs();
    const errStr = result.toString();
    throw new Error(`Transaction failed:\n${logs}\n${errStr}`);
  }
  return result;
}

/**
 * Sends a transaction expecting failure. Returns FailedTransactionMetadata.
 * Throws if the transaction succeeds.
 */
export function sendTxExpectFail(
  svm: LiteSVM,
  ixs: (TransactionInstruction | Instruction)[],
  signers: Keypair[],
): FailedTransactionMetadata {
  const tx = new Transaction();
  for (const ix of ixs) {
    if ("programAddress" in ix) {
      tx.add(toWeb3Ix(ix));
    } else {
      tx.add(ix);
    }
  }

  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);

  const result = svm.sendTransaction(tx);
  if (!isFailedTx(result)) {
    throw new Error("Expected transaction to fail, but it succeeded");
  }
  return result;
}

/**
 * Reads raw account data from SVM.
 */
export function getAccountData(svm: LiteSVM, addr: Address | PublicKey): Uint8Array {
  const pk = addr instanceof PublicKey ? addr : toPublicKey(addr);
  const acct = svm.getAccount(pk);
  if (!acct) {
    throw new Error(`Account not found: ${pk.toBase58()}`);
  }
  return acct.data;
}

/**
 * Reads SPL Token balance (bytes 64-72 as u64 LE).
 */
export function getTokenBalance(svm: LiteSVM, tokenAccount: PublicKey): bigint {
  const data = getAccountData(svm, tokenAccount);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getBigUint64(64, true);
}
