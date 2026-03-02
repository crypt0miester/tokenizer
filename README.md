# Tokenizer

On-chain program and SDK for governance-driven real-world asset (RWA) tokenization on Solana.

Tokenizer enables organizations to register on-chain, issue fractional asset tokens as [Metaplex Core](https://developers.metaplex.com/core) NFTs, run fundraising rounds, operate a secondary market, distribute dividends, and govern all of it through [SPL Governance](https://github.com/solana-labs/solana-program-library/tree/master/governance) — built with [Pinocchio](https://github.com/anza-xyz/pinocchio).

The protocol relies on [SPL Governance](https://github.com/solana-labs/solana-program-library/tree/master/governance) as its authority layer. Protocol-level configuration changes, organization approvals, buyout decisions, and emergency actions are gated behind SPL Governance realms and proposals — the tokenizer program CPIs into SPL Governance to create realms, derive voter weight from token holdings, and enforce on-chain approval flows.

## Architecture

```
programs/tokenizer/       Solana program (Rust, no_std, Pinocchio)
sdks/
  p-core/                 Pinocchio CPI wrapper for Metaplex Core
  p-gov/                  Pinocchio CPI wrapper for SPL Governance
  tokenizer-sdk/          TypeScript client SDK (@solana/kit)
```

## Features

### Protocol Management
- Initialize and configure the global protocol
- Pause/unpause all operations
- Operator-controlled upgrades

### Organizations
- Register organizations with name, registration number, and fee configuration
- Deregister and update organization metadata
- Per-organization fee modes (basis points or flat)

### Asset Tokenization
- Initialize assets under an organization with configurable total shares
- Mint fractional ownership tokens as Metaplex Core NFTs
- Update collection metadata
- Asset lifecycle: Draft → Fundraising → Active → Suspended → Closed

### Fundraising
- Create investment rounds with min/max goals, per-investor limits, and deadlines
- Accept investments into escrow
- Finalize successful rounds and mint tokens to investors
- Refund investors on failed/cancelled rounds

### Secondary Market
- List tokens for sale at a set price
- Buy listed tokens directly
- Make, accept, reject, and cancel counter-offers with escrow
- Consolidate token holdings

### Dividend Distribution
- Create distribution epochs funded by the organization
- Token holders claim proportional dividends
- Close completed distributions and reclaim unclaimed funds

### Emergency Recovery
- Burn and remint tokens (lost keys, court orders, estate settlement, regulatory orders)
- Split and remint for corporate actions
- Full audit trail via EmergencyRecord accounts

### Governance (SPL Governance)

Governance is not optional — it is the protocol's authority mechanism. The tokenizer program CPIs into SPL Governance to:

- Create realms at protocol, organization, and asset level
- Register voter weight plugins so token holdings translate to voting power
- Gate critical operations (buyout approval, emergency recovery, config changes) behind governance proposals
- Manage registrars, voter weight records, and max voter weight records on-chain

### Buyout
- Create and fund buyout offers for entire assets
- Approval requires passing a governance proposal — no unilateral buyouts
- Settle tokens from holders, complete buyout, and handle treasury disposition

## Account Structure

| Account | Discriminator | Description |
|---|---|---|
| ProtocolConfig | 1 | Global singleton — operator, realm, fees |
| Organization | 2 | Registered issuer — name, registration, fee config |
| Asset | 3 | Tokenized asset — status, shares, collection |
| AssetToken | 4 | Individual token — owner, shares, asset reference |
| FundraisingRound | 5 | Investment round — timeline, goals, escrow |
| Investment | 6 | Single investor participation record |
| Listing | 7 | Secondary market listing — price, shares, seller |
| Offer | 8 | Counter-offer — buyer, price, shares |
| DividendDistribution | 9 | Distribution epoch — amount, claims |
| EmergencyRecord | 10 | Recovery audit trail — reason, recipients |
| Registrar | 11 | Governance registrar |
| BuyoutOffer | 12 | Buyout proposal — price, broker, treasury |

All accounts use PDA derivation with deterministic seeds and a single-byte discriminator prefix.

## Instruction Dispatch

Instructions are routed by a `u16` discriminant (first 2 bytes of instruction data):

| Range | Module |
|---|---|
| 0–3 | Protocol |
| 10–12 | Organization |
| 20–22 | Asset |
| 30–35 | Fundraising |
| 40–47 | Secondary Market |
| 50–52 | Distribution |
| 60–61 | Emergency Recovery |
| 70–77 | Governance |
| 85–90 | Buyout |

## Prerequisites

- [Rust](https://rustup.rs/) (edition 2021)
- [Solana CLI tools](https://docs.solanalabs.com/cli/install) with the SBF toolchain
- [Node.js](https://nodejs.org/) >= 18
- [Yarn](https://yarnpkg.com/)

## Build

### Program

```sh
cargo build-sbf
```

Release profile enables LTO, overflow checks, and single codegen unit for minimal binary size.

### TypeScript SDK

```sh
cd sdks/tokenizer-sdk
yarn install
yarn build
```

Outputs CJS and ESM bundles to `dist/` via tsup.

## Test

### TypeScript SDK

```sh
cd sdks/tokenizer-sdk
yarn test            # run once
yarn test:watch      # watch mode
```

Tests use [vitest](https://vitest.dev/) with [LiteSVM](https://github.com/LiteSVM/litesvm) for integration tests against a local Solana VM.

Test suites cover:

- **Unit** — PDA derivation, account decoding, instruction building, MPL Core operations, governance helpers
- **Integration** — Full lifecycle tests for protocol, organization, asset, fundraising, market, distribution, emergency, governance, and buyout flows

## Lint & Format

```sh
# root (biome)
yarn check
yarn format
yarn lint

# sdk
cd sdks/tokenizer-sdk
yarn check
yarn lint
yarn format
```

Uses [Biome](https://biomejs.dev/) — double quotes, semicolons, trailing commas, 2-space indent, 100-char line width.

## TypeScript SDK Usage

```ts
import { TokenizerClient } from "@tokenizer/sdk";

// Initialize client
const client = new TokenizerClient(rpc, programId);

// Fetch protocol config
const config = await client.getProtocolConfig();

// Fetch all assets for an organization
const assets = await client.getAssetsByOrganization(orgAddress);

// Fetch active listings for an asset
const listings = await client.getListingsByAsset(assetAddress);
```

The SDK provides:

- **Account decoders** for all 12 account types
- **Instruction builders** for all 30+ instructions
- **PDA derivation** functions matching the on-chain seeds
- **RPC filters** for efficient account queries via `memcmp`
- **External program helpers** for Metaplex Core and SPL Governance CPIs

## Dependencies

### Rust

| Crate | Version | Purpose |
|---|---|---|
| pinocchio | 0.10.2 | Solana runtime (no_std, CPI) |
| pinocchio-system | 0.5.0 | System program CPI |
| pinocchio-token | 0.5.0 | SPL Token CPI |
| pinocchio-associated-token-account | 0.3.0 | ATA CPI |
| pinocchio-log | 0.5.1 | Program logging |
| solana-address | 2.2.0 | Address utilities (curve25519) |

### TypeScript

| Package | Version | Purpose |
|---|---|---|
| @solana/kit | ^5.0.0 | Solana client |
| gill | ^0.9.0 | Solana utilities |
| litesvm | ^0.4.0 | Local SVM for tests |
| vitest | ^3.0.0 | Test runner |
| tsup | ^8.0.0 | Bundler |
| biome | ^2.4.4 | Linter/formatter |

## License

MIT
