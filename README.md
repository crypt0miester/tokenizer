# Tokenizer

On-chain program and SDK for governance-driven real-world asset (RWA) tokenization on Solana.

Tokenizer enables organizations to register on-chain, issue fractional asset tokens as [Metaplex Core](https://developers.metaplex.com/core) NFTs, run fundraising rounds, operate a secondary market, distribute dividends, and govern all of it through [SPL Governance](https://github.com/solana-labs/solana-program-library/tree/master/governance) — built with [Pinocchio](https://github.com/anza-xyz/pinocchio).

The protocol relies on [SPL Governance](https://github.com/solana-labs/solana-program-library/tree/master/governance) as its authority layer. Protocol-level configuration changes, organization approvals, buyout decisions, and emergency actions are gated behind SPL Governance realms and proposals — the tokenizer program CPIs into SPL Governance to create realms, derive voter weight from token holdings, and enforce on-chain approval flows.

## Why Tokenizer?

Traditional real-world assets — real estate, equipment, revenue streams, intellectual property — are illiquid, hard to divide, and expensive to transfer. Tokenizer lets organizations bring these assets on-chain so they can be fractionally owned, openly traded, and governed by the people who hold them, all without middlemen taking weeks and fees to settle.

**For asset owners and issuers:** raise capital by selling fractional shares of real assets directly to investors, with built-in fundraising rounds, escrow, and automated settlement.

**For investors:** access asset classes that were previously reserved for institutions or accredited investors. Buy fractions of a building, a fleet of vehicles, or a revenue stream — starting at any amount the issuer sets.

**For token holders:** earn dividends proportional to your share, trade on a built-in secondary market, and vote on major decisions (buyout offers, emergency actions, configuration changes) through on-chain governance.

## Use Cases

### Real Estate
A property management company tokenizes a commercial building. Investors worldwide purchase fractional shares during a fundraising round. Rental income flows back as on-chain dividends each quarter. If a buyer wants to acquire the entire building, token holders vote on the buyout offer.

### Small Business Financing
A restaurant group raises expansion capital by tokenizing future revenue from a new location. Investors receive dividend distributions tied to the location's earnings. Shares can be resold on the secondary market as the business matures.

### Equipment and Fleet
A logistics company tokenizes its truck fleet. Investors fund new vehicle purchases through fundraising rounds and receive a share of leasing revenue. When a vehicle is retired, proceeds are distributed proportionally.

### Creative and Intellectual Property
A music catalog, patent portfolio, or film project is tokenized. Rights holders and investors share in licensing revenue through automated dividend distributions. Governance proposals handle licensing deals and catalog management.

### Agriculture
A farming cooperative registers on-chain and tokenizes a land parcel it owns. Investors fund planting and operations through a fundraising round, then receive returns as dividends when the crop is sold. The secondary market lets investors exit before harvest if needed. The cooperative retains ownership and operational control, with governance proposals handling decisions like crop rotation or equipment purchases.

### Commodities
A mining company registers on-chain and tokenizes gold it holds in audited vaults. Each token represents a fraction of physically owned, 100% backed inventory — no synthetic exposure, no fractional reserves. Investors buy shares during a fundraising round and can redeem or trade them on the secondary market. As the organization sells portions of its holdings, proceeds flow back as dividends. The organization must own the underlying commodity; the protocol does not support unbacked or speculative tokenization.

### Community-Owned Infrastructure
A neighborhood solar farm or co-working space is tokenized. Residents or members buy shares, receive usage-based dividends, and vote on operational decisions — maintenance budgets, expansion plans, pricing changes — through governance proposals.

## Who Is This For?

| Role | What You Get |
|---|---|
| **Organizations & Issuers** | Register on-chain, tokenize assets, run fundraising rounds, distribute dividends — all without custom smart contract development |
| **Investors** | Fractional ownership of real assets, a secondary market for liquidity, and governance rights proportional to your holdings |
| **Developers** | A TypeScript SDK and well-documented instruction set to build apps, dashboards, and integrations on top of the protocol |
| **Regulators & Compliance** | Full on-chain audit trails, emergency recovery for court orders and estate settlements, and governance-gated operations for every critical action |

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

### Sponsored Transactions (External Payer)

Every instruction that creates accounts accepts an independent `payer` account that is fully decoupled from all role accounts (authority, operator, buyer, seller, investor, etc.). The only requirements on the payer are:

1. **Must be a signer** — the payer signs the transaction
2. **Must be writable** — SOL is debited for rent

There is no on-chain check tying the payer to any other role, which means a third-party relayer or sponsor can cover all rent costs on behalf of users. This enables:

- **Gasless UX** — end users interact with the protocol without holding SOL for rent
- **Relayer services** — a backend service co-signs transactions and pays for account creation
- **Fee abstraction** — organizations can subsidize their investors' and token holders' transaction costs

This applies to all account-creating instructions across the protocol: asset initialization, fundraising, secondary market, distributions, governance, buyouts, and emergency recovery. The two exceptions are `cancel_offer` and `reject_offer`, which use the buyer or seller directly as the payer for ATA creation during refund cleanup.

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
| litesvm | ^0.6.0 | Local SVM for tests |
| vitest | ^3.0.0 | Test runner |
| tsup | ^8.0.0 | Bundler |
| biome | ^2.4.4 | Linter/formatter |

## License

MIT
