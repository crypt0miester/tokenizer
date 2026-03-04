/**
 * Decode tokenizer program instruction data into typed objects.
 *
 * Reads the u16 LE discriminant, then dispatches to payload-specific parsers.
 * Useful for transaction analysis and history display.
 */
import type { Address } from "gill";
import { addr, i64d, u8d, u16d, u32d, u64d } from "../accounts/decode.js";
import { InstructionType } from "../constants.js";

const utf8 = new TextDecoder();

/** Read a length-prefixed (u8) UTF-8 string, returns [string, nextOffset]. */
function readPrefixedStr(d: Uint8Array, o: number): [string, number] {
  const [len, o2] = u8d.read(d, o);
  return [utf8.decode(d.subarray(o2, o2 + len)), o2 + len];
}

// Decoded instruction types

export type DecodedInstruction =
  // Protocol
  | {
      type: "Initialize";
      feeBps: number;
      feeTreasury: Address;
      computationKey: Address;
      acceptedMint: Address;
    }
  | { type: "UpdateConfigFeeBps"; feeBps: number }
  | { type: "UpdateConfigFeeTreasury"; feeTreasury: Address }
  | { type: "UpdateConfigComputationKey"; computationKey: Address }
  | { type: "UpdateConfigAddMint"; mint: Address }
  | { type: "UpdateConfigRemoveMint"; mint: Address }
  | { type: "UpdateConfigSetOperator"; newOperator: Address }
  | { type: "UpdateConfigMinProposalWeightBps"; minProposalWeightBps: number }
  | { type: "Pause" }
  | { type: "Unpause" }
  // Organization
  | {
      type: "Register";
      authority: Address;
      name: string;
      registrationNumber: string;
      country: string;
    }
  | { type: "Deregister"; orgId: number }
  | { type: "UpdateOrgAddMint"; mint: Address }
  | { type: "UpdateOrgRemoveMint"; mint: Address }
  // Asset
  | {
      type: "InitAsset";
      totalShares: bigint;
      pricePerShare: bigint;
      acceptedMint: Address;
      maturityDate: bigint;
      maturityGracePeriod: bigint;
      transferCooldown: bigint;
      maxHolders: number;
      name: string;
      uri: string;
    }
  | { type: "MintToken"; shares: bigint; recipient: Address }
  | { type: "UpdateMetadata"; orgId: number; assetId: number; newName: string; newUri: string }
  // Fundraising
  | {
      type: "CreateRound";
      sharesOffered: bigint;
      pricePerShare: bigint;
      minRaise: bigint;
      maxRaise: bigint;
      minPerWallet: bigint;
      maxPerWallet: bigint;
      startTime: bigint;
      endTime: bigint;
      lockupEnd: bigint;
      termsHash: Uint8Array;
    }
  | { type: "Invest"; shares: bigint; termsHash: Uint8Array }
  | { type: "FinalizeRound" }
  | { type: "MintRoundTokens"; count: number }
  | { type: "RefundInvestment"; count: number }
  | { type: "CancelRound" }
  // Market
  | {
      type: "ListForSale";
      sharesForSale: bigint;
      pricePerShare: bigint;
      isPartial: boolean;
      expiry: bigint;
    }
  | { type: "Delist" }
  | { type: "BuyListedToken" }
  | { type: "MakeOffer"; sharesRequested: bigint; pricePerShare: bigint; expiry: bigint }
  | { type: "AcceptOffer" }
  | { type: "RejectOffer" }
  | { type: "CancelOffer" }
  | { type: "Consolidate"; count: number }
  // Distribution
  | { type: "CreateDistribution"; totalAmount: bigint }
  | { type: "ClaimDistribution"; count: number }
  | { type: "CloseDistribution" }
  // Emergency
  | { type: "BurnAndRemint"; newOwner: Address; reason: number; sharesToTransfer: bigint }
  | { type: "SplitAndRemint"; shares: bigint[] }
  // Governance
  | { type: "CreateRegistrar"; governanceProgramId: Address }
  | { type: "CreateVoterWeightRecord" }
  | { type: "CreateMaxVoterWeightRecord" }
  | { type: "UpdateVoterWeightRecord"; action: number; actionTarget: Address }
  | { type: "RelinquishVoterWeight" }
  | {
      type: "CreateProtocolRealm";
      realmName: string;
      governanceConfigData: Uint8Array;
      memberCount: number;
    }
  | {
      type: "CreateOrgRealm";
      realmName: string;
      governanceConfigData: Uint8Array;
      memberCount: number;
    }
  | { type: "CreateAssetGovernance"; governanceConfigData: Uint8Array }
  // Buyout
  | {
      type: "CreateBuyoutOffer";
      pricePerShare: bigint;
      isCouncilBuyout: boolean;
      treasuryDisposition: number;
      broker: Address;
      brokerBps: number;
      termsHash: Uint8Array;
      expiry: bigint;
    }
  | { type: "FundBuyoutOffer" }
  | { type: "ApproveBuyout" }
  | { type: "SettleBuyout"; count: number }
  | { type: "CompleteBuyout" }
  | { type: "CancelBuyout" };

// Instruction name lookup

const INSTRUCTION_NAMES: Record<number, string> = {
  [InstructionType.Initialize]: "Initialize",
  [InstructionType.UpdateConfig]: "UpdateConfig",
  [InstructionType.Pause]: "Pause",
  [InstructionType.Unpause]: "Unpause",
  [InstructionType.Register]: "Register",
  [InstructionType.Deregister]: "Deregister",
  [InstructionType.UpdateOrg]: "UpdateOrg",
  [InstructionType.InitAsset]: "InitAsset",
  [InstructionType.MintToken]: "MintToken",
  [InstructionType.UpdateMetadata]: "UpdateMetadata",
  [InstructionType.CreateRound]: "CreateRound",
  [InstructionType.Invest]: "Invest",
  [InstructionType.FinalizeRound]: "FinalizeRound",
  [InstructionType.MintRoundTokens]: "MintRoundTokens",
  [InstructionType.RefundInvestment]: "RefundInvestment",
  [InstructionType.CancelRound]: "CancelRound",
  [InstructionType.ListForSale]: "ListForSale",
  [InstructionType.Delist]: "Delist",
  [InstructionType.BuyListedToken]: "BuyListedToken",
  [InstructionType.MakeOffer]: "MakeOffer",
  [InstructionType.AcceptOffer]: "AcceptOffer",
  [InstructionType.RejectOffer]: "RejectOffer",
  [InstructionType.CancelOffer]: "CancelOffer",
  [InstructionType.Consolidate]: "Consolidate",
  [InstructionType.CreateDistribution]: "CreateDistribution",
  [InstructionType.ClaimDistribution]: "ClaimDistribution",
  [InstructionType.CloseDistribution]: "CloseDistribution",
  [InstructionType.BurnAndRemint]: "BurnAndRemint",
  [InstructionType.SplitAndRemint]: "SplitAndRemint",
  [InstructionType.CreateRegistrar]: "CreateRegistrar",
  [InstructionType.CreateVoterWeightRecord]: "CreateVoterWeightRecord",
  [InstructionType.CreateMaxVoterWeightRecord]: "CreateMaxVoterWeightRecord",
  [InstructionType.UpdateVoterWeightRecord]: "UpdateVoterWeightRecord",
  [InstructionType.RelinquishVoterWeight]: "RelinquishVoterWeight",
  [InstructionType.CreateProtocolRealm]: "CreateProtocolRealm",
  [InstructionType.CreateOrgRealm]: "CreateOrgRealm",
  [InstructionType.CreateAssetGovernance]: "CreateAssetGovernance",
  [InstructionType.CreateBuyoutOffer]: "CreateBuyoutOffer",
  [InstructionType.FundBuyoutOffer]: "FundBuyoutOffer",
  [InstructionType.ApproveBuyout]: "ApproveBuyout",
  [InstructionType.SettleBuyout]: "SettleBuyout",
  [InstructionType.CompleteBuyout]: "CompleteBuyout",
  [InstructionType.CancelBuyout]: "CancelBuyout",
};

/** Quick name lookup without full decode. Returns null for unknown discriminants. */
export function getInstructionName(data: Uint8Array): string | null {
  if (data.length < 2) return null;
  const [disc] = u16d.read(data, 0);
  return INSTRUCTION_NAMES[disc] ?? null;
}

// Main decoder

/** Decode tokenizer instruction data into a typed object. Throws on unknown/malformed data. */
export function decodeInstruction(data: Uint8Array): DecodedInstruction {
  if (data.length < 2) throw new Error("Instruction data too short");
  const [disc, o] = u16d.read(data, 0);

  switch (disc) {
    // Protocol

    case InstructionType.Initialize: {
      const [feeBps, o1] = u16d.read(data, o);
      const [feeTreasury, o2] = addr.read(data, o1);
      const [computationKey, o3] = addr.read(data, o2);
      const [acceptedMint] = addr.read(data, o3);
      return { type: "Initialize", feeBps, feeTreasury, computationKey, acceptedMint };
    }

    case InstructionType.UpdateConfig: {
      const [variant, o1] = u8d.read(data, o);
      switch (variant) {
        case 0: {
          const [feeBps] = u16d.read(data, o1);
          return { type: "UpdateConfigFeeBps", feeBps };
        }
        case 1: {
          const [feeTreasury] = addr.read(data, o1);
          return { type: "UpdateConfigFeeTreasury", feeTreasury };
        }
        case 2: {
          const [computationKey] = addr.read(data, o1);
          return { type: "UpdateConfigComputationKey", computationKey };
        }
        case 3: {
          const [mint] = addr.read(data, o1);
          return { type: "UpdateConfigAddMint", mint };
        }
        case 4: {
          const [mint] = addr.read(data, o1);
          return { type: "UpdateConfigRemoveMint", mint };
        }
        case 5: {
          const [newOperator] = addr.read(data, o1);
          return { type: "UpdateConfigSetOperator", newOperator };
        }
        case 6: {
          const [minProposalWeightBps] = u16d.read(data, o1);
          return { type: "UpdateConfigMinProposalWeightBps", minProposalWeightBps };
        }
        default:
          throw new Error(`Unknown UpdateConfig variant: ${variant}`);
      }
    }

    case InstructionType.Pause:
      return { type: "Pause" };

    case InstructionType.Unpause:
      return { type: "Unpause" };

    // Organization

    case InstructionType.Register: {
      const [authority, o1] = addr.read(data, o);
      const [name, o2] = readPrefixedStr(data, o1);
      const [registrationNumber, o3] = readPrefixedStr(data, o2);
      const country = utf8.decode(data.subarray(o3, o3 + 4)).replace(/\0+$/, "");
      return { type: "Register", authority, name, registrationNumber, country };
    }

    case InstructionType.Deregister: {
      const [orgId] = u32d.read(data, o);
      return { type: "Deregister", orgId };
    }

    case InstructionType.UpdateOrg: {
      const [variant, o1] = u8d.read(data, o);
      const [mint] = addr.read(data, o1);
      if (variant === 0) return { type: "UpdateOrgAddMint", mint };
      if (variant === 1) return { type: "UpdateOrgRemoveMint", mint };
      throw new Error(`Unknown UpdateOrg variant: ${variant}`);
    }

    // Asset

    case InstructionType.InitAsset: {
      const [totalShares, o1] = u64d.read(data, o);
      const [pricePerShare, o2] = u64d.read(data, o1);
      const [acceptedMint, o3] = addr.read(data, o2);
      const [maturityDate, o4] = i64d.read(data, o3);
      const [maturityGracePeriod, o5] = i64d.read(data, o4);
      const [transferCooldown, o6] = i64d.read(data, o5);
      const [maxHolders, o7] = u32d.read(data, o6);
      const [name, o8] = readPrefixedStr(data, o7);
      const [uri] = readPrefixedStr(data, o8);
      return {
        type: "InitAsset",
        totalShares,
        pricePerShare,
        acceptedMint,
        maturityDate,
        maturityGracePeriod,
        transferCooldown,
        maxHolders,
        name,
        uri,
      };
    }

    case InstructionType.MintToken: {
      const [shares, o1] = u64d.read(data, o);
      const [recipient] = addr.read(data, o1);
      return { type: "MintToken", shares, recipient };
    }

    case InstructionType.UpdateMetadata: {
      const [orgId, o1] = u32d.read(data, o);
      const [assetId, o2] = u32d.read(data, o1);
      const [newName, o3] = readPrefixedStr(data, o2);
      const [newUri] = readPrefixedStr(data, o3);
      return { type: "UpdateMetadata", orgId, assetId, newName, newUri };
    }

    // Fundraising

    case InstructionType.CreateRound: {
      const [sharesOffered, o1] = u64d.read(data, o);
      const [pricePerShare, o2] = u64d.read(data, o1);
      const [minRaise, o3] = u64d.read(data, o2);
      const [maxRaise, o4] = u64d.read(data, o3);
      const [minPerWallet, o5] = u64d.read(data, o4);
      const [maxPerWallet, o6] = u64d.read(data, o5);
      const [startTime, o7] = i64d.read(data, o6);
      const [endTime, o8] = i64d.read(data, o7);
      const [lockupEnd, o9] = i64d.read(data, o8);
      const termsHash = data.slice(o9, o9 + 32);
      return {
        type: "CreateRound",
        sharesOffered,
        pricePerShare,
        minRaise,
        maxRaise,
        minPerWallet,
        maxPerWallet,
        startTime,
        endTime,
        lockupEnd,
        termsHash,
      };
    }

    case InstructionType.Invest: {
      const [shares, o1] = u64d.read(data, o);
      const termsHash = data.slice(o1, o1 + 32);
      return { type: "Invest", shares, termsHash };
    }

    case InstructionType.FinalizeRound:
      return { type: "FinalizeRound" };

    case InstructionType.MintRoundTokens: {
      const [count] = u8d.read(data, o);
      return { type: "MintRoundTokens", count };
    }

    case InstructionType.RefundInvestment: {
      const [count] = u8d.read(data, o);
      return { type: "RefundInvestment", count };
    }

    case InstructionType.CancelRound:
      return { type: "CancelRound" };

    // Market

    case InstructionType.ListForSale: {
      const [sharesForSale, o1] = u64d.read(data, o);
      const [pricePerShare, o2] = u64d.read(data, o1);
      const [isPartialByte, o3] = u8d.read(data, o2);
      const [expiry] = i64d.read(data, o3);
      return {
        type: "ListForSale",
        sharesForSale,
        pricePerShare,
        isPartial: isPartialByte === 1,
        expiry,
      };
    }

    case InstructionType.Delist:
      return { type: "Delist" };

    case InstructionType.BuyListedToken:
      return { type: "BuyListedToken" };

    case InstructionType.MakeOffer: {
      const [sharesRequested, o1] = u64d.read(data, o);
      const [pricePerShare, o2] = u64d.read(data, o1);
      const [expiry] = i64d.read(data, o2);
      return { type: "MakeOffer", sharesRequested, pricePerShare, expiry };
    }

    case InstructionType.AcceptOffer:
      return { type: "AcceptOffer" };

    case InstructionType.RejectOffer:
      return { type: "RejectOffer" };

    case InstructionType.CancelOffer:
      return { type: "CancelOffer" };

    case InstructionType.Consolidate: {
      const [count] = u8d.read(data, o);
      return { type: "Consolidate", count };
    }

    // Distribution

    case InstructionType.CreateDistribution: {
      const [totalAmount] = u64d.read(data, o);
      return { type: "CreateDistribution", totalAmount };
    }

    case InstructionType.ClaimDistribution: {
      const [count] = u8d.read(data, o);
      return { type: "ClaimDistribution", count };
    }

    case InstructionType.CloseDistribution:
      return { type: "CloseDistribution" };

    // Emergency

    case InstructionType.BurnAndRemint: {
      const [newOwner, o1] = addr.read(data, o);
      const [reason, o2] = u8d.read(data, o1);
      const [sharesToTransfer] = u64d.read(data, o2);
      return { type: "BurnAndRemint", newOwner, reason, sharesToTransfer };
    }

    case InstructionType.SplitAndRemint: {
      const [count, o1] = u8d.read(data, o);
      const shares: bigint[] = [];
      let cur = o1;
      for (let i = 0; i < count; i++) {
        const [s, next] = u64d.read(data, cur);
        shares.push(s);
        cur = next;
      }
      return { type: "SplitAndRemint", shares };
    }

    // Governance

    case InstructionType.CreateRegistrar: {
      const [governanceProgramId] = addr.read(data, o);
      return { type: "CreateRegistrar", governanceProgramId };
    }

    case InstructionType.CreateVoterWeightRecord:
      return { type: "CreateVoterWeightRecord" };

    case InstructionType.CreateMaxVoterWeightRecord:
      return { type: "CreateMaxVoterWeightRecord" };

    case InstructionType.UpdateVoterWeightRecord: {
      const [action, o1] = u8d.read(data, o);
      const [actionTarget] = addr.read(data, o1);
      return { type: "UpdateVoterWeightRecord", action, actionTarget };
    }

    case InstructionType.RelinquishVoterWeight:
      return { type: "RelinquishVoterWeight" };

    case InstructionType.CreateProtocolRealm: {
      const [nameLen, o1] = u32d.read(data, o);
      const realmName = utf8.decode(data.subarray(o1, o1 + nameLen));
      const memberCount = data[data.length - 1];
      const governanceConfigData = data.slice(o1 + nameLen, data.length - 1);
      return { type: "CreateProtocolRealm", realmName, governanceConfigData, memberCount };
    }

    case InstructionType.CreateOrgRealm: {
      const [nameLen, o1] = u32d.read(data, o);
      const realmName = utf8.decode(data.subarray(o1, o1 + nameLen));
      const memberCount = data[data.length - 1];
      const governanceConfigData = data.slice(o1 + nameLen, data.length - 1);
      return { type: "CreateOrgRealm", realmName, governanceConfigData, memberCount };
    }

    case InstructionType.CreateAssetGovernance:
      return { type: "CreateAssetGovernance", governanceConfigData: data.slice(o) };

    // Buyout

    case InstructionType.CreateBuyoutOffer: {
      const [pricePerShare, o1] = u64d.read(data, o);
      const [isCouncilByte, o2] = u8d.read(data, o1);
      const [treasuryDisposition, o3] = u8d.read(data, o2);
      const [broker, o4] = addr.read(data, o3);
      const [brokerBps, o5] = u16d.read(data, o4);
      const termsHash = data.slice(o5, o5 + 32);
      const [expiry] = i64d.read(data, o5 + 32);
      return {
        type: "CreateBuyoutOffer",
        pricePerShare,
        isCouncilBuyout: isCouncilByte === 1,
        treasuryDisposition,
        broker,
        brokerBps,
        termsHash,
        expiry,
      };
    }

    case InstructionType.FundBuyoutOffer:
      return { type: "FundBuyoutOffer" };

    case InstructionType.ApproveBuyout:
      return { type: "ApproveBuyout" };

    case InstructionType.SettleBuyout: {
      const [count] = u8d.read(data, o);
      return { type: "SettleBuyout", count };
    }

    case InstructionType.CompleteBuyout:
      return { type: "CompleteBuyout" };

    case InstructionType.CancelBuyout:
      return { type: "CancelBuyout" };

    default:
      throw new Error(`Unknown instruction discriminant: ${disc}`);
  }
}
