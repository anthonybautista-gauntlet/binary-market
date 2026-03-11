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

## Gas Limits

All write calls in `src/contracts/client.ts` include explicit `gasLimit` overrides. This is intentional and important.

### Why explicit gas limits?

Ethers.js calls `eth_estimateGas` before every transaction when no `gasLimit` is provided. On public load-balanced RPC endpoints (including `https://sepolia.base.org`), this causes a **read-your-writes inconsistency**: `tx.wait()` confirms the previous transaction on node A, but the immediately-following `eth_estimateGas` call lands on node B which hasn't yet indexed that block. The simulation runs against stale state (e.g. a just-minted YES token balance reads as 0), causing a spurious revert before the transaction ever reaches the chain.

By providing explicit gas limits, ethers.js skips `eth_estimateGas` entirely and sends transactions directly. The limits are set conservatively above worst-case measured usage so the transaction will always succeed if the on-chain logic would succeed.

### Gas measurements (from `forge test --gas-report`)

| Function | min | avg | median | max | Notes |
|---|---|---|---|---|---|
| `mintPair` | 131k | 137k | 133k | 253k | Measured across 91k test calls |
| `placeOrder` | 25k | 290k | 275k | 5.2M | Max is 100-fill scenario; see below |
| `bulkCancelOrders` | 86k | 123k | 126k | 156k | Measured for 3-order batches |

### Limits set and rationale

| Call | `gasLimit` | Rationale |
|---|---|---|
| `mintPair` | 300k | Max observed 253k; 300k gives ~20% headroom |
| `placeOrder` | 1.5M | Resting order (0 fills): ~275k median. Each fill adds ~300–500k. 1.5M safely handles 2–3 simultaneous fills which is the realistic maker+buyer scenario. |
| `bulkCancelOrders` | `max(200k, orders × 20k)` | Scales with the number of orders being cancelled; 200k minimum for the base tx cost |

### Note on `placeOrder` gas scaling

The order book is a sorted linked list. Gas scales linearly with the number of resting orders crossed (fills). The `test_gas_placeOrder_*` benchmarks show:

| Fills | Total gas |
|---|---|
| 1 | ~1M |
| 5 | ~3M |
| 10 | ~5.4M |

If you expect heavy crossing activity (e.g. the buyer bot has accumulated many BID orders), raise `MAKER_HALF_SPREAD` to reduce the probability of the maker's fresh ASK crossing into existing BIDs, or increase the `gasLimit` in `client.ts` accordingly.

### Long-term fix

Switching to a dedicated RPC provider (Alchemy, QuickNode, etc.) eliminates the read-your-writes issue and would allow removing the explicit gas limits. Public endpoints are load-balanced across nodes with independent block states.

---

## Nonce Management

With 40+ writes in a short maker cycle, nonce handling must be explicit. We use an MVP-safe approach now, and a different one for scaling later.

### Current approach (MVP) — Option 1 (implemented)

We intentionally chose a **single-writer per wallet** model in `src/contracts/client.ts` and `src/index.ts`:

1. **Per-wallet serialized write queue**  
   Every write tx (`mintPair`, `placeOrder`, `bulkCancelOrders`, approvals, `buyNoMarket`) is funneled through a wallet-local queue (concurrency = 1). This guarantees nonce order for each signer.

2. **One-time nonce resync retry**  
   If a write fails with nonce drift errors (`NONCE_EXPIRED`, `nonce too low`, `nonce has already been used`, `replacement transaction underpriced`), the bot resets the signer nonce cache and retries once.

3. **Per-bot in-flight lock**  
   Scheduler runs are skipped if a previous cycle is still executing. This prevents overlapping maker cycles from sending concurrent txs from the same key.

Why this choice now:
- Minimal complexity and no external infra.
- Good fit for a single Railway instance and one writer key per bot.
- Solves the exact failure mode seen in logs (`next nonce N, tx nonce N-2`).

### Better approach for scaling later — Option 2

When moving beyond a single writer instance, use a **distributed nonce manager** (Redis/DB-backed nonce leasing):

- Reserve nonce atomically per wallet (`INCR` / row lock).
- Send tx with explicit nonce.
- Persist tx lifecycle (`reserved`, `sent`, `mined`, `replaced`, `failed`).
- Add reconciliation workers to resolve dropped/replaced txs.

Why this is better for scale:
- Safe across multiple containers/processes using the same signer.
- Survives restarts without nonce desync.
- Supports horizontal scaling and higher sustained write throughput.

---

## Important Notes

- **Testnet only for USDC minting** — `MockUSDC.mint()` has no access control and works on Base Sepolia. On mainnet you must fund the wallets with real USDC instead.
- **Gas funding** — both wallets need ETH for gas. On Base Sepolia use the [Base faucet](https://www.coinbase.com/faucets/base-ethereum-goerli-faucet).
- **Order state is in-memory** — restarting the service clears the order ID map. The maker will re-cancel by best-effort and re-quote fresh on the next cycle. Residual unfilled orders from before the restart remain on-chain until they expire or are manually cancelled.
- **Single instance** — running multiple instances of the maker with the same wallet will cause nonce conflicts. Deploy exactly one instance per wallet.
- **ABI sync** — the `src/abi/MeridianMarket.json` file must stay in sync with the deployed contract. After any contract redeployment, regenerate and extract the ABI array:
  ```bash
  cd contracts
  forge build
  node -e "const fs=require('fs');const a=JSON.parse(fs.readFileSync('out/MeridianMarket.sol/MeridianMarket.json','utf8'));fs.writeFileSync('../maker-bots/src/abi/MeridianMarket.json', JSON.stringify(a.abi,null,2)+'\n');"
  ```
  Then update `MARKET_ADDRESS` in `maker-bots/.env` and restart the service.

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
