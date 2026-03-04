/**
 * RPC fetch helpers for SPL Governance accounts.
 */
import {
  type Address,
  type Base64EncodedBytes,
  type Rpc,
  type SolanaRpcApi,
  fetchEncodedAccount,
  fetchEncodedAccounts,
  getAddressEncoder,
  getBase64Decoder,
  getBase64Encoder,
} from "gill";
import type { ProgramAccount } from "../../filters.js";
import { TOKENIZER_PROGRAM_ID } from "../../constants.js";
import { getProposalSeedPda } from "../../pdas.js";
import {
  type GovernanceV2,
  type ProposalV2,
  type RealmV2,
  type TokenOwnerRecordV2,
  type VoteRecordV2,
  decodeGovernanceV2,
  decodeProposalV2,
  decodeRealmV2,
  decodeTokenOwnerRecordV2,
  decodeVoteRecordV2,
} from "./accounts.js";
import { GovernanceAccountType, ProposalState, SPL_GOVERNANCE_PROGRAM_ID } from "./constants.js";
import { getProposalAddress, getTokenOwnerRecordAddress, getVoteRecordAddress } from "./pdas.js";

const addrEnc = getAddressEncoder();
const b64Enc = getBase64Encoder();
const b64Dec = getBase64Decoder();

// Single-account fetchers───

export async function fetchRealm(
  rpc: Rpc<SolanaRpcApi>,
  address: Address,
): Promise<RealmV2 | null> {
  const account = await fetchEncodedAccount(rpc, address);
  if (!account.exists) return null;
  return decodeRealmV2(account.data);
}

export async function fetchGovernance(
  rpc: Rpc<SolanaRpcApi>,
  address: Address,
): Promise<GovernanceV2 | null> {
  const account = await fetchEncodedAccount(rpc, address);
  if (!account.exists) return null;
  return decodeGovernanceV2(account.data);
}

export async function fetchProposal(
  rpc: Rpc<SolanaRpcApi>,
  address: Address,
): Promise<ProposalV2 | null> {
  const account = await fetchEncodedAccount(rpc, address);
  if (!account.exists) return null;
  return decodeProposalV2(account.data);
}

export async function fetchTokenOwnerRecord(
  rpc: Rpc<SolanaRpcApi>,
  address: Address,
): Promise<TokenOwnerRecordV2 | null> {
  const account = await fetchEncodedAccount(rpc, address);
  if (!account.exists) return null;
  return decodeTokenOwnerRecordV2(account.data);
}

// Existence checks──

export async function realmExists(rpc: Rpc<SolanaRpcApi>, address: Address): Promise<boolean> {
  const account = await fetchEncodedAccount(rpc, address);
  return account.exists && account.data[0] === GovernanceAccountType.RealmV2;
}

export async function governanceExists(rpc: Rpc<SolanaRpcApi>, address: Address): Promise<boolean> {
  const account = await fetchEncodedAccount(rpc, address);
  return account.exists && account.data[0] === GovernanceAccountType.GovernanceV2;
}

// Query helpers (getProgramAccounts)─

export async function fetchProposalsByGovernance(
  rpc: Rpc<SolanaRpcApi>,
  governanceAddress: Address,
  programId: Address = SPL_GOVERNANCE_PROGRAM_ID,
): Promise<ProgramAccount<ProposalV2>[]> {
  const govBytes = new Uint8Array(addrEnc.encode(governanceAddress));
  const result = await rpc
    .getProgramAccounts(programId, {
      encoding: "base64",
      filters: [
        {
          memcmp: {
            offset: 0n,
            bytes: b64Dec.decode(
              new Uint8Array([GovernanceAccountType.ProposalV2]),
            ) as Base64EncodedBytes,
            encoding: "base64",
          },
        },
        {
          memcmp: {
            offset: 1n,
            bytes: b64Dec.decode(govBytes) as Base64EncodedBytes,
            encoding: "base64",
          },
        },
      ],
    })
    .send();
  return result.map(({ pubkey, account }) => ({
    address: pubkey,
    data: decodeProposalV2(new Uint8Array(b64Enc.encode(account.data[0] as string))),
  }));
}

/**
 * Fetch proposals using deterministic seed PDAs instead of getProgramAccounts.
 *
 * Derives proposal addresses from sequential indices (0, 1, 2, ...),
 * fetches in batches of 10 via getMultipleAccounts, and stops when
 * an entire batch returns null (no more proposals exist past that point).
 */
export async function fetchProposalsByGovernanceIterative(
  rpc: Rpc<SolanaRpcApi>,
  governance: Address,
  governingTokenMint: Address,
  opts: {
    tokenizerProgramId?: Address;
    govProgramId?: Address;
    batchSize?: number;
  } = {},
): Promise<ProgramAccount<ProposalV2>[]> {
  const tokenizerProgramId = opts.tokenizerProgramId ?? TOKENIZER_PROGRAM_ID;
  const govProgramId = opts.govProgramId ?? SPL_GOVERNANCE_PROGRAM_ID;
  const batchSize = opts.batchSize ?? 10;

  const results: ProgramAccount<ProposalV2>[] = [];
  let startIndex = 0;

  while (true) {
    // Derive all seed PDAs in parallel, then all proposal addresses in parallel
    const seedAddrs = await Promise.all(
      Array.from({ length: batchSize }, (_, i) =>
        getProposalSeedPda(governance, startIndex + i, tokenizerProgramId),
      ),
    );
    const addresses = (
      await Promise.all(
        seedAddrs.map(([seedAddr]) =>
          getProposalAddress(governance, governingTokenMint, seedAddr, govProgramId),
        ),
      )
    ).map(([addr]) => addr);

    const accounts = await fetchEncodedAccounts(rpc, addresses);

    let allNull = true;
    for (let i = 0; i < accounts.length; i++) {
      const acct = accounts[i];
      if (acct.exists) {
        allNull = false;
        results.push({
          address: addresses[i],
          data: decodeProposalV2(acct.data),
        });
      }
    }

    if (allNull) break;
    startIndex += batchSize;
  }

  return results;
}

export async function fetchVoteRecord(
  rpc: Rpc<SolanaRpcApi>,
  address: Address,
): Promise<VoteRecordV2 | null> {
  const account = await fetchEncodedAccount(rpc, address);
  if (!account.exists) return null;
  return decodeVoteRecordV2(account.data);
}

export async function fetchVoteRecordsByProposal(
  rpc: Rpc<SolanaRpcApi>,
  proposalAddress: Address,
  programId: Address = SPL_GOVERNANCE_PROGRAM_ID,
): Promise<ProgramAccount<VoteRecordV2>[]> {
  const proposalBytes = new Uint8Array(addrEnc.encode(proposalAddress));
  const result = await rpc
    .getProgramAccounts(programId, {
      encoding: "base64",
      filters: [
        {
          memcmp: {
            offset: 0n,
            bytes: b64Dec.decode(
              new Uint8Array([GovernanceAccountType.VoteRecordV2]),
            ) as Base64EncodedBytes,
            encoding: "base64",
          },
        },
        {
          memcmp: {
            offset: 1n,
            bytes: b64Dec.decode(proposalBytes) as Base64EncodedBytes,
            encoding: "base64",
          },
        },
      ],
    })
    .send();
  return result.map(({ pubkey, account }) => ({
    address: pubkey,
    data: decodeVoteRecordV2(new Uint8Array(b64Enc.encode(account.data[0] as string))),
  }));
}

export async function fetchTokenOwnerRecordsByRealm(
  rpc: Rpc<SolanaRpcApi>,
  realmAddress: Address,
  programId: Address = SPL_GOVERNANCE_PROGRAM_ID,
): Promise<ProgramAccount<TokenOwnerRecordV2>[]> {
  const realmBytes = new Uint8Array(addrEnc.encode(realmAddress));
  const result = await rpc
    .getProgramAccounts(programId, {
      encoding: "base64",
      filters: [
        {
          memcmp: {
            offset: 0n,
            bytes: b64Dec.decode(
              new Uint8Array([GovernanceAccountType.TokenOwnerRecordV2]),
            ) as Base64EncodedBytes,
            encoding: "base64",
          },
        },
        {
          memcmp: {
            offset: 1n,
            bytes: b64Dec.decode(realmBytes) as Base64EncodedBytes,
            encoding: "base64",
          },
        },
      ],
    })
    .send();
  return result.map(({ pubkey, account }) => ({
    address: pubkey,
    data: decodeTokenOwnerRecordV2(new Uint8Array(b64Enc.encode(account.data[0] as string))),
  }));
}

// Composite checks─

/**
 * Council-only canVote check: proposal state + TOR deposit + no existing VoteRecord.
 * Accepts an optional pre-fetched proposal to avoid redundant RPC calls.
 */
export async function canVoteCouncil(
  rpc: Rpc<SolanaRpcApi>,
  proposal: Address,
  voter: Address,
  realm: Address,
  councilMint: Address,
  opts?: { govProgramId?: Address },
  prefetchedProposal?: ProposalV2 | null,
): Promise<{ canVote: boolean; reason?: string }> {
  const govProgramId = opts?.govProgramId ?? SPL_GOVERNANCE_PROGRAM_ID;

  // Derive TOR address (pure PDA math) + fetch proposal concurrently
  const [prop, [torAddr]] = await Promise.all([
    prefetchedProposal !== undefined
      ? Promise.resolve(prefetchedProposal)
      : fetchProposal(rpc, proposal),
    getTokenOwnerRecordAddress(realm, councilMint, voter, govProgramId),
  ]);
  if (!prop) return { canVote: false, reason: "proposal_not_found" };
  if (prop.state !== ProposalState.Voting) {
    return { canVote: false, reason: "not_voting" };
  }

  // VoteRecord PDA only needs torAddr (already derived), not the TOR data
  const [voteRecordAddr] = await getVoteRecordAddress(proposal, torAddr, govProgramId);

  // Fetch TOR + VoteRecord concurrently — both addresses are known
  const [tor, existing] = await Promise.all([
    fetchTokenOwnerRecord(rpc, torAddr),
    fetchVoteRecord(rpc, voteRecordAddr),
  ]);

  if (!tor || tor.governingTokenDepositAmount <= 0n) {
    return { canVote: false, reason: "no_deposit" };
  }
  if (existing) {
    return { canVote: false, reason: "already_voted" };
  }

  return { canVote: true };
}
