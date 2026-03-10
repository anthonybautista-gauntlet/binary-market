# Meridian — On-Chain Binary Options Market

Meridian is a fully on-chain binary options protocol for the **MAG7** equities (Apple, Microsoft, NVIDIA, Google, Amazon, Meta, Tesla), deployed on **Base Sepolia** (testnet) and intended for **Base** (mainnet).

Users trade binary YES/NO outcomes on whether a stock closes above a given strike price on a given trading day. Settlement uses real-time Pyth Network oracle data with a Yahoo Finance fallback. All order matching happens on-chain via a Central Limit Order Book (CLOB).

---

## Repository Structure

```
binary-market/
├── contracts/          Foundry project — Solidity contracts, tests, deployment scripts
├── frontend/           Next.js 15 frontend — trading UI, portfolio
├── market-service/     Node.js automation — market creation, settlement, price pusher
├── maker-bots/         Node.js bots — automated market making and directional buying
└── context_docs/       Product requirement docs (PRD, Meridian spec)
```

---

## Packages at a Glance

### `contracts/`

The core Solidity protocol. A single `MeridianMarket` contract owns all markets, ERC1155 tokens, USDC vaults, and order books. No proxy pattern — deliberately immutable after deployment.

Key components:
- **`MeridianMarket.sol`** — market creation, minting, CLOB order placement, Pyth-based settlement, admin override settlement, redemption
- **`OrderBookLib.sol`** — on-chain CLOB with 99 price levels, FIFO price-time priority, up to 100 fills per call
- **`PriceLib.sol`** — Pyth price validation (exponent, confidence band) and strike comparison
- **`MockUSDC.sol`** — free-mint ERC20 for testnet collateral

See [contracts/README.md](contracts/README.md) for full architecture, test suite, and deployment instructions.

---

### `market-service/`

Long-running Node.js service that automates all protocol lifecycle operations. Runs four cron jobs:

| Job | Schedule (ET) | Purpose |
|-----|--------------|---------|
| `createMarkets` | 08:00 Mon–Fri | Fetches live MAG7 prices via Pyth Hermes (Yahoo Finance fallback), computes 7 strike bins per ticker, and creates up to 49 markets on-chain |
| `settleMarkets` | 16:05 Mon–Fri | Fetches settlement price VAA from Hermes and calls `settleMarket` for all expired markets |
| `adminSettle` | 16:15 Mon–Fri | Fallback for markets Hermes couldn't settle — uses Yahoo Finance closing prices and calls `adminSettleOverride` |
| `pricePusher` | Hourly (testnet only) | Pushes fresh Hermes VAA bytes to the on-chain Pyth oracle to keep testnet prices current |

The service also runs `createMarkets`, `settleMarkets`, and `adminSettle` on startup as catch-up jobs, so restarting mid-day never results in missed markets or unsettled positions.

See [market-service/README.md](market-service/README.md) for environment variables, job details, and troubleshooting.

---

### `maker-bots/`

Two automated bots that run in a single Node.js process:

| Bot | Schedule | Role |
|-----|----------|------|
| **Maker Bot** | Every 5 min | Posts two-sided YES BID + ASK quotes around a sigmoid fair value. Cancels and re-quotes every cycle. Accumulates NO tokens as a byproduct. |
| **Buyer Bot** | Every 30 min | Buys NO tokens in in-the-money markets (current price > strike) by calling `buyNoMarket`. Only acts when the BID side has sufficient depth. |

The maker's fair value uses a time-weighted sigmoid: conviction sharpens toward 0 or 100 as the session approaches close, mimicking real binary option time decay.

See [maker-bots/README.md](maker-bots/README.md) for the pricing model, environment variables, and gas limit rationale.

---

### `frontend/`

Next.js 15 trading UI. Reads all state directly from on-chain events — no indexer required. Uses Viem's `getLogs` with incremental IndexedDB caching so only new blocks are fetched on each page load.

Key pages:
- `/` — market overview across all 7 MAG7 tickers
- `/ticker/[symbol]` — active markets for a single ticker
- `/ticker/[symbol]/[marketId]` — individual market trading view (order book, buy/sell panel, history)

See [frontend/README.md](frontend/README.md) for setup and WalletConnect configuration.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                         MeridianMarket                               │
│  ERC1155 · AccessControl · Pausable · ReentrancyGuard                │
│                                                                      │
│  ┌────────────────┐   ┌──────────────────┐   ┌────────────────────┐  │
│  │  OrderBookLib  │   │    PriceLib      │   │     MockUSDC       │  │
│  │  (CLOB logic)  │   │ (Pyth validation)│   │  (testnet only)    │  │
│  └────────────────┘   └──────────────────┘   └────────────────────┘  │
│  External: IPyth (oracle)  ·  IERC20 (USDC)                          │
└──────────────────────────────────────────────────────────────────────┘
           ▲ reads/writes                 ▲ creates/settles   ▲ quotes/buys
           │                             │                    │
  ┌────────────────┐     ┌───────────────────────┐   ┌──────────────────┐
  │    Frontend    │     │   market-service      │   │   maker-bots     │
  │  (Next.js 15)  │     │   (Node.js cron)      │   │ (Node.js cron)   │
  │                │     │                       │   │                  │
  │  Wagmi v2      │     │  createMarkets job    │   │  makerBot        │
  │  Pyth Hermes   │     │  settleMarkets job    │   │  buyerBot        │
  │  Viem getLogs  │     │  adminSettle job      │   │  Pyth Hermes     │
  │  IndexedDB     │     │  pricePusher job      │   │  Ethers.js v6    │
  └────────────────┘     └───────────────────────┘   └──────────────────┘
         │                        │                           │
         └────────────────────────┴───────────────────────────┘
                          Base Sepolia / Base
```

---

## Deployed Contracts (Base Sepolia)

| Contract | Address |
|----------|---------|
| `MeridianMarket` | `0xB25ad0cB6F7555625C3b423928D216e1BF3D4Aa6` |
| `MockUSDC` | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Pyth oracle | `0xA2aa501b19aff244D90cc15a4Cf739D2725B5729` |

---

## Local Development — Full Deployment Order

To run the entire stack locally against Base Sepolia testnet, follow these steps in order. Each step depends on the previous one having succeeded.

### Prerequisites

- [Foundry](https://book.getfoundry.sh/getting-started/installation) (for contracts)
- Node.js 20+
- ETH on Base Sepolia for gas (use the [Base faucet](https://www.coinbase.com/faucets/base-ethereum-goerli-faucet))

---

### Step 1 — Contracts

```bash
cd contracts
forge install        # Install Solidity dependencies (first time only)
forge build          # Compile — output goes to contracts/out/
forge test           # Run the full test suite (200 tests)
```

For deployment to Base Sepolia, see [contracts/README.md → Deployment](contracts/README.md#deployment). You will need:
- A deployer wallet private key with ETH on Base Sepolia
- The Pyth oracle address for Base Sepolia: `0xA2aa501b19aff244D90cc15a4Cf739D2725B5729`

After deploying, note your `MeridianMarket` and `MockUSDC` addresses — every other service needs them.

After any contract redeployment, regenerate the ABIs used by the other services:

```bash
cd contracts
forge build
cp out/MeridianMarket.sol/MeridianMarket.json ../market-service/src/abi/MeridianMarket.json
cp out/MeridianMarket.sol/MeridianMarket.json ../maker-bots/src/abi/MeridianMarket.json
cp out/MockPyth.sol/MockPyth.json ../market-service/src/abi/MockPyth.json
```

---

### Step 2 — market-service

The market service must start before the maker bots so that markets exist on-chain for the bots to quote.

```bash
cd market-service
npm install
cp .env.example .env
# Fill in: RPC_URL, MARKET_ADDRESS, PYTH_ADDRESS, OPERATOR_PK, SETTLER_PK, ADMIN_PK
# Set IS_TESTNET=true for Base Sepolia to enable the hourly pricePusher job

npm run dev
```

On startup the service will immediately run `createMarkets` if today is a trading day and the time is before market close. Watch the logs for `=== createMarkets job completed ===` before starting the bots.

See [market-service/README.md](market-service/README.md) for the full environment variable reference and role-granting instructions.

---

### Step 3 — maker-bots

Once markets exist on-chain, start the bots to provide liquidity.

```bash
cd maker-bots
npm install
cp .env.example .env
# Fill in: RPC_URL, MARKET_ADDRESS, USDC_ADDRESS, MAKER_PK, BUYER_PK
# MAKER_PK and BUYER_PK are separate wallets — each needs ETH for gas

npm run dev
```

The maker will begin quoting within the first 5-minute cron cycle. The buyer bot runs every 30 minutes and will only act when there are ITM markets with sufficient BID depth.

See [maker-bots/README.md](maker-bots/README.md) for the pricing model, tuning parameters, and gas limit details.

---

### Step 4 — frontend

```bash
cd frontend
npm install
cp .env.example .env.local
# Fill in: NEXT_PUBLIC_MARKET_ADDRESS, NEXT_PUBLIC_USDC_ADDRESS,
#          NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID, NEXT_PUBLIC_CHAIN_ID

npm run dev          # Starts at http://localhost:3000
```

See [frontend/README.md](frontend/README.md) for WalletConnect setup and full environment variable reference.

---

## How It Works

### Market creation

Each market is a `(ticker, strikePrice, expiryTimestamp)` triple. The `market-service` creates up to 49 markets every trading day morning (7 MAG7 tickers × up to 7 strike bins centered ±9% around the current live price). Strikes are rounded to the nearest $10 and deduplicated.

### Trading

| Action | Contract function |
|--------|------------------|
| Provide liquidity (both sides) | `mintPair(marketId, quantity)` |
| Buy YES (limit order) | `placeOrder(BID, priceCents, quantity)` |
| Sell YES | `placeOrder(ASK, priceCents, quantity)` |
| Buy NO at market | `buyNoMarket(marketId, quantity, minProceeds, maxFills)` |
| Buy NO with resting YES sell | `buyNoLimit(marketId, quantity, limitPrice)` |
| Sell NO (exit position) | `sellNoMarket(marketId, noAmount, maxYesPrice, maxFills)` |

### Settlement

The `market-service` settles markets at **16:05 ET** using a Pyth Hermes price VAA. If Pyth data is unavailable, the `adminSettle` job runs at **16:15 ET** using closing prices from Yahoo Finance.

### Redemption

After settlement, winners call `redeem(marketId, quantity)` to burn their winning tokens and receive `$1 × quantity × (1 − feeBps / 10,000)` USDC. Loser tokens have no redemption value.

---

## Key Constants

| Constant | Value | Notes |
|----------|-------|-------|
| `ADMIN_OVERRIDE_DELAY` | 900 s | Delay before `adminSettleOverride` can be called |
| `MAX_PARSE_WINDOW` | 900 s | Maximum Pyth settlement window width |
| `HARD_MAX_FILLS` | 100 | Max fills per market-order call |
| Collateral per pair | 1 USDC | Fixed; 6 decimals (`1e6` units) |
| Price precision | expo −5 | `$1.00 = 100,000 Pyth units` |
| Order book levels | 99 | 1–99 cents per Yes token |

---

## Events Used by the Frontend

The frontend reconstructs trade history entirely from on-chain events — no indexer is required.

| Event | Used for |
|-------|---------|
| `OrderFilled(marketId, orderId, maker, taker, side, priceCents, qty)` | Fill history, avg entry price, realized PnL |
| `PairMinted(marketId, user, quantity)` | Mint history, cost basis |
| `OrderPlaced(marketId, orderId, owner, side, priceCents, qty)` | Open orders reconstruction |
| `OrderCancelled(marketId, orderId)` | Open orders reconstruction |
| `Redeemed(marketId, user, side, quantity, usdcPayout)` | Realized PnL after settlement |

Events are fetched incrementally using Viem's `getLogs` and cached in **IndexedDB** so only new blocks are fetched on subsequent page loads.

---

## License

MIT
