/**
 * CollectionV1 + AssetV1 Borsh decoders for MPL Core.
 *
 * MPL Core accounts use Borsh encoding with variable-length strings.
 * These decoders parse the raw bytes manually.
 */
import { type Address, getAddressDecoder } from "gill";
import {
  ASSET_V1_MIN_SIZE,
  COLLECTION_V1_MIN_SIZE,
  MplCoreKey,
  PluginAuthority,
  PluginType,
  UpdateAuthorityType as UAType,
  type UpdateAuthorityType,
} from "./constants.js";

// Types

export interface UpdateAuthority {
  type: UpdateAuthorityType;
  address: Address;
}

export interface CollectionV1 {
  key: number;
  updateAuthority: UpdateAuthority;
  name: string;
  uri: string;
  numMinted: number;
  currentSize: number;
}

export interface AssetV1 {
  key: number;
  owner: Address;
  updateAuthority: UpdateAuthority;
  name: string;
  uri: string;
  seq: bigint | null;
  plugins: DecodedPlugin[];
}

// Plugin Types

export interface Attribute {
  key: string;
  value: string;
}

export interface FreezeDelegateData {
  type: PluginType.FreezeDelegate;
  authority: PluginAuthority;
  authorityAddress: Address | null;
  frozen: boolean;
}

export interface BurnDelegateData {
  type: PluginType.BurnDelegate;
  authority: PluginAuthority;
  authorityAddress: Address | null;
}

export interface TransferDelegateData {
  type: PluginType.TransferDelegate;
  authority: PluginAuthority;
  authorityAddress: Address | null;
}

export interface AttributesData {
  type: PluginType.Attributes;
  authority: PluginAuthority;
  authorityAddress: Address | null;
  attributes: Attribute[];
}

export interface PermanentFreezeDelegateData {
  type: PluginType.PermanentFreezeDelegate;
  authority: PluginAuthority;
  authorityAddress: Address | null;
  frozen: boolean;
}

export interface UnknownPluginData {
  type: PluginType;
  authority: PluginAuthority;
  authorityAddress: Address | null;
}

export type DecodedPlugin =
  | FreezeDelegateData
  | BurnDelegateData
  | TransferDelegateData
  | AttributesData
  | PermanentFreezeDelegateData
  | UnknownPluginData;

// Helpers

const utf8Dec = new TextDecoder();
const addrDec = getAddressDecoder();

function readAddress(data: Uint8Array, offset: number): Address {
  return addrDec.decode(data.slice(offset, offset + 32));
}

function readU32LE(dv: DataView, offset: number): number {
  return dv.getUint32(offset, true);
}

// CollectionV1 decoder
//
// Borsh layout:
//   key(1) + update_authority(32) + name(4+N) + uri(4+M) + num_minted(4) + current_size(4)

export function decodeCollectionV1(data: Uint8Array): CollectionV1 {
  if (data.length < COLLECTION_V1_MIN_SIZE) {
    throw new Error(
      `CollectionV1: expected at least ${COLLECTION_V1_MIN_SIZE} bytes, got ${data.length}`,
    );
  }
  if (data[0] !== MplCoreKey.CollectionV1) {
    throw new Error(`CollectionV1: invalid key ${data[0]}`);
  }

  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 1;

  // update_authority: plain 32-byte pubkey (no discriminant for collections)
  const uaAddress = readAddress(data, offset);
  offset += 32;

  // name: Borsh string (4-byte LE length + bytes)
  const nameLen = readU32LE(dv, offset);
  offset += 4;
  const name = utf8Dec.decode(data.subarray(offset, offset + nameLen));
  offset += nameLen;

  // uri: Borsh string
  const uriLen = readU32LE(dv, offset);
  offset += 4;
  const uri = utf8Dec.decode(data.subarray(offset, offset + uriLen));
  offset += uriLen;

  // num_minted + current_size
  const numMinted = readU32LE(dv, offset);
  offset += 4;
  const currentSize = readU32LE(dv, offset);

  return {
    key: data[0],
    updateAuthority: { type: UAType.Address, address: uaAddress },
    name,
    uri,
    numMinted,
    currentSize,
  };
}

// AssetV1 decoder
//
// Borsh layout:
//   key(1) + owner(32) + ua_disc(1) + [ua_pubkey(32)] + name(4+N) + uri(4+M) + [seq_option(1) + seq(8)]

export function decodeAssetV1(data: Uint8Array): AssetV1 {
  if (data.length < ASSET_V1_MIN_SIZE) {
    throw new Error(`AssetV1: expected at least ${ASSET_V1_MIN_SIZE} bytes, got ${data.length}`);
  }
  if (data[0] !== MplCoreKey.AssetV1) {
    throw new Error(`AssetV1: invalid key ${data[0]}`);
  }

  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 1;

  // owner: 32 bytes
  const owner = readAddress(data, offset);
  offset += 32;

  // update_authority: enum disc(1) + optional pubkey(32)
  const uaDisc = data[offset];
  offset += 1;
  let uaAddress: Address;
  let uaType: UpdateAuthorityType;
  if (uaDisc === UAType.Address || uaDisc === UAType.Collection) {
    uaAddress = readAddress(data, offset);
    offset += 32;
    uaType = uaDisc as UpdateAuthorityType;
  } else {
    uaAddress = readAddress(new Uint8Array(32), 0); // zero address for None
    uaType = UAType.None;
  }

  // name: Borsh string
  const nameLen = readU32LE(dv, offset);
  offset += 4;
  const name = utf8Dec.decode(data.subarray(offset, offset + nameLen));
  offset += nameLen;

  // uri: Borsh string
  const uriLen = readU32LE(dv, offset);
  offset += 4;
  const uri = utf8Dec.decode(data.subarray(offset, offset + uriLen));
  offset += uriLen;

  // seq: Option<u64>
  let seq: bigint | null = null;
  if (offset < data.length) {
    const seqOption = data[offset];
    offset += 1;
    if (seqOption === 1 && offset + 8 <= data.length) {
      seq = dv.getBigUint64(offset, true);
      offset += 8;
    }
  }

  // Plugin decoding
  const plugins = decodePlugins(data, dv, offset);

  return {
    key: data[0],
    owner,
    updateAuthority: { type: uaType, address: uaAddress },
    name,
    uri,
    seq,
    plugins,
  };
}

// Plugin decoder internals

interface RegistryRecord {
  pluginType: PluginType;
  authority: PluginAuthority;
  authorityAddress: Address | null;
  dataOffset: number;
}

function decodePlugins(data: Uint8Array, dv: DataView, offset: number): DecodedPlugin[] {
  // Check for PluginHeaderV1
  if (offset >= data.length || data[offset] !== MplCoreKey.PluginHeaderV1) {
    return [];
  }
  offset += 1; // skip key byte

  if (offset + 8 > data.length) return [];
  const registryOffset = Number(dv.getBigUint64(offset, true));

  // Jump to PluginRegistryV1
  if (registryOffset >= data.length || data[registryOffset] !== MplCoreKey.PluginRegistryV1) {
    return [];
  }

  let regOff = registryOffset + 1; // skip key byte

  // Vec<RegistryRecord>: count(u32 LE) + N records
  if (regOff + 4 > data.length) return [];
  const recordCount = readU32LE(dv, regOff);
  regOff += 4;

  const records: RegistryRecord[] = [];
  for (let i = 0; i < recordCount; i++) {
    if (regOff >= data.length) break;

    // plugin_type: u8 (Borsh enum variant)
    const pluginType = data[regOff] as PluginType;
    regOff += 1;

    // authority: Borsh enum
    if (regOff >= data.length) break;
    const authDisc = data[regOff] as PluginAuthority;
    regOff += 1;

    let authorityAddress: Address | null = null;
    if (authDisc === PluginAuthority.Address) {
      if (regOff + 32 > data.length) break;
      authorityAddress = readAddress(data, regOff);
      regOff += 32;
    }

    // data_offset: u64 LE
    if (regOff + 8 > data.length) break;
    const dataOffset = Number(dv.getBigUint64(regOff, true));
    regOff += 8;

    records.push({ pluginType, authority: authDisc, authorityAddress, dataOffset });
  }

  // Decode each plugin's data
  return records.map((rec) => decodePluginData(data, dv, rec));
}

function decodePluginData(data: Uint8Array, dv: DataView, rec: RegistryRecord): DecodedPlugin {
  const { pluginType, authority, authorityAddress, dataOffset } = rec;
  const base = { authority, authorityAddress };

  // On-chain data at dataOffset is the Borsh-serialized Plugin enum:
  // variant discriminator (1 byte) + inner struct fields.
  // Skip the discriminator to get to the actual plugin data.
  const off = dataOffset + 1;

  switch (pluginType) {
    case PluginType.FreezeDelegate: {
      if (off >= data.length) {
        return { type: PluginType.FreezeDelegate, ...base, frozen: false };
      }
      const frozen = data[off] === 1;
      return { type: PluginType.FreezeDelegate, ...base, frozen };
    }

    case PluginType.BurnDelegate:
      return { type: PluginType.BurnDelegate, ...base };

    case PluginType.TransferDelegate:
      return { type: PluginType.TransferDelegate, ...base };

    case PluginType.Attributes: {
      const attributes = decodeAttributes(data, dv, off);
      return { type: PluginType.Attributes, ...base, attributes };
    }

    case PluginType.PermanentFreezeDelegate: {
      if (off >= data.length) {
        return { type: PluginType.PermanentFreezeDelegate, ...base, frozen: false };
      }
      const frozen = data[off] === 1;
      return { type: PluginType.PermanentFreezeDelegate, ...base, frozen };
    }

    default:
      return { type: pluginType, ...base };
  }
}

function decodeAttributes(data: Uint8Array, dv: DataView, offset: number): Attribute[] {
  if (offset + 4 > data.length) return [];

  const count = readU32LE(dv, offset);
  let off = offset + 4;

  const attrs: Attribute[] = [];
  for (let i = 0; i < count; i++) {
    if (off + 4 > data.length) break;
    const keyLen = readU32LE(dv, off);
    off += 4;
    if (off + keyLen > data.length) break;
    const key = utf8Dec.decode(data.subarray(off, off + keyLen));
    off += keyLen;

    if (off + 4 > data.length) break;
    const valLen = readU32LE(dv, off);
    off += 4;
    if (off + valLen > data.length) break;
    const value = utf8Dec.decode(data.subarray(off, off + valLen));
    off += valLen;

    attrs.push({ key, value });
  }

  return attrs;
}
