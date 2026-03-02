import { type Address, address } from "gill";

export const MPL_CORE_PROGRAM_ID: Address = address("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");

/** First byte of every MPL Core account. */
export enum MplCoreKey {
  Uninitialized = 0,
  AssetV1 = 1,
  HashedAssetV1 = 2,
  PluginHeaderV1 = 3,
  PluginRegistryV1 = 4,
  CollectionV1 = 5,
}

/** UpdateAuthority discriminator (1 byte disc + 32 byte pubkey). */
export enum UpdateAuthorityType {
  None = 0,
  Address = 1,
  Collection = 2,
}

/** MPL Core plugin type discriminators. */
export enum PluginType {
  Royalties = 0,
  FreezeDelegate = 1,
  BurnDelegate = 2,
  TransferDelegate = 3,
  UpdateDelegate = 4,
  PermanentFreezeDelegate = 5,
  Attributes = 6,
  PermanentTransferDelegate = 7,
  PermanentBurnDelegate = 8,
  Edition = 9,
  MasterEdition = 10,
  AddBlocker = 11,
  ImmutableMetadata = 12,
  VerifiedCreators = 13,
  Autograph = 14,
}

/** MPL Core plugin authority discriminators. */
export enum PluginAuthority {
  None = 0,
  Owner = 1,
  UpdateAuthority = 2,
  Address = 3,
}

/** Minimum byte length for a Borsh-encoded CollectionV1 (empty name + uri). */
export const COLLECTION_V1_MIN_SIZE = 49; // key(1) + ua(32) + name(4+0) + uri(4+0) + numMinted(4) + currentSize(4)
/** Minimum byte length for a Borsh-encoded AssetV1 (None ua, empty strings, no seq). */
export const ASSET_V1_MIN_SIZE = 42; // key(1) + owner(32) + ua_disc(1) + name(4+0) + uri(4+0)
export const MAX_NAME_LEN = 32;
export const MAX_URI_LEN = 200;
