import type { Address } from "gill";
import type { Asset } from "./accounts/asset.js";
import type { AssetToken } from "./accounts/assetToken.js";
import type { Organization } from "./accounts/organization.js";
import type { AssetV1 } from "./external/mpl-core/accounts.js";
import type { CollectionV1 } from "./external/mpl-core/accounts.js";
import type { ProposalV2, TokenOwnerRecordV2 } from "./external/governance/accounts.js";
import type { ProgramAccount } from "./filters.js";

export interface AssetTokenWithNft {
  address: Address;
  token: AssetToken;
  nftAddress: Address;
  nft: AssetV1 | null;
}

export interface AssetFull {
  address: Address;
  asset: Asset;
  collection: CollectionV1 | null;
}

export interface OrgGovernanceOverview {
  org: Organization;
  realm: Address;
  governance: Address;
  proposals: ProgramAccount<ProposalV2>[];
  members: ProgramAccount<TokenOwnerRecordV2>[];
}
