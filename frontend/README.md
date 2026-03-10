# Meridian: On-Chain Binary Options Market — Frontend

Meridian is a premium, non-custodial binary options trading platform built on **Base Sepolia** (testnet) and **Base** (mainnet). It allows users to trade binary options on the **MAG7** (Apple, Microsoft, NVIDIA, Google, Amazon, Meta, Tesla) with sub-second Pyth price feeds and fully on-chain settlement.

## Key Features

- **Real-Time Trading**: Sub-second price feeds via Pyth Hermes API.
- **On-Chain CLOB**: Fully decentralized Central Limit Order Book with 6 order types.
- **MAG7 Focus**: Specialized markets for the world's most traded tech equities.
- **Company Logos**: Local PNG logos with automatic first-letter fallback.
- **Visual Analytics**: Integrated TradingView charts for every supported asset.
- **Non-Custodial**: Users maintain full control of their funds at all times.
- **USDC Balance & Allowance**: Always visible on every trading screen.
- **Position Constraints**: Enforced in the UI — YES holders cannot buy NO and vice versa.
- **Portfolio & PnL**: Full trade history reconstructed from on-chain events with IndexedDB caching.
- **Settlement Countdown**: Live countdown timer and status badge (LIVE / SETTLING / SETTLED / EXPIRED).
- **Open Orders Panel**: View and cancel resting limit orders directly from the trading screen.
- **E2E Tested**: Playwright test suite covering all critical user flows.

## Tech Stack

| Layer | Library |
|-------|---------|
| Framework | [Next.js 15](https://nextjs.org/) (App Router) |
| Web3 | [Wagmi v2](https://wagmi.sh/), [Viem](https://viem.sh/), [RainbowKit](https://www.rainbowkit.com/) |
| Styling | [TailwindCSS v4](https://tailwindcss.com/), [shadcn/ui](https://ui.shadcn.com/) |
| Oracle | [Pyth Network](https://pyth.network/) (Hermes API) |
| State | [Zustand](https://docs.pmnd.rs/zustand/), [@tanstack/react-query](https://tanstack.com/query) |
| Storage | [IndexedDB via `idb`](https://github.com/jakearchibald/idb) |
| Charting | [TradingView Widget](https://www.tradingview.com/widget/) |
| Testing | [Playwright](https://playwright.dev/) |

---

## Getting Started

### Prerequisites

- Node.js 20+
- npm 9+
- A [WalletConnect Cloud](https://cloud.walletconnect.com) project ID

### Local Setup

```bash
# 1. Install dependencies
cd binary-market/frontend
npm install

# 2. Configure environment variables
cp .env.example .env.local
# Edit .env.local — see Environment Variables section below

# 3. Run the development server
npm run dev

# 4. Build for production
npm run build
npm start
```

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_MERIDIAN_MARKET_ADDRESS` | Yes | Deployed `MeridianMarket` contract address |
| `NEXT_PUBLIC_MOCK_USDC_ADDRESS` | Yes | `MockUSDC` (testnet) or real USDC (mainnet) address |
| `NEXT_PUBLIC_WC_PROJECT_ID` | Yes | WalletConnect Cloud project ID |

**Base Sepolia (testnet) values:**
```
NEXT_PUBLIC_MERIDIAN_MARKET_ADDRESS=0x0793531B3CcE2B833298cFeCAEC63ad5c327302d
NEXT_PUBLIC_MOCK_USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
```

---

## Technical Architecture

### 1. Smart Contract Interactions

All ABIs are stored in `src/lib/abi/`. Contract addresses are read from environment variables set at build time.

| Hook | Description |
|------|-------------|
| `useMeridianMarket` | Fetches market count and recent markets via `getMarkets` |
| `useMarket(marketId)` | Retrieves full state for a single market (strike, expiry, settlement) |
| `useMockUSDC` | Handles testnet USDC minting and ERC20 approval |
| `useUSDCData` | Batches `balanceOf` + `allowance` for the connected wallet via `useReadContracts` |
| `useTokenBalances(marketId)` | Batches ERC1155 YES/NO `balanceOf` calls and `isApprovedForAll` status |
| `useOrderBook(marketId)` | Fetches order book depth across all 99 price levels; live updates via `useWatchContractEvent` |
| `useTradeHistory(marketId?)` | Fetches `OrderFilled`, `PairMinted`, and `Redeemed` events with IndexedDB caching |

### 2. Live Price Data

Real-time equity prices are fetched from the **Pyth Hermes REST API** every 2 seconds (configurable).

```
GET https://hermes.pyth.network/v2/updates/price/latest?ids[]=<feedId>&ids[]=...
```

Prices use Pyth's native `int64` representation at exponent `-5`: `$215.00 = 21_500_000`.

### 3. Trade Panel — All 6 Order Types

The `TradePanel` component exposes every contract entry point as a dedicated tab:

| Tab | Contract call | Collateral locked |
|-----|---------------|-------------------|
| Buy YES (Limit) | `placeOrder(BID, priceCents, qty)` | `qty × priceCents × 1e4` USDC |
| Buy NO (Market) | `buyNoMarket(marketId, qty, minProceeds, maxFills)` | `qty × 1e6` USDC |
| Buy NO (Limit) | `buyNoLimit(marketId, qty, limitYesSalePrice)` | `qty × 1e6` USDC |
| Sell YES | `placeOrder(ASK, priceCents, qty)` | `qty` YES tokens |
| Sell NO | `sellNoMarket(marketId, qty, maxYesPrice, maxFills)` | `qty × maxYesPrice × 1e4` USDC |
| Mint Pair | `mintPair(marketId, qty)` | `qty × 1e6` USDC |

All tabs accept a `quantity` parameter so users can mint or trade multiple tokens in a single transaction. ERC20 approval (`approve`) and ERC1155 approval (`setApprovalForAll`) are handled automatically before the first trade.

### 4. Position Constraints

The UI enforces the PRD rule that **YES holders cannot buy NO and vice versa**. When `useTokenBalances` detects a conflicting balance, the relevant buy tab displays a `PositionBlock` notice explaining the conflict and directing the user to sell their current position first.

### 5. Company Logos

Ticker logos are loaded from local static assets in `public/images/logos/<TICKER>.png`. The `TickerLogo` component falls back to the first letter of the ticker symbol if the image fails to load.

Logo metadata is configured per ticker in `src/constants/assets.ts`.

### 6. Portfolio & PnL

The portfolio page reconstructs full trade history from on-chain events without an indexer:

1. `useTradeHistory` queries the RPC for `OrderFilled`, `PairMinted`, and `Redeemed` events using Viem's `getLogs`.
2. Events are cached in **IndexedDB** (`meridian` database, `tradeEvents` store) keyed by wallet address + chain ID. Only blocks since the last fetch are requested on subsequent visits, making incremental updates cheap.
3. `computeMarketPnL` aggregates the event stream to produce per-market `avgEntryPriceCents`, `totalCostUsdc`, `realizedPnlUsdc`, and `fillCount`.
4. The portfolio table shows: Balance, Exposure, Avg Entry Price, Current Value (Pyth × balance), Unrealized P&L, Realized P&L, and Fill Count.

A **"Sync History"** button allows manual re-fetch of the incremental event window.

> **Note on `OrderFilled` availability**: The `OrderFilled` event was added to `MeridianMarket` as part of this frontend upgrade. Fill-based PnL is only available from the block of the new contract deployment forward. Markets traded under the old contract show realized PnL from `Redeemed` events only.

### 7. IndexedDB Caching

Trade history caching uses the `idb` package with two object stores:

| Store | Key | Purpose |
|-------|-----|---------|
| `tradeEvents` | `[userAddress, chainId, txHash, logIndex]` | Every `OrderFilled`, `PairMinted`, and `Redeemed` event |
| `cursors` | `[userAddress, chainId]` | Last block number fetched per wallet/chain combination |

This design means the first load fetches all historical events (can be slow on mainnet with many transactions), but every subsequent load fetches only new events from `lastBlock + 1` to the current head.

### 8. Settlement Countdown & Status Badges

`SettlementCountdown` determines market status from `expiryTimestamp` vs. `Date.now()`:

| Status | Condition |
|--------|-----------|
| LIVE | `now < expiryTimestamp` |
| SETTLING | `now >= expiryTimestamp && now < expiryTimestamp + 15min` |
| SETTLED | `market.settled == true` |
| EXPIRED | `now >= expiryTimestamp + 15min && !settled` (admin override window) |

The same logic is exported as `MarketStatusBadge` for use in the market listing grid.

### 9. Open Orders Panel

`OpenOrders` queries `OrderPlaced` and `OrderCancelled` event logs for the connected wallet, reconstructs the set of live resting orders, and renders them with a **Cancel** button per order. Cancellation calls `cancelOrder(orderId)` on the contract.

### 10. On-Chain Order Book

The order book uses a hybrid approach:
- **Initial load**: Reads `depthAt` for all 99 price levels (1–99 cents) in a single batched `readContracts` call.
- **Live updates**: `useWatchContractEvent` listens for `OrderPlaced` and `OrderCancelled` events and applies targeted Zustand store updates to the affected price level without re-fetching the whole book.

---

## Directory Structure

```
src/
├── app/
│   ├── layout.tsx              Root layout with Providers
│   ├── page.tsx                Landing page — MAG7 asset grid + prices
│   ├── markets/page.tsx        Market listing grid with status badges
│   ├── market/[id]/page.tsx    Market detail: TradingView chart, TradePanel, OpenOrders
│   ├── portfolio/page.tsx      Portfolio: holdings, PnL, trade history
│   └── ticker/[ticker]/        TradingView chart embed per ticker
│
├── components/
│   ├── Navbar.tsx              Top navigation with wallet connect
│   ├── TradePanel.tsx          6-tab order entry form (all order types)
│   ├── OrderBook.tsx           CLOB depth display with live updates
│   ├── OpenOrders.tsx          User's resting limit orders with cancel
│   ├── SettlementCountdown.tsx Countdown timer + MarketStatusBadge
│   ├── TickerLogo.tsx          Local logo image with first-letter fallback
│   ├── RedeemButton.tsx        Post-settlement redemption button
│   └── Providers.tsx           WagmiProvider + QueryClientProvider + RainbowKit
│
├── hooks/
│   ├── useContracts.ts         useMeridianMarket, useMarket, useMockUSDC
│   ├── useOrderBook.ts         CLOB depth + live event subscriptions
│   ├── usePythPrices.ts        Hermes polling hook (2s interval)
│   ├── useUSDCData.ts          USDC balance + allowance for connected wallet
│   ├── useTokenBalances.ts     ERC1155 YES/NO balances + isApprovedForAll
│   └── useTradeHistory.ts      Event log fetching + IndexedDB cache + PnL computation
│
├── lib/
│   ├── abi/                    MeridianMarket.json, MockUSDC.json
│   ├── tradeCache.ts           IndexedDB schema and CRUD helpers (idb)
│   ├── wagmi.ts                Wagmi config (RainbowKit getDefaultConfig)
│   └── utils.ts                Tailwind class merging (cn)
│
├── constants/
│   └── assets.ts               PYTH_FEED_IDS, ASSET_META (logoUrl, domain), ASSETS array
│
└── store/
    └── orderBookStore.ts        Zustand store for CLOB depth state
```

---

## E2E Testing with Playwright

Tests live in `e2e/` and use a **hybrid mocking strategy** designed to satisfy the PRD's required frontend coverage while staying deterministic in CI and local development.

### Strategy overview

| Layer | How it's mocked |
|-------|----------------|
| Pyth Hermes API | `page.route('**/hermes.pyth.network/**')` returns fixture prices |
| Blockchain RPC | `page.route('**')` intercepts JSON-RPC calls (`eth_call`, receipts, logs, etc.) with fixture responses |
| Wallet / account | `page.addInitScript` injects an EIP-1193 mock provider before page load |
| Real browser ext. | Never used — the mock provider handles all wallet interactions |

This approach means tests run entirely offline with no chain connection required.

### Why not a real wallet extension?

Browser extension wallets (MetaMask) cannot be automated reliably in headless Playwright. The injected mock provider plus a UI-driven RainbowKit connection flow gives us coverage for wallet-gated UX without relying on an actual browser extension popup.

### What the suite covers

The current suite is aligned to the PRD's required frontend test areas:

- Wallet connection flow
- Order placement and transaction signing
- Real-time oracle price display
- Order book rendering
- Position constraint enforcement
- Portfolio and P&L display
- Settlement display and redeem flow
- Markets filtering added during frontend polish

### Running tests

```bash
# Start the dev server in one terminal
npm run dev

# In another terminal
npm run test:e2e                  # headless, all tests
npm run test:e2e:headed           # with browser window visible
npm run test:e2e:ui               # Playwright interactive UI mode
npm run test:e2e:report           # open HTML report from last run
```

Playwright does **not** start `next dev` for you. This is intentional: manually running the frontend server avoids the Next.js lock conflicts and port ambiguity that occur when two dev-server processes compete for the same `.next` state.

### Test files

| File | What it covers |
|------|---------------|
| `e2e/landing.spec.ts` | Landing page oracle price display and logo rendering |
| `e2e/markets.spec.ts` | Markets page ticker and settled/live filtering |
| `e2e/trade.spec.ts` | Trade panel actions, order book rendering, transaction signing flow, position constraints, quantity inputs |
| `e2e/portfolio.spec.ts` | Portfolio balance, PnL reconstruction, settlement display, redeem flow |
| `e2e/wallet.spec.ts` | Wallet connection modal and injected-wallet connection flow |

### Mock helpers

| File | Purpose |
|------|---------|
| `e2e/helpers/mockPyth.ts` | Intercepts `hermes.pyth.network` requests |
| `e2e/helpers/mockRpc.ts` | Intercepts JSON-RPC calls with configurable balances, depth, logs, and tx receipts |
| `e2e/helpers/mockWallet.ts` | `addInitScript` EIP-1193 provider with configurable address |
| `e2e/helpers/connectWallet.ts` | Drives the real RainbowKit modal using the injected provider |
| `e2e/helpers/eventLogs.ts` | Builds realistic event-log fixtures for PnL and redeem tests |
| `e2e/fixtures.ts` | All fixture data: prices, market structs, ABI-encoded return values |

### CI configuration

`playwright.config.ts` enables:
- `retries: 2` on CI for flaky network-dependent tests
- `workers: 1` on CI to avoid port conflicts
- `trace: 'on-first-retry'` for post-mortem debugging
- Screenshots on failure

By default the suite targets `http://localhost:3000`. Set `PLAYWRIGHT_BASE_URL` to point at a different running deployment instead of the local dev server.

---

## Updating ABIs

When `MeridianMarket.sol` is redeployed (e.g. after adding `OrderFilled` event), regenerate the frontend ABI:

```bash
cd ../contracts
forge build
cp out/MeridianMarket.sol/MeridianMarket.json ../frontend/src/lib/abi/MeridianMarket.json
```

The ABI is imported directly from `src/lib/abi/` — no code generation step is needed.

---

## License

MIT
