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
- **Execution History**: Dedicated `/history` page with wallet history and market-wide activity.
- **Settlement Countdown**: Live countdown timer and status badge (LIVE / SETTLING / SETTLED / EXPIRED).
- **Open Orders Panel**: View and cancel resting limit orders directly from the trading screen, with live owner/remaining checks.
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
| `NEXT_PUBLIC_RPC_URL` | Recommended | Dedicated RPC endpoint for reliable event/log reads |
| `NEXT_PUBLIC_DEPLOYMENT_BLOCK` | Yes | Block number where the current `MeridianMarket` deployment was created |

**Base Sepolia (testnet) values:**
```
NEXT_PUBLIC_MERIDIAN_MARKET_ADDRESS=0x0793531B3CcE2B833298cFeCAEC63ad5c327302d
NEXT_PUBLIC_MOCK_USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
NEXT_PUBLIC_DEPLOYMENT_BLOCK=0
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
| `useOrderBook(marketId)` | Fetches order book depth across all 99 price levels; live updates via events + fallback polling |
| `useTradeHistory()` | Fetches wallet `OrderPlaced`, `OrderCancelled`, `OrderFilled`, `PairMinted`, and `Redeemed` events with IndexedDB caching |
| `useMarketExecutionLog(marketId)` | Fetches market-wide `OrderFilled` activity with incremental cache cursors |

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

The trade panel header always shows:
- USDC balance
- YES token balance for the current market
- NO token balance for the current market

### 4. Position Constraints

The UI enforces the PRD rule that **YES holders cannot buy NO and vice versa**. When `useTokenBalances` detects a conflicting balance, the relevant buy tab displays a `PositionBlock` notice explaining the conflict and directing the user to sell their current position first.

### 5. Company Logos

Ticker logos are loaded from local static assets in `public/images/logos/<TICKER>.png`. The `TickerLogo` component falls back to the first letter of the ticker symbol if the image fails to load.

Logo metadata is configured per ticker in `src/constants/assets.ts`.

### 6. Portfolio & PnL

The portfolio and history pages reconstruct wallet activity from on-chain events without an indexer:

1. `useTradeHistory` queries the RPC for `OrderPlaced`, `OrderCancelled`, `OrderFilled`, `PairMinted`, and `Redeemed` events using Viem's `getLogs`.
2. Events are cached in **IndexedDB** (`meridian-<marketAddress>-<deploymentBlock>` database) keyed by wallet address + chain ID. This deployment-aware namespace prevents old/new contract history from mixing after redeploys.
3. `computeMarketPnL` aggregates the event stream to produce per-market `avgEntryPriceCents`, `totalCostUsdc`, `realizedPnlUsdc`, and `fillCount`.
4. The portfolio table shows: Balance, Exposure, Avg Entry Price, Current Value (Pyth × balance), Unrealized P&L, Realized P&L, and Fill Count.

A hidden **"Rebuild Local History Cache"** troubleshooting action clears the wallet cache and reconstructs from chain logs. Daily usage should rely on normal incremental sync.

> **Note on `OrderFilled` availability**: The `OrderFilled` event was added to `MeridianMarket` as part of this frontend upgrade. Fill-based PnL is only available from the block of the new contract deployment forward. Markets traded under the old contract show realized PnL from `Redeemed` events only.

### 7. IndexedDB Caching

Trade and activity caching uses the `idb` package with four object stores:

| Store | Key | Purpose |
|-------|-----|---------|
| `tradeEvents` | `[userAddress, chainId, txHash, logIndex]` | Wallet history events: `OrderPlaced`, `OrderCancelled`, `OrderFilled`, `PairMinted`, `Redeemed` |
| `cursors` | `[userAddress, chainId]` | Last block number fetched per wallet/chain combination |
| `marketExecutionEvents` | `[chainId, marketId, txHash, logIndex]` | Market-wide `OrderFilled` activity events |
| `marketExecutionCursors` | `[chainId, marketId]` | Last block number fetched per market/chain combination |

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

`OpenOrders` uses event reconstruction plus on-chain verification:

1. Reconstructs live orders from wallet `OrderPlaced`, `OrderFilled`, and `OrderCancelled` events for the selected market.
2. Applies `OrderCancelled(marketId, ...)` as the authoritative remove signal for that market.
3. Uses `orderOwner(orderId)` as a secondary self-heal fallback against rare RPC/event lag.
4. Renders only currently live orders with accurate remaining size, with a **Cancel** button calling `cancelOrder(orderId)`.

### 10. On-Chain Order Book

The order book uses a hybrid approach:
- **Initial load**: Reads `depthAt` for all 99 price levels (1–99 cents) in a single batched `readContracts` call.
- **Event-driven updates**: `useWatchContractEvent` listens for `OrderPlaced`, `OrderFilled`, and `OrderCancelled`.
- **Fallback polling**: conservative interval polling is enabled (visible tab only) to recover from missed/delayed event subscriptions on public RPC endpoints.

---

## Directory Structure

```
src/
├── app/
│   ├── layout.tsx              Root layout with Providers
│   ├── page.tsx                Landing page — MAG7 asset grid + prices
│   ├── markets/page.tsx        Market listing grid with status badges
│   ├── market/[id]/page.tsx    Market detail: TradingView chart, TradePanel, OpenOrders, MarketActivity
│   ├── portfolio/page.tsx      Portfolio: holdings, PnL, wallet history
│   ├── history/page.tsx        Dedicated history route (wallet + market activity)
│   └── ticker/[ticker]/        TradingView chart embed per ticker
│
├── components/
│   ├── Navbar.tsx              Top navigation with wallet connect
│   ├── TradePanel.tsx          6-tab order entry form (all order types)
│   ├── OrderBook.tsx           CLOB depth display with live updates
│   ├── OpenOrders.tsx          User's resting limit orders with cancel
│   ├── MarketActivity.tsx      Market-wide fill log with All/My filter
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
│   ├── useTradeHistory.ts      Wallet history fetching + IndexedDB cache + PnL computation
│   └── useMarketExecutionLog.ts Market-wide fill log hook (incremental cache)
│
├── lib/
│   ├── abi/                    MeridianMarket.json, MockUSDC.json
│   ├── tradeCache.ts           IndexedDB schemas/cursors for wallet history + market activity
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

When `MeridianMarket.sol` is redeployed (e.g. event signature changes), regenerate the frontend ABI:

```bash
cd ../contracts
forge build
cp out/MeridianMarket.sol/MeridianMarket.json ../frontend/src/lib/abi/MeridianMarket.json
```

The ABI is imported directly from `src/lib/abi/` — no code generation step is needed.

After redeploy, update `.env.local` with the new `NEXT_PUBLIC_MERIDIAN_MARKET_ADDRESS` and `NEXT_PUBLIC_DEPLOYMENT_BLOCK` before rebuilding.

### Redeploy rollout checklist

1. Copy the new `MeridianMarket` ABI into `src/lib/abi/MeridianMarket.json`.
2. Update `NEXT_PUBLIC_MERIDIAN_MARKET_ADDRESS` and `NEXT_PUBLIC_DEPLOYMENT_BLOCK`.
3. Rebuild/redeploy the frontend.
4. Confirm cancel flow on the new contract:
   - place order on `/market/[id]`
   - cancel order
   - verify cancel appears in `/history` and open order disappears on `/market/[id]`
5. Use **Troubleshoot history sync -> Rebuild Local History Cache** only if local browser cache appears stale.

---

## License

MIT
