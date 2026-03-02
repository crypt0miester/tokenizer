import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import { address, type Address, AccountRole } from "gill";
import {
  MPL_CORE_PROGRAM_ID,
  MplCoreKey,
  UpdateAuthorityType,
  COLLECTION_V1_MIN_SIZE,
  ASSET_V1_MIN_SIZE,
} from "../../src/external/mpl-core/constants.js";
import {
  decodeCollectionV1,
  decodeAssetV1,
} from "../../src/external/mpl-core/accounts.js";
import {
  createCollectionV1,
  createV1,
  transferV1,
  burnV1,
  borshString,
} from "../../src/external/mpl-core/instructions.js";
import {
  buildCollectionV1Bytes,
  buildAssetV1Bytes,
} from "../helpers/accounts.js";

function randAddr(): Address {
  return address(Keypair.generate().publicKey.toBase58());
}

function addrOf(pk: Keypair | { publicKey: { toBase58(): string } }): string {
  return "publicKey" in pk ? pk.publicKey.toBase58() : "";
}

// ── Constants ────────────────────────────────────────────────────────

describe("MPL Core Constants", () => {
  it("program ID is correct", () => {
    expect(MPL_CORE_PROGRAM_ID).toBe("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
  });

  it("MplCoreKey enum values", () => {
    expect(MplCoreKey.Uninitialized).toBe(0);
    expect(MplCoreKey.AssetV1).toBe(1);
    expect(MplCoreKey.HashedAssetV1).toBe(2);
    expect(MplCoreKey.PluginHeaderV1).toBe(3);
    expect(MplCoreKey.PluginRegistryV1).toBe(4);
    expect(MplCoreKey.CollectionV1).toBe(5);
  });

  it("UpdateAuthorityType enum values", () => {
    expect(UpdateAuthorityType.None).toBe(0);
    expect(UpdateAuthorityType.Address).toBe(1);
    expect(UpdateAuthorityType.Collection).toBe(2);
  });

  it("min-size constants", () => {
    expect(COLLECTION_V1_MIN_SIZE).toBe(49);
    expect(ASSET_V1_MIN_SIZE).toBe(42);
  });
});

// ── CollectionV1 Decoder ─────────────────────────────────────────────

describe("decodeCollectionV1", () => {
  const ua = Keypair.generate().publicKey;

  it("decodes all fields correctly", () => {
    const data = buildCollectionV1Bytes({
      updateAuthorityAddress: ua,
      name: "MyColl",
      uri: "https://example.com/coll.json",
      numMinted: 5,
      currentSize: 3,
    });
    const coll = decodeCollectionV1(data);

    expect(coll.key).toBe(MplCoreKey.CollectionV1);
    expect(coll.updateAuthority.type).toBe(UpdateAuthorityType.Address);
    expect(coll.updateAuthority.address).toBe(ua.toBase58());
    expect(coll.name).toBe("MyColl");
    expect(coll.uri).toBe("https://example.com/coll.json");
    expect(coll.numMinted).toBe(5);
    expect(coll.currentSize).toBe(3);
  });

  it("throws on wrong key", () => {
    const data = buildCollectionV1Bytes({ key: MplCoreKey.AssetV1 });
    expect(() => decodeCollectionV1(data)).toThrow("invalid key");
  });

  it("throws on short buffer", () => {
    const data = new Uint8Array(COLLECTION_V1_MIN_SIZE - 1);
    data[0] = MplCoreKey.CollectionV1;
    expect(() => decodeCollectionV1(data)).toThrow(`expected at least ${COLLECTION_V1_MIN_SIZE}`);
  });
});

// ── AssetV1 Decoder ──────────────────────────────────────────────────

describe("decodeAssetV1", () => {
  const owner = Keypair.generate().publicKey;
  const ua = Keypair.generate().publicKey;

  it("decodes with seq correctly", () => {
    const data = buildAssetV1Bytes({
      owner,
      updateAuthorityType: UpdateAuthorityType.Collection,
      updateAuthorityAddress: ua,
      name: "NFT #1",
      uri: "https://example.com/nft1.json",
      seq: 42n,
      hasSeq: true,
    });
    const asset = decodeAssetV1(data);

    expect(asset.key).toBe(MplCoreKey.AssetV1);
    expect(asset.owner).toBe(owner.toBase58());
    expect(asset.updateAuthority.type).toBe(UpdateAuthorityType.Collection);
    expect(asset.updateAuthority.address).toBe(ua.toBase58());
    expect(asset.name).toBe("NFT #1");
    expect(asset.uri).toBe("https://example.com/nft1.json");
    expect(asset.seq).toBe(42n);
  });

  it("decodes without seq (null)", () => {
    const data = buildAssetV1Bytes({
      owner,
      updateAuthorityType: UpdateAuthorityType.Address,
      updateAuthorityAddress: ua,
      name: "NFT #2",
      uri: "https://example.com/nft2.json",
      hasSeq: false,
    });
    const asset = decodeAssetV1(data);
    expect(asset.seq).toBeNull();
  });

  it("throws on wrong key", () => {
    const data = buildAssetV1Bytes({ key: MplCoreKey.CollectionV1 });
    expect(() => decodeAssetV1(data)).toThrow("invalid key");
  });

  it("throws on short buffer", () => {
    const data = new Uint8Array(ASSET_V1_MIN_SIZE - 1);
    data[0] = MplCoreKey.AssetV1;
    expect(() => decodeAssetV1(data)).toThrow(`expected at least ${ASSET_V1_MIN_SIZE}`);
  });
});

// ── borshString helper ───────────────────────────────────────────────

describe("borshString", () => {
  it("encodes correctly with u32LE length prefix", () => {
    const result = borshString("Hello");
    expect(result.length).toBe(4 + 5);
    const dv = new DataView(result.buffer, result.byteOffset, result.byteLength);
    expect(dv.getUint32(0, true)).toBe(5);
    expect(new TextDecoder().decode(result.subarray(4))).toBe("Hello");
  });

  it("handles empty string", () => {
    const result = borshString("");
    expect(result.length).toBe(4);
    const dv = new DataView(result.buffer, result.byteOffset, result.byteLength);
    expect(dv.getUint32(0, true)).toBe(0);
  });

  it("handles unicode", () => {
    const result = borshString("日本語");
    const encoded = new TextEncoder().encode("日本語");
    expect(result.length).toBe(4 + encoded.length);
    const dv = new DataView(result.buffer, result.byteOffset, result.byteLength);
    expect(dv.getUint32(0, true)).toBe(encoded.length);
  });
});

// ── MPL Core Instructions ────────────────────────────────────────────

describe("createCollectionV1", () => {
  it("disc=1, correct accounts", () => {
    const ix = createCollectionV1({
      collection: randAddr(),
      payer: randAddr(),
      name: "Test",
      uri: "https://x.com",
    });
    expect(ix.programAddress).toBe(MPL_CORE_PROGRAM_ID);
    expect(ix.data![0]).toBe(1); // 1-byte discriminant
    expect(ix.accounts).toHaveLength(3); // collection, payer, system (no updateAuthority)
  });

  it("includes updateAuthority account when provided", () => {
    const ix = createCollectionV1({
      collection: randAddr(),
      updateAuthority: randAddr(),
      payer: randAddr(),
      name: "Test",
      uri: "https://x.com",
    });
    expect(ix.accounts).toHaveLength(4);
  });
});

describe("createV1", () => {
  it("disc=0, minimal accounts", () => {
    const ix = createV1({
      asset: randAddr(),
      payer: randAddr(),
      name: "NFT",
      uri: "https://x.com",
    });
    expect(ix.programAddress).toBe(MPL_CORE_PROGRAM_ID);
    expect(ix.data![0]).toBe(0);
    // asset, payer, system = 3 base
    expect(ix.accounts!.length).toBeGreaterThanOrEqual(3);
  });
});

describe("transferV1", () => {
  it("disc=14, correct account roles", () => {
    const ix = transferV1({
      asset: randAddr(),
      payer: randAddr(),
      newOwner: randAddr(),
    });
    expect(ix.data![0]).toBe(14);
    expect(ix.accounts![0].role).toBe(AccountRole.WRITABLE); // asset
    expect(ix.accounts![1].role).toBe(AccountRole.WRITABLE_SIGNER); // payer
    expect(ix.accounts![2].role).toBe(AccountRole.READONLY); // newOwner
  });
});

describe("burnV1", () => {
  it("disc=12, correct account roles", () => {
    const ix = burnV1({
      asset: randAddr(),
      payer: randAddr(),
    });
    expect(ix.data![0]).toBe(12);
    expect(ix.accounts![0].role).toBe(AccountRole.WRITABLE); // asset
    expect(ix.accounts![1].role).toBe(AccountRole.WRITABLE_SIGNER); // payer
  });

  it("includes collection when provided", () => {
    const ix = burnV1({
      asset: randAddr(),
      collection: randAddr(),
      payer: randAddr(),
    });
    expect(ix.accounts).toHaveLength(4); // asset, collection, payer, system
  });
});
