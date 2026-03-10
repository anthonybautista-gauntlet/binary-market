# Meridian Market Service

Automation service for the Meridian binary options protocol. Runs four scheduled jobs:

1. **createMarkets** — creates daily strike markets for all 7 MAG7 tickers each morning
2. **settleMarkets** — settles expired markets at 16:05 ET using Pyth/Hermes oracle prices
3. **adminSettle** — Yahoo Finance fallback at 16:15 ET for any markets Hermes could not settle
4. **pricePusher** — testnet only: pushes live Hermes VAA prices to the Pyth oracle so on-chain reads stay current

The service is a long-running Node.js process designed to be deployed as a Docker container on Railway (or any container host).

---

## Prerequisites

- Node.js 20+
- npm 9+
- An RPC endpoint for Base Sepolia or Base mainnet
- Two wallet private keys with the correct contract roles granted (see [Roles](#roles))

---

## Setup

### 1. Install dependencies

```bash
cd market-service
npm install
```

### 2. Create your `.env` file

```bash
cp .env.example .env
```

Then fill in all values. See [Environment Variables](#environment-variables) for full documentation.

### 3. Build

```bash
npm run build
```

Compiles TypeScript to `dist/`.

---

## Running

### Development (hot reload)

```bash
npm run dev
```

Uses `tsx watch` — restarts on any source file change. Loads `.env` automatically via `dotenv/config`.

### Production (compiled)

```bash
npm run build
npm start
```

### Docker (local)

```bash
docker compose up --build
```

Reads from `.env` in the `market-service/` directory. Set `NODE_ENV=production` in the compose file or your shell for JSON-only logging.

### Docker (Railway)

1. Create a new Railway service pointing to the `market-service/` directory (set root directory in Railway settings)
2. Set all environment variables in the Railway dashboard — do not commit `.env`
3. Railway builds and deploys from the `Dockerfile` automatically on each push

---

## Environment Variables

All variables are read at startup. The process exits immediately if any required variable is missing.

### Required

| Variable | Description |
|---|---|
| `RPC_URL` | JSON-RPC endpoint for the target chain. Use a reliable provider in production (Alchemy, QuickNode, etc.). Public endpoints like `https://sepolia.base.org` are rate-limited. |
| `MARKET_ADDRESS` | Deployed `MeridianMarket` contract address |
| `PYTH_ADDRESS` | Pyth oracle contract address. Base Sepolia: `0xA2aa501b19aff244D90cc15a4Cf739D2725B5729`. Base mainnet: `0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a`. |
| `OPERATOR_PK` | Private key of a wallet holding `OPERATOR_ROLE` on `MeridianMarket`. Used to broadcast `createStrikeMarket` transactions. |
| `SETTLER_PK` | Private key of a wallet holding `SETTLER_ROLE` on `MeridianMarket`. Used to broadcast `settleMarket` transactions. Can be the same key as `OPERATOR_PK`. |
| `ADMIN_PK` | Private key of a wallet holding `DEFAULT_ADMIN_ROLE` on `MeridianMarket`. Used by the `adminSettle` job to call `adminSettleOverride`. This is the deployer wallet. |

### Optional (with defaults)

| Variable | Default | Description |
|---|---|---|
| `CHAIN_ID` | `84532` | EVM chain ID. `84532` = Base Sepolia, `8453` = Base mainnet. Used to validate the RPC connection on startup. |
| `IS_TESTNET` | `false` | Set to `true` on testnet to enable the pricePusher job. Does not affect price update encoding — both testnet and mainnet use raw Hermes VAA bytes. |
| `HERMES_URL` | `https://hermes.pyth.network` | Pyth Hermes REST API base URL. No API key required. |
| `CREATE_MARKETS_CRON` | `0 8 * * 1-5` | Cron expression for market creation. Evaluated in `America/New_York` timezone. |
| `SETTLE_MARKETS_CRON` | `5 16 * * 1-5` | Cron expression for Pyth/Hermes settlement. Evaluated in `America/New_York` timezone. |
| `ADMIN_SETTLE_CRON` | `15 16 * * 1-5` | Cron expression for the Yahoo Finance fallback settlement (16:15 ET = exactly when `ADMIN_OVERRIDE_DELAY` expires). |
| `PRICE_PUSHER_INTERVAL_MIN` | `60` | Interval in minutes between Pyth price pushes. Only active when `IS_TESTNET=true`. |
| `PRICE_PUSHER_MAX_AGE_SECONDS` | `600` | Maximum age in seconds for a Hermes price to be considered fresh enough to push. Stale feeds are skipped with a warning. |
| `LOG_LEVEL` | `info` | Pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal` |

### Deployed contract addresses (Base Sepolia)

```
MARKET_ADDRESS=0x0793531B3CcE2B833298cFeCAEC63ad5c327302d
PYTH_ADDRESS=0xA2aa501b19aff244D90cc15a4Cf739D2725B5729
```

---

## Roles

Three wallet roles are required. These are granted on the `MeridianMarket` contract by the deployer (who holds `DEFAULT_ADMIN_ROLE`).

| Role | keccak256 hash | Used by |
|---|---|---|
| `OPERATOR_ROLE` | `0x97667070c54ef182b0f5858b034beac1b6f3089aa2d3188bb1e8929f4fa9b929` | createMarkets job |
| `SETTLER_ROLE` | `0xe2f4eaae4a9751e85a3e4a7b9587827a877f29914755229b07a7b2da98285f70` | settleMarkets job |
| `DEFAULT_ADMIN_ROLE` | `0x0000000000000000000000000000000000000000000000000000000000000000` | adminSettle job (is the deployer by default) |

Grant roles from the deployer wallet (one-time setup):

```bash
# From contracts/ directory with DEPLOYER_PK and BASE_SEPOLIA_RPC in your shell

cast send $MARKET_ADDRESS \
  "grantRole(bytes32,address)" \
  $(cast keccak "OPERATOR_ROLE") \
  $OPERATOR_ADDRESS \
  --private-key $DEPLOYER_PK --rpc-url $BASE_SEPOLIA_RPC

cast send $MARKET_ADDRESS \
  "grantRole(bytes32,address)" \
  $(cast keccak "SETTLER_ROLE") \
  $SETTLER_ADDRESS \
  --private-key $DEPLOYER_PK --rpc-url $BASE_SEPOLIA_RPC
```

If deploying from scratch, `Deploy.s.sol` will grant both roles automatically if `OPERATOR_ADDRESS` and `SETTLER_ADDRESS` are set in `.env` before running the deploy script.

---

## Jobs

### createMarkets

**Schedule**: `0 8 * * 1-5` (08:00 ET, Mon–Fri)

**Also runs on startup** if today is a trading day and the current time is before market close. This catch-up behaviour means restarting the service mid-morning after any outage will automatically create any markets that were missed.

**What it does:**

1. Checks whether today is a NYSE trading day using `date-holidays` (NYSE locale). Exits early if not.
2. Determines today's market expiry timestamp:
   - Regular day: `today at 16:00 ET`
   - Early-close day (day before July 4th, day after Thanksgiving, Christmas Eve): `today at 13:00 ET`
3. Fetches current live prices for all 7 MAG7 tickers from Pyth Hermes (`/v2/updates/price/latest`).
4. If Hermes is unavailable, falls back to Yahoo Finance closing prices (see [Yahoo Finance fallback](#yahoo-finance-fallback)).
5. For each ticker, computes up to 7 strike bins from the reference price:
   - Offsets: −9%, −6%, −3%, 0% (ATM), +3%, +6%, +9%
   - Each strike is rounded to the nearest $10.00 (1,000,000 Pyth units at expo −5)
   - Duplicate strikes (common for lower-priced stocks) are silently deduplicated
6. For each (ticker, strike, expiry) triple, computes the deterministic `marketId` and calls `market.markets(marketId)` to check whether it already exists on-chain.
7. Calls `createStrikeMarket(ticker, strikePrice, expiryTimestamp)` for each market that does not yet exist.

**Why current price instead of yesterday's close:** The `/v2/updates/price/latest` Hermes endpoint is the same reliable endpoint used by the pricePusher job. Historical Hermes endpoints for equity feeds are unreliable — equity prices are only published during NYSE hours and the feed may have no data for a given historical timestamp. Using the current live price also means today's strikes are centered on today's actual market level rather than the previous day's close, which is strictly better for users.

**Guardrail**: The on-chain existence check before each creation call makes this job fully idempotent. Re-running it will skip any already-created markets and will not revert.

**Typical output**: up to 49 markets per day (7 tickers × up to 7 strikes), fewer if strikes collapse due to low stock price or if markets were created manually.

---

### settleMarkets

**Schedule**: `5 16 * * 1-5` (16:05 ET, Mon–Fri)

Early-close days: if today is an early-close day (detected at runtime), the settlement cron should be adjusted to `5 13 * * 1-5` via the `SETTLE_MARKETS_CRON` env var. The job itself does not auto-adjust the schedule, but it does handle early-close expiry times correctly.

**What it does:**

1. Checks whether today is a NYSE trading day. Exits early if not.
2. Calls `marketCount()` then `getMarkets(count)` to retrieve all markets from the contract.
3. Filters for markets where `settled == false` and `expiryTimestamp <= now`.
4. For each unsettled, expired market:
   a. Fetches the settlement price from Pyth Hermes at the market's `expiryTimestamp`.
   b. Validates that Hermes returned a price with `publishTime` inside the window `[expiry − 5min, expiry + 10min]`. If not, logs an error and skips (requires manual intervention via `adminSettleOverride`).
   c. Encodes the price update bytes appropriate for the target Pyth contract (see [Testnet vs Mainnet](#testnet-vs-mainnet)).
   d. Queries `pyth.getUpdateFee(priceUpdate)` for the required ETH fee.
   e. Calls `settleMarket(marketId, priceUpdate, minPublishTime, maxPublishTime)` with `{ value: fee }`.
5. Logs outcome for each market. Failed settlements do not abort processing of remaining markets.

**Two independent timing checks in the contract:**

1. `block.timestamp >= expiryTimestamp` — the settlement *transaction* cannot be sent before the market has expired. This is enforced by the contract and cannot be bypassed regardless of the window values.
2. The settlement *window* (`minPublishTime` / `maxPublishTime`) controls which Pyth price update is considered valid. The contract requires the window to straddle the expiry: `minPublishTime ≤ expiryTimestamp ≤ maxPublishTime`, with a maximum spread of 900s (`MAX_PARSE_WINDOW`).

These two checks are independent. The window does not allow early settlement — the transaction itself is still blocked until after expiry.

**Why the window starts before expiry (−300s):** Pyth equity feeds stop publishing new updates at exactly 4:00 PM ET. The last published price often has a `publishTime` of `15:59:xx` — a few seconds before the 4:00 PM boundary. If the window started at `expiryTimestamp`, that genuine closing-price update would be rejected. The −5 minute lookback ensures the final pre-close update is accepted as the settlement price.

**Window values used**: `minPublishTime = expiryTimestamp − 300s`, `maxPublishTime = expiryTimestamp + 600s`. Total spread = 900s = exactly `MAX_PARSE_WINDOW`.

**Automatic fallback**: If settlement fails because no Hermes data is available within the window (e.g. Pyth publisher outage), the `adminSettle` job runs at 16:15 ET and handles these markets automatically via Yahoo Finance (see [adminSettle](#adminsettle) below).

**Manual fallback**: The deployer can also call `adminSettleOverride(marketId, manualPrice)` directly from the `contracts/` directory using `AdminSettle.s.sol`, or via `cast send`. The contract enforces a 15-minute delay after expiry (`ADMIN_OVERRIDE_DELAY = 900s`). This delay intentionally aligns with `MAX_PARSE_WINDOW` (also 900s), ensuring the settlement window can fully close before the override becomes callable.

---

### adminSettle

**Schedule**: `15 16 * * 1-5` (16:15 ET, Mon–Fri) — configurable via `ADMIN_SETTLE_CRON`

**What it does:**

This job is the automatic fallback for markets that could not be settled by `settleMarkets` (e.g. Pyth publisher outage on Base Sepolia, Hermes 404, stale data). It runs 15 minutes after NYSE close, which is exactly when `MeridianMarket.ADMIN_OVERRIDE_DELAY` (900 seconds) expires.

1. Checks whether today is a NYSE trading day. Exits early if not.
2. Calls `getMarkets(count)` to retrieve all markets from the contract.
3. Filters for markets where `settled == false`, `expiryTimestamp <= now`, and `now >= expiryTimestamp + 900`.
4. Fetches closing prices for all unique tickers from Yahoo Finance (`yahoo-finance2` package, no API key required). Uses `regularMarketPrice` which reflects the official closing price post-16:00 ET.
5. Converts each dollar price to Pyth units: `Math.round(price * 100_000)` (expo −5).
6. Calls `adminSettleOverride(marketId, manualPrice)` using the `ADMIN_PK` wallet (must hold `DEFAULT_ADMIN_ROLE`).

**Accuracy note**: Since all strike prices are rounded to the nearest $10, a dollar-precision closing price from Yahoo Finance is more than sufficient to determine the YES/NO outcome correctly.

**Startup behaviour**: Also runs once immediately on startup (same crash-recovery pattern as `settleMarkets`). It will skip markets that are still within the 15-minute delay window.

---

### Yahoo Finance fallback

Both `createMarkets` and `adminSettle` use Yahoo Finance as a fallback price source. The two use-cases are distinct:

| Job | When Yahoo Finance is used | What it fetches |
|---|---|---|
| `createMarkets` | Pyth Hermes `/latest` returns an error or times out | `regularMarketPrice` from `yahooFinance.quote()` — the most recent trade price |
| `adminSettle` | Always (it is the primary source for admin settlement) | `regularMarketPrice` — reflects the official closing price after 16:00 ET |

**Implementation detail — cloud environment compatibility:**

`yahoo-finance2` v3.x performs crumb validation by default. In cloud environments (Railway, Docker) the default HTTP fetch headers are often fingerprinted and rejected by Yahoo's servers, causing all quote requests to silently fail. To work around this, every `yahooFinance.quote()` call passes a `fetchOptions` override with a browser `User-Agent` header:

```typescript
const YAHOO_MODULE_OPTIONS = {
  fetchOptions: {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ...",
    },
  },
};

const quote = await yahooFinance.quote(ticker, {}, YAHOO_MODULE_OPTIONS);
```

This is passed as the third `moduleOptions` argument (per-request override), not as a global `options()` call. Using the global `options()` API on the default import causes a crash in v3.x because the default export is the class itself, not a pre-instantiated singleton.

---

### pricePusher

**Schedule**: Every `PRICE_PUSHER_INTERVAL_MIN` minutes (default: 60)

**Active only when**: `IS_TESTNET=true`

**What it does:**

Fetches the latest MAG7 prices from Pyth Hermes (`/v2/updates/price/latest`) and calls `Pyth.updatePriceFeeds(updateData)` on the real Pyth oracle, keeping on-chain price state fresh so frontends that read from the oracle see current equity prices during testnet development.

This job runs once immediately on startup (in addition to the cron schedule) to ensure prices are current from the moment the service starts.

On mainnet, this job is disabled. Prices are submitted on-demand by the settler at settlement time and do not need continuous pushing.

---

## Testnet vs Mainnet

Both environments use the real Pyth oracle and submit raw Hermes VAA bytes for price updates. The only behavioural difference is that the pricePusher job runs on testnet to keep oracle prices current between settlements.

| | Mainnet | Testnet (Base Sepolia) |
|---|---|---|
| Price source | Pyth Hermes `/v2/updates/price/{ts}` | Same |
| Update bytes | Raw Hermes VAA bytes | Same |
| Pyth contract | `0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a` | `0xA2aa501b19aff244D90cc15a4Cf739D2725B5729` |
| pricePusher | Disabled | Enabled (hourly, `IS_TESTNET=true`) |
| adminSettle fallback | Yahoo Finance (16:15 ET) | Same |

To switch to mainnet:
1. Set `IS_TESTNET=false`
2. Set `PYTH_ADDRESS=0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a`
3. Set `RPC_URL` to a Base mainnet RPC endpoint
4. Set `CHAIN_ID=8453`

---

## Source Layout

```
src/
├── index.ts                  Entry point: initialises cron scheduler and graceful shutdown
├── config.ts                 Validates all env vars on startup; exports typed config object
│                             Also contains hardcoded MAG7 feed IDs and 2026 NYSE calendar
├── logger.ts                 Pino logger (pretty-printed in dev, JSON in production)
│
├── jobs/
│   ├── createMarkets.ts      Morning job: trading day check → price fetch → strike calc → on-chain create
│   ├── settleMarkets.ts      Post-close job: find expired markets → Hermes price → settleMarket tx
│   ├── adminSettle.ts        Fallback job: Yahoo Finance prices → adminSettleOverride for unsettled markets
│   └── pricePusher.ts        Testnet hourly job: Hermes latest prices → Pyth.updatePriceFeeds
│
├── services/
│   ├── calendarService.ts    NYSE trading calendar: isTradingDay, isEarlyClose, getMarketCloseTime
│   │                         Primary: date-holidays (NYSE locale). Fallback: hardcoded 2026 list.
│   ├── hermesClient.ts       Pyth Hermes API client: fetchLatestPrices, fetchPricesAtTime (with retry)
│   ├── strikeCalc.ts         Strike bin math: integer mirror of Solidity _computeStrikes/_roundToTen
│   └── yahooFinance.ts       Yahoo Finance price fetcher — used by adminSettle (primary) and createMarkets
│                             (fallback). Passes per-request browser User-Agent headers to work in cloud envs.
│
├── contracts/
│   ├── marketContract.ts     ethers.js wrappers: createStrikeMarket, settleMarket, adminSettleOverride, etc.
│   │                         Exposes provider/wallet singletons (operator, settler, admin) with NonceManager
│   └── pythAdapter.ts        Encodes raw Hermes VAA bytes for Pyth price updates
│
└── abi/
    ├── MeridianMarket.json   Extracted from contracts/out/MeridianMarket.sol/MeridianMarket.json
    └── MockPyth.json         ABI for Pyth oracle functions (updatePriceFeeds, getUpdateFee) — compatible with the real Pyth interface
```

---

## Strike Calculation

Strike bins are computed identically to the Solidity script in `contracts/script/CreateMarkets.s.sol`. The TypeScript implementation in `src/services/strikeCalc.ts` uses `BigInt` arithmetic to avoid floating-point error.

Reference price comes from Pyth Hermes `/v2/updates/price/latest` at job runtime. If Hermes is unavailable, Yahoo Finance `regularMarketPrice` is used. All prices use Pyth's native units at exponent −5: `$1.00 = 100,000 units`, `$10.00 = 1,000,000 units`.

**Offsets applied**: 91%, 94%, 97%, 100% (ATM), 103%, 106%, 109% of the reference price.

**Rounding**: Each result is rounded to the nearest $10 (1,000,000 units):
```
rounded = round(price / 1_000_000) * 1_000_000
```

**Deduplication**: Lower-priced stocks (e.g. NVDA at ~$179) produce fewer unique strikes because multiple offsets round to the same $10 bin. Duplicates are dropped, so the final count may be fewer than 7.

---

## NYSE Calendar

Holiday and early-close detection is handled by `src/services/calendarService.ts`.

**Primary source**: [`date-holidays`](https://github.com/commenthol/date-holidays) npm package with `new Holidays("NYSE")`. This is offline, requires no API key, and covers NYSE-specific holidays (including Good Friday, which is not a US federal holiday).

**Fallback**: If `date-holidays` fails to initialise or returns unexpected results, the service falls back to a hardcoded list of NYSE 2026 holidays and early-close days defined in `src/config.ts`. This list must be updated annually.

**2026 holidays** (hardcoded fallback):
- Jan 1 (New Year's Day), Jan 19 (MLK), Feb 16 (Presidents' Day), Apr 3 (Good Friday), May 25 (Memorial Day), Jul 3 (Independence Day observed), Sep 7 (Labor Day), Nov 26 (Thanksgiving), Dec 25 (Christmas)

**2026 early closes** (1:00 PM ET):
- Jul 2, Nov 27, Dec 24

---

## Logging

All output is structured JSON in production (Railway log drains). In development (`NODE_ENV` not set to `production`), `pino-pretty` formats logs for readability.

Each job logs:
- `=== <jobName> job started ===` with ISO timestamp
- Every significant action (market created/skipped, settlement price, tx hash)
- `=== <jobName> job completed ===` with totals (created/skipped/errors)

Set `LOG_LEVEL=debug` to see per-strike and per-market detail.

Failed operations within a job are logged as errors but do not abort the rest of the job run or crash the process. Uncaught exceptions and unhandled rejections are logged as `fatal` and the process exits (Railway will restart it).

---

## Updating ABIs

If the `MeridianMarket` contract is redeployed, regenerate the ABIs:

```bash
cd contracts
forge build
cp out/MeridianMarket.sol/MeridianMarket.json ../market-service/src/abi/MeridianMarket.json
cp out/MockPyth.sol/MockPyth.json ../market-service/src/abi/MockPyth.json
# Note: MockPyth.json is used for its ABI only; the real Pyth on Base Sepolia/mainnet
# implements the same updatePriceFeeds and getUpdateFee function signatures.
```

Then rebuild the service:
```bash
cd ../market-service
npm run build
```

---

## Troubleshooting

**Service fails to start with "Missing required environment variables"**
All six required variables must be set: `RPC_URL`, `MARKET_ADDRESS`, `PYTH_ADDRESS`, `OPERATOR_PK`, `SETTLER_PK`, `ADMIN_PK`.

**"RPC connection failed — check RPC_URL"**
The RPC endpoint is unreachable or returning errors. Public endpoints (`https://sepolia.base.org`) are rate-limited; use a dedicated node provider for production.

**createMarkets: "Failed to fetch prices from Hermes — falling back to Yahoo Finance"**
Pyth Hermes `/latest` was unavailable or returned an error. The job will automatically retry with Yahoo Finance. If both fail, the job aborts and logs "Yahoo Finance returned no prices — aborting market creation". Restart the service or trigger the job manually once prices are available. This most commonly happens if the service starts before NYSE market open (when equity feeds are not yet publishing).

**createMarkets: "UnsupportedTicker" revert**
The MAG7 feeds have not been registered on the contract. Run `setSupportedFeed` for all 7 tickers from the deployer wallet (see `contracts/README.md` → Deployment).

**createMarkets: "AccessControlUnauthorizedAccount"**
The `OPERATOR_PK` wallet does not hold `OPERATOR_ROLE`. Grant it using `cast send` (see [Roles](#roles)).

**settleMarkets: "Hermes publishTime outside settlement window"**
Pyth Hermes did not return a price update within the ±5min/+10min window around the market's expiry. This happens when the equity feed goes stale at close. The `adminSettle` job will automatically handle these markets at 16:15 ET using Yahoo Finance prices. For manual resolution, call `adminSettleOverride(marketId, manualPrice)` after the 15-minute delay has passed using `contracts/script/AdminSettle.s.sol`.

**settleMarkets: "AlreadySettled"**
The market was already settled (possibly by a manual call or previous run). The job skips already-settled markets in its pre-filter, but if settlement state changed between the filter and the tx, this revert may appear. It is safe to ignore.

**pricePusher not running**
Verify `IS_TESTNET=true` is set. The job is entirely disabled when `IS_TESTNET` is `false` or absent. Also ensure `PYTH_ADDRESS` points to the real Pyth oracle on Base Sepolia (`0xA2aa501b19aff244D90cc15a4Cf739D2725B5729`).

**adminSettle: "Yahoo Finance returned no prices" / markets still unsettled after 16:15 ET**
Yahoo Finance may be temporarily unavailable or returning stale data. Use the manual fallback: run `contracts/script/AdminSettle.s.sol` with the correct closing prices (see `contracts/README.md`).

**adminSettle: "AccessControlUnauthorizedAccount"**
The `ADMIN_PK` wallet does not hold `DEFAULT_ADMIN_ROLE` on the contract. This role is held by the deployer by default. Either use the deployer key for `ADMIN_PK`, or grant the role via `cast send $MARKET_ADDRESS "grantRole(bytes32,address)" 0x0000000000000000000000000000000000000000000000000000000000000000 $ADMIN_ADDRESS --private-key $DEPLOYER_PK`.
