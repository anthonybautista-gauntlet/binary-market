# Meridian — On-Chain Binary Options Market

Meridian is a fully on-chain binary options protocol for the **MAG7** equities (Apple, Microsoft, NVIDIA, Google, Amazon, Meta, Tesla), deployed on **Base Sepolia** (testnet) and intended for **Base** (mainnet).

Users trade binary YES/NO outcomes on whether a stock closes above a given strike price on a given trading day. Settlement uses real-time Pyth Network oracle data with a Yahoo Finance fallback. All order matching happens on-chain via a Central Limit Order Book (CLOB).

---

## Repository Structure

```
binary-market/
├── contracts/          Foundry project — Solidity contracts, tests, and deployment scripts
├── frontend/           Next.js 15 frontend — trading UI, portfolio, E2E tests
├── market-service/     Node.js automation — market creation, settlement, price pusher
└── context_docs/       Product requirement docs (PRD, Meridian spec)
```

---

## Quick Start

### Contracts

```bash
cd contracts
forge install
forge build
forge test
```

See [contracts/README.md](contracts/README.md) for full deployment instructions.

### Frontend

```bash
cd frontend
npm install
cp .env.example .env.local   # fill in contract addresses + WalletConnect project ID
npm run dev
npm run test:e2e             # in a second terminal, with dev server already running
```

See [frontend/README.md](frontend/README.md) for full setup and testing instructions.

### Market Service

```bash
cd market-service
npm install
cp .env.example .env         # fill in RPC_URL, wallet keys, contract addresses
npm run dev
```

See [market-service/README.md](market-service/README.md) for full environment variable reference and job documentation.

---

## Deployed Contracts (Base Sepolia)

| Contract | Address |
|----------|---------|
| `MeridianMarket` | `0x0793531B3CcE2B833298cFeCAEC63ad5c327302d` |
| `MockUSDC` | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Pyth oracle | `0xA2aa501b19aff244D90cc15a4Cf739D2725B5729` |

---

## How It Works

### Market creation

Each market is a `(ticker, strikePrice, expiryTimestamp)` triple. The `market-service` creates up to 49 markets every trading day morning (7 MAG7 tickers × up to 7 strike bins centered ±9% around the previous close).

### Trading

Users interact via three main entry points:

| Action | Contract function |
|--------|------------------|
| Provide liquidity (both sides) | `mintPair(marketId, quantity)` |
| Buy YES (limit order) | `placeOrder(BID, priceCents, quantity)` |
| Buy NO at market price | `buyNoMarket(marketId, quantity, minProceeds, maxFills)` |
| Buy NO with limit on YES sale | `buyNoLimit(marketId, quantity, limitPrice)` |
| Sell YES | `placeOrder(ASK, priceCents, quantity)` |
| Sell NO | `sellNoMarket(marketId, quantity, maxYesPrice, maxFills)` |

All functions accept a `quantity` parameter so users can mint or trade multiple tokens in a single transaction.

### Settlement

The `market-service` settles markets at **16:05 ET** using a Pyth Hermes price VAA. If Pyth data is unavailable, the `adminSettle` job runs at **16:15 ET** (exactly when `ADMIN_OVERRIDE_DELAY = 900s` expires) using the closing price from Yahoo Finance.

### Redemption

After settlement, winners call `redeem(marketId, quantity)` to burn their winning tokens and receive `$1 × quantity × (1 − feeBps / 10_000)` USDC. Loser tokens have no redemption value.

---

## Architecture Summary

```
┌──────────────────────────────────────────────────────────────────┐
│                         MeridianMarket                           │
│  ERC1155 · AccessControl · Pausable · ReentrancyGuard            │
│                                                                  │
│  ┌────────────────┐   ┌──────────────────┐   ┌────────────────┐  │
│  │  OrderBookLib  │   │    PriceLib      │   │   MockUSDC     │  │
│  │  (CLOB logic)  │   │ (Pyth validation)│   │  (testnet only)│  │
│  └────────────────┘   └──────────────────┘   └────────────────┘  │
│                                                                  │
│  External: IPyth (oracle)  ·  IERC20 (USDC)                     │
└──────────────────────────────────────────────────────────────────┘

         ▲ reads / writes                       ▲ settles
         │                                      │
┌────────────────┐                   ┌──────────────────────┐
│    Frontend    │                   │   market-service     │
│  (Next.js 15)  │                   │   (Node.js cron)     │
│                │                   │                      │
│  Wagmi v2      │                   │  createMarkets job   │
│  Pyth Hermes   │                   │  settleMarkets job   │
│  IndexedDB     │                   │  adminSettle job     │
│  Playwright    │                   │  pricePusher job     │
└────────────────┘                   └──────────────────────┘
```

---

## Events Used by the Frontend

The frontend reconstructs trade history entirely from on-chain events — no indexer is required.

| Event | Contract | Used for |
|-------|----------|---------|
| `OrderFilled(marketId, orderId, maker, taker, side, priceCents, qty)` | `MeridianMarket` | Fill history, avg entry price, realized PnL |
| `PairMinted(marketId, user, quantity)` | `MeridianMarket` | Mint history, cost basis |
| `OrderPlaced(marketId, orderId, owner, side, priceCents, qty)` | `MeridianMarket` | Open orders reconstruction |
| `OrderCancelled(marketId, orderId)` | `MeridianMarket` | Open orders reconstruction |
| `Redeemed(marketId, user, side, quantity, usdcPayout)` | `MeridianMarket` | Realized PnL after settlement |

Events are fetched incrementally using Viem's `getLogs` and cached in **IndexedDB** so only new blocks are fetched on subsequent page loads.

---

## Key Constants

| Constant | Value | Notes |
|----------|-------|-------|
| `ADMIN_OVERRIDE_DELAY` | 900 s (15 min) | Delay before `adminSettleOverride` can be called |
| `MAX_PARSE_WINDOW` | 900 s | Maximum Pyth settlement window width |
| `HARD_MAX_FILLS` | 100 | Max fills per market-order call |
| Collateral per pair | 1 USDC | Fixed; 6 decimals (`1e6` units) |
| Price precision | expo −5 | `$1.00 = 100_000 Pyth units` |
| Order book levels | 99 | 1–99 cents per Yes token |

---

## License

MIT
