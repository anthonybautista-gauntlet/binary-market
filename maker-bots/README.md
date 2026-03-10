# Meridian Maker Bots

Automated market-making and directional trading bots for the Meridian binary-outcome market protocol.

Two bots run side-by-side in a single process on independent cron schedules:

| Bot | Role | Default cadence |
|-----|------|-----------------|
| **Maker Bot** | Posts two-sided YES BID + ASK quotes around a dynamic fair value | Every 5 minutes |
| **Buyer Bot** | Buys NO tokens in markets where the current price is above the strike | Every 30 minutes |

---

## Quick Start

### Prerequisites

- Node.js 20+
- ETH in both bot wallets for gas fees
- The contracts must already be deployed (see `contracts/` README)

### Local development

```bash
cd maker-bots
cp .env.example .env
# Edit .env with your RPC_URL, MARKET_ADDRESS, USDC_ADDRESS, MAKER_PK, BUYER_PK

npm install
npm run dev        # tsx watch — reloads on file changes
```

### Production (Docker Compose)

```bash
cd maker-bots
cp .env.example .env
# Edit .env with production values

docker compose up -d
docker compose logs -f
```

### Railway deployment

1. Create a new Railway project and connect your repository.
2. Set the **Root Directory** to `maker-bots/`.
3. Railway auto-detects the `Dockerfile` and builds from it.
4. Add all environment variables from `.env.example` in the Railway **Variables** panel.
5. Deploy — no port configuration needed (the service has no HTTP server).

---

## How It Works

### Maker Bot (`src/bots/makerBot.ts`)

The maker provides continuous two-sided liquidity. On every cycle:

1. **Cancel stale orders** — calls `bulkCancelOrders` to wipe the previous cycle's resting BID and ASK. Already-filled orders are silently skipped by the contract.
2. **Fetch prices** — reads current asset prices from Pyth Hermes.
3. **Compute fair value** — uses the sigmoid pricing model (see below).
4. **Skip extreme markets** — does not quote markets where the fair value is below `MAKER_MIN_FAIR_VALUE` (5¢) or above `MAKER_MAX_FAIR_VALUE` (95¢), as outcomes are nearly certain.
5. **Mint pairs** — calls `mintPair(marketId, MAKER_QUANTITY)` to create fresh YES + NO tokens.
6. **Post ASK** — `placeOrder(ASK, askPrice, quantity)` — resting YES sell at `fairValue + MAKER_HALF_SPREAD`.
7. **Post BID** — `placeOrder(BID, bidPrice, quantity)` — resting USDC buy at `fairValue - MAKER_HALF_SPREAD`.
8. **Save order IDs** — stores `{ askOrderId, bidOrderId }` per market for the next cancel cycle.

The maker accumulates NO tokens as a byproduct of each `mintPair` call (since the BID order locks USDC, not NO tokens). These NO tokens pay out $1 each if YES loses at settlement.

### Buyer Bot (`src/bots/buyerBot.ts`)

The buyer takes directional positions in in-the-money markets. On every cycle:

1. **Filter ITM markets** — only acts when `currentPrice > strikePrice` (YES is likely to win).
2. **Depth guard** — reads `bestBid` and `depthAt` on-chain. Skips markets where:
   - The BID side is empty (`bestBid == 0`).
   - Total BID depth is below `BUYER_MIN_BID_DEPTH`.
3. **Quantity cap** — limits the purchase to `min(BUYER_QUANTITY, depth - BUYER_RESERVE_DEPTH)`, always leaving `BUYER_RESERVE_DEPTH` units of the maker's BID untouched.
4. **Execute** — calls `buyNoMarket(marketId, qty, minProceeds, maxFills)`, which atomically mints pairs, sells all YES at market price (filling the maker's BIDs), and keeps the NO tokens.

The buyer accumulates NO tokens that pay out $1 each if YES **loses** (i.e. price falls below strike by settlement).

---

## Pricing Model

The fair value of the YES outcome is computed using a sigmoid function:

```
x           = (currentPrice - strikePrice) / strikePrice
hoursLeft   = max(0, expiryTimestamp - now()) / 3600
timeWeight  = 1 + max(0, 1 - hoursLeft / MAKER_HOURS_TOTAL)
fairValue   = 50 + tanh(x × timeWeight × MAKER_SENSITIVITY) × 50
```

### Intuition

- When `currentPrice == strikePrice`, `x = 0` and `fairValue = 50¢` (perfectly at-the-money).
- When the price is above the strike (`x > 0`), YES has a higher probability of winning → `fairValue > 50`.
- When the price is below the strike (`x < 0`), YES has a lower probability → `fairValue < 50`.
- `timeWeight` ranges from 1.0 (session open, maximum uncertainty) to 2.0 (at expiry, maximum certainty). This means quotes sharpen toward 0 or 100 as the session ends — mimicking real binary option time decay.

### Example scenarios

| Asset vs. Strike | Hours left | Fair value | BID (spread=5) | ASK (spread=5) |
|-----------------|------------|------------|----------------|----------------|
| +7.5% ITM | 4h | ~65¢ | 60¢ | 70¢ |
| +7.5% ITM | 1h | ~72¢ | 67¢ | 77¢ |
| ATM (0%) | 4h | 50¢ | 45¢ | 55¢ |
| -5% OTM | 4h | ~38¢ | 33¢ | 43¢ |
| +15% ITM | 30min | ~92¢ | skipped (> MAX_FAIR_VALUE=95)* |

*\*Above `MAKER_MAX_FAIR_VALUE`, the maker stops quoting to avoid adverse selection.*

### Tuning

| Variable | Effect |
|----------|--------|
| `MAKER_SENSITIVITY` ↑ | Fair value reacts more strongly to small price movements |
| `MAKER_HALF_SPREAD` ↑ | Wider spread = less fill risk, more edge per trade |
| `MAKER_HOURS_TOTAL` ↑ | Time weight grows more slowly (more gradual conviction) |
| `MAKER_MIN/MAX_FAIR_VALUE` | Widens/narrows the band of markets the maker will quote |

---

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `RPC_URL` | JSON-RPC endpoint (Base Sepolia or Base Mainnet) |
| `MARKET_ADDRESS` | Deployed `MeridianMarket` contract address |
| `USDC_ADDRESS` | Deployed `MockUSDC` contract address |
| `MAKER_PK` | Private key for the maker wallet (needs ETH for gas) |
| `BUYER_PK` | Private key for the buyer wallet (needs ETH for gas) |

### Optional with defaults

| Variable | Default | Description |
|----------|---------|-------------|
| `CHAIN_ID` | `84532` | Chain ID (84532 = Base Sepolia, 8453 = Base Mainnet) |
| `HERMES_URL` | `https://hermes.pyth.network` | Pyth Hermes REST API base URL |
| `MAKER_QUANTITY` | `10` | Pairs to mint and quote per market per cycle |
| `MAKER_HALF_SPREAD` | `5` | Cents on each side of fair value |
| `MAKER_SENSITIVITY` | `3.0` | Sigmoid steepness |
| `MAKER_HOURS_TOTAL` | `8.0` | NYSE session length in hours (for time weight) |
| `MAKER_MIN_FAIR_VALUE` | `5` | Skip quoting below this fair value (cents) |
| `MAKER_MAX_FAIR_VALUE` | `95` | Skip quoting above this fair value (cents) |
| `MAKER_CRON` | `*/5 * * * *` | Cron for maker bot |
| `BUYER_QUANTITY` | `10` | Max pairs to buy per market per cycle |
| `BUYER_MIN_YES_PROCEEDS` | `0` | Min raw USDC (6-decimal) from YES sell |
| `BUYER_MAX_FILLS` | `10` | Max order crosses per `buyNoMarket` call |
| `BUYER_MIN_BID_DEPTH` | `5` | Minimum BID depth to proceed with a buy |
| `BUYER_RESERVE_DEPTH` | `5` | Units to leave on the book after buying |
| `BUYER_CRON` | `*/30 * * * *` | Cron for buyer bot |
| `LOG_LEVEL` | `info` | Pino log level |

---

## Important Notes

- **Testnet only for USDC minting** — `MockUSDC.mint()` has no access control and works on Base Sepolia. On mainnet you must fund the wallets with real USDC instead.
- **Gas funding** — both wallets need ETH for gas. On Base Sepolia use the [Base faucet](https://www.coinbase.com/faucets/base-ethereum-goerli-faucet).
- **Order state is in-memory** — restarting the service clears the order ID map. The maker will re-cancel by best-effort and re-quote fresh on the next cycle. Residual unfilled orders from before the restart remain on-chain until they expire or are manually cancelled.
- **Single instance** — running multiple instances of the maker with the same wallet will cause nonce conflicts. Deploy exactly one instance per wallet.

---

## Architecture

```
src/
├── index.ts              Entry point — dual cron scheduler
├── config.ts             Env validation + typed config
├── logger.ts             Pino logger
├── abi/
│   ├── MeridianMarket.json
│   └── MockUSDC.json
├── contracts/
│   └── client.ts         Provider, wallets, all contract wrappers
├── services/
│   ├── hermesClient.ts   Pyth Hermes price fetcher
│   └── pricing.ts        Sigmoid fair value model
└── bots/
    ├── makerBot.ts       Two-sided quote bot
    └── buyerBot.ts       Directional NO buyer
```
