/**
 * RPC fetch helpers for MPL Core accounts.
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
import { type AssetV1, type CollectionV1, decodeAssetV1, decodeCollectionV1 } from "./accounts.js";
import { MPL_CORE_PROGRAM_ID, MplCoreKey, UpdateAuthorityType } from "./constants.js";

const addrEnc = getAddressEncoder();
const b64Enc = getBase64Encoder();
const b64Dec = getBase64Decoder();

// Single-account fetchers───

export async function fetchCollection(
  rpc: Rpc<SolanaRpcApi>,
  address: Address,
): Promise<CollectionV1 | null> {
  const account = await fetchEncodedAccount(rpc, address);
  if (!account.exists) return null;
  return decodeCollectionV1(account.data);
}

export async function fetchAsset(
  rpc: Rpc<SolanaRpcApi>,
  address: Address,
): Promise<AssetV1 | null> {
  const account = await fetchEncodedAccount(rpc, address);
  if (!account.exists) return null;
  return decodeAssetV1(account.data);
}

export async function fetchAssets(
  rpc: Rpc<SolanaRpcApi>,
  addresses: Address[],
): Promise<(AssetV1 | null)[]> {
  const accounts = await fetchEncodedAccounts(rpc, addresses);
  return accounts.map((acct) => {
    if (!acct.exists) return null;
    return decodeAssetV1(acct.data);
  });
}

// Query helpers (getProgramAccounts)─

export async function fetchAssetsByOwner(
  rpc: Rpc<SolanaRpcApi>,
  ownerAddress: Address,
  programId: Address = MPL_CORE_PROGRAM_ID,
): Promise<ProgramAccount<AssetV1>[]> {
  // AssetV1: offset 0 = key (1), offset 1 = owner (32 bytes)
  const ownerBytes = new Uint8Array(addrEnc.encode(ownerAddress));
  const result = await rpc
    .getProgramAccounts(programId, {
      encoding: "base64",
      filters: [
        {
          memcmp: {
            offset: 0n,
            bytes: b64Dec.decode(new Uint8Array([MplCoreKey.AssetV1])) as Base64EncodedBytes,
            encoding: "base64",
          },
        },
        {
          memcmp: {
            offset: 1n,
            bytes: b64Dec.decode(ownerBytes) as Base64EncodedBytes,
            encoding: "base64",
          },
        },
      ],
    })
    .send();
  return result.map(({ pubkey, account }) => ({
    address: pubkey,
    data: decodeAssetV1(new Uint8Array(b64Enc.encode(account.data[0] as string))),
  }));
}

export async function fetchAssetsByCollection(
  rpc: Rpc<SolanaRpcApi>,
  collectionAddress: Address,
  programId: Address = MPL_CORE_PROGRAM_ID,
): Promise<ProgramAccount<AssetV1>[]> {
  // AssetV1: offset 33 = updateAuthority { type: u8(2=Collection), address: [u8;32] }
  const collBytes = new Uint8Array(addrEnc.encode(collectionAddress));
  const uaFilter = new Uint8Array(1 + 32);
  uaFilter[0] = UpdateAuthorityType.Collection;
  uaFilter.set(collBytes, 1);
  const result = await rpc
    .getProgramAccounts(programId, {
      encoding: "base64",
      filters: [
        {
          memcmp: {
            offset: 0n,
            bytes: b64Dec.decode(new Uint8Array([MplCoreKey.AssetV1])) as Base64EncodedBytes,
            encoding: "base64",
          },
        },
        {
          memcmp: {
            offset: 33n,
            bytes: b64Dec.decode(uaFilter) as Base64EncodedBytes,
            encoding: "base64",
          },
        },
      ],
    })
    .send();
  return result.map(({ pubkey, account }) => ({
    address: pubkey,
    data: decodeAssetV1(new Uint8Array(b64Enc.encode(account.data[0] as string))),
  }));
}

// Existence checks──

export async function collectionExists(rpc: Rpc<SolanaRpcApi>, address: Address): Promise<boolean> {
  const account = await fetchEncodedAccount(rpc, address);
  return account.exists && account.data[0] === MplCoreKey.CollectionV1;
}

export async function assetExists(rpc: Rpc<SolanaRpcApi>, address: Address): Promise<boolean> {
  const account = await fetchEncodedAccount(rpc, address);
  return account.exists && account.data[0] === MplCoreKey.AssetV1;
}
