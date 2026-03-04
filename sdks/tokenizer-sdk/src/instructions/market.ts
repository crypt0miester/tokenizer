import type { Address } from "gill";
import { SYSTEM_PROGRAM_ADDRESS } from "gill/programs";
import { TOKEN_PROGRAM_ADDRESS } from "gill/programs/token";
import { InstructionType, MPL_CORE_PROGRAM_ID } from "../constants.js";
import { buildIx, concat, encI64, encU8, encU64, ro, roS, wr, wrS } from "./shared.js";

/** Discriminant 40 — List an asset token for sale. */
export function listForSale(p: {
  config: Address;
  assetAccount: Address;
  assetTokenAccount: Address;
  listingAccount: Address;
  seller: Address;
  payer: Address;
  systemProgram?: Address;
  sharesForSale: bigint;
  pricePerShare: bigint;
  isPartial: boolean;
  expiry: bigint;
  programId?: Address;
}) {
  return buildIx(
    InstructionType.ListForSale,
    [
      ro(p.config),
      ro(p.assetAccount),
      wr(p.assetTokenAccount),
      wr(p.listingAccount),
      roS(p.seller),
      wrS(p.payer),
      ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
    ],
    concat(
      encU64(p.sharesForSale),
      encU64(p.pricePerShare),
      encU8(p.isPartial ? 1 : 0),
      encI64(p.expiry),
    ),
    p.programId,
  );
}

/** Discriminant 41 — Delist (cancel listing). */
export function delist(p: {
  assetTokenAccount: Address;
  listingAccount: Address;
  seller: Address;
  systemProgram?: Address;
  rentDestination: Address;
  programId?: Address;
}) {
  return buildIx(
    InstructionType.Delist,
    [wr(p.assetTokenAccount), wr(p.listingAccount), wrS(p.seller), ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS), wr(p.rentDestination)],
    undefined,
    p.programId,
  );
}

/** Discriminant 42 — Buy a listed token (full or partial). */
export function buyListedToken(p: {
  config: Address;
  asset: Address;
  assetToken: Address;
  listing: Address;
  nft: Address;
  collection: Address;
  collectionAuthority: Address;
  buyer: Address;
  seller: Address;
  buyerTokenAcc: Address;
  sellerTokenAcc: Address;
  feeTreasuryToken: Address;
  payer: Address;
  acceptedMint: Address;
  systemProgram?: Address;
  tokenProgram?: Address;
  mplCoreProgram?: Address;
  ataProgram: Address;
  rentDestination: Address;
  partial?: {
    newNftBuyer: Address;
    buyerAssetToken: Address;
    newNftSeller: Address;
    sellerAssetToken: Address;
  };
  programId?: Address;
}) {
  const accounts = [
    ro(p.config),
    wr(p.asset),
    wr(p.assetToken),
    wr(p.listing),
    wr(p.nft),
    wr(p.collection),
    ro(p.collectionAuthority),
    roS(p.buyer),
    ro(p.seller),
    wr(p.buyerTokenAcc),
    wr(p.sellerTokenAcc),
    wr(p.feeTreasuryToken),
    wrS(p.payer),
    ro(p.acceptedMint),
    ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
    ro(p.tokenProgram ?? TOKEN_PROGRAM_ADDRESS),
    ro(p.mplCoreProgram ?? MPL_CORE_PROGRAM_ID),
    ro(p.ataProgram),
    wr(p.rentDestination),
  ];
  if (p.partial) {
    accounts.push(
      wrS(p.partial.newNftBuyer),
      wr(p.partial.buyerAssetToken),
      wrS(p.partial.newNftSeller),
      wr(p.partial.sellerAssetToken),
    );
  }
  return buildIx(InstructionType.BuyListedToken, accounts, undefined, p.programId);
}

/** Discriminant 43 — Make an offer on an asset token. */
export function makeOffer(p: {
  config: Address;
  assetAccount: Address;
  assetTokenAccount: Address;
  offerAccount: Address;
  escrow: Address;
  acceptedMint: Address;
  buyerTokenAcc: Address;
  buyer: Address;
  payer: Address;
  systemProgram?: Address;
  tokenProgram?: Address;
  sharesRequested: bigint;
  pricePerShare: bigint;
  expiry: bigint;
  programId?: Address;
}) {
  return buildIx(
    InstructionType.MakeOffer,
    [
      ro(p.config),
      ro(p.assetAccount),
      ro(p.assetTokenAccount),
      wr(p.offerAccount),
      wr(p.escrow),
      ro(p.acceptedMint),
      wr(p.buyerTokenAcc),
      roS(p.buyer),
      wrS(p.payer),
      ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
      ro(p.tokenProgram ?? TOKEN_PROGRAM_ADDRESS),
    ],
    concat(encU64(p.sharesRequested), encU64(p.pricePerShare), encI64(p.expiry)),
    p.programId,
  );
}

/** Discriminant 44 — Accept an offer (full or partial). */
export function acceptOffer(p: {
  config: Address;
  asset: Address;
  assetToken: Address;
  offer: Address;
  escrow: Address;
  nft: Address;
  collection: Address;
  collectionAuthority: Address;
  seller: Address;
  buyer: Address;
  sellerTokenAcc: Address;
  feeTreasuryToken: Address;
  payer: Address;
  acceptedMint: Address;
  systemProgram?: Address;
  tokenProgram?: Address;
  mplCoreProgram?: Address;
  ataProgram: Address;
  rentDestination: Address;
  partial?: {
    newNftBuyer: Address;
    buyerAssetToken: Address;
    newNftSeller: Address;
    sellerAssetToken: Address;
  };
  programId?: Address;
}) {
  const accounts = [
    ro(p.config),
    ro(p.asset),
    wr(p.assetToken),
    wr(p.offer),
    wr(p.escrow),
    wr(p.nft),
    wr(p.collection),
    ro(p.collectionAuthority),
    roS(p.seller),
    ro(p.buyer),
    wr(p.sellerTokenAcc),
    wr(p.feeTreasuryToken),
    wrS(p.payer),
    ro(p.acceptedMint),
    ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
    ro(p.tokenProgram ?? TOKEN_PROGRAM_ADDRESS),
    ro(p.mplCoreProgram ?? MPL_CORE_PROGRAM_ID),
    ro(p.ataProgram),
    wr(p.rentDestination),
  ];
  if (p.partial) {
    accounts.push(
      wrS(p.partial.newNftBuyer),
      wr(p.partial.buyerAssetToken),
      wrS(p.partial.newNftSeller),
      wr(p.partial.sellerAssetToken),
    );
  }
  return buildIx(InstructionType.AcceptOffer, accounts, undefined, p.programId);
}

/** Discriminant 45 — Reject an offer (refund buyer). */
export function rejectOffer(p: {
  assetTokenAccount: Address;
  offerAccount: Address;
  escrow: Address;
  buyerTokenAcc: Address;
  seller: Address;
  buyer: Address;
  acceptedMint: Address;
  systemProgram?: Address;
  tokenProgram?: Address;
  ataProgram: Address;
  rentDestination: Address;
  programId?: Address;
}) {
  return buildIx(
    InstructionType.RejectOffer,
    [
      ro(p.assetTokenAccount),
      wr(p.offerAccount),
      wr(p.escrow),
      wr(p.buyerTokenAcc),
      wrS(p.seller),
      ro(p.buyer),
      ro(p.acceptedMint),
      ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
      ro(p.tokenProgram ?? TOKEN_PROGRAM_ADDRESS),
      ro(p.ataProgram),
      wr(p.rentDestination),
    ],
    undefined,
    p.programId,
  );
}

/** Discriminant 46 — Cancel own offer (refund). */
export function cancelOffer(p: {
  offerAccount: Address;
  escrow: Address;
  buyerTokenAcc: Address;
  buyer: Address;
  acceptedMint: Address;
  systemProgram?: Address;
  tokenProgram?: Address;
  ataProgram: Address;
  rentDestination: Address;
  programId?: Address;
}) {
  return buildIx(
    InstructionType.CancelOffer,
    [
      wr(p.offerAccount),
      wr(p.escrow),
      wr(p.buyerTokenAcc),
      wrS(p.buyer),
      ro(p.acceptedMint),
      ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
      ro(p.tokenProgram ?? TOKEN_PROGRAM_ADDRESS),
      ro(p.ataProgram),
      wr(p.rentDestination),
    ],
    undefined,
    p.programId,
  );
}

/** Discriminant 48 — Transfer a token directly (P2P, no payment). */
export function transferToken(p: {
  config: Address;
  asset: Address;
  assetToken: Address;
  nft: Address;
  collection: Address;
  collectionAuthority: Address;
  owner: Address;
  newOwner: Address;
  payer: Address;
  systemProgram?: Address;
  mplCoreProgram?: Address;
  programId?: Address;
}) {
  return buildIx(
    InstructionType.TransferToken,
    [
      ro(p.config),
      ro(p.asset),
      wr(p.assetToken),
      wr(p.nft),
      wr(p.collection),
      ro(p.collectionAuthority),
      roS(p.owner),
      ro(p.newOwner),
      wrS(p.payer),
      ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
      ro(p.mplCoreProgram ?? MPL_CORE_PROGRAM_ID),
    ],
    undefined,
    p.programId,
  );
}

/** Discriminant 47 — Consolidate multiple tokens into one. */
export function consolidateTokens(p: {
  config: Address;
  asset: Address;
  collection: Address;
  collectionAuthority: Address;
  newNft: Address;
  newAssetToken: Address;
  owner: Address;
  payer: Address;
  systemProgram?: Address;
  mplCoreProgram?: Address;
  tokens: Array<{ assetToken: Address; nft: Address }>;
  programId?: Address;
}) {
  const accounts = [
    ro(p.config),
    ro(p.asset),
    wr(p.collection),
    ro(p.collectionAuthority),
    wrS(p.newNft),
    wr(p.newAssetToken),
    roS(p.owner),
    wrS(p.payer),
    ro(p.systemProgram ?? SYSTEM_PROGRAM_ADDRESS),
    ro(p.mplCoreProgram ?? MPL_CORE_PROGRAM_ID),
  ];
  for (const t of p.tokens) {
    accounts.push(wr(t.assetToken), wr(t.nft));
  }
  return buildIx(InstructionType.Consolidate, accounts, encU8(p.tokens.length), p.programId);
}
