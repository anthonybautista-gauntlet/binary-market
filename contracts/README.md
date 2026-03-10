# Meridian Contracts

Binary options protocol on Base. Each market is a `(ticker, strike, expiry)` triple. Yes wins if the closing price is at or above the strike; No wins otherwise. Settlement is sourced from the Pyth Network oracle.

---

## Table of Contents

1. [Architecture overview](#architecture-overview)
2. [Component breakdown](#component-breakdown)
   - [MockUSDC](#1-mockusdc)
   - [PriceLib](#2-pricelib)
   - [OrderBookLib](#3-orderbooklib)
   - [MeridianMarket](#4-meridianmarket)
3. [User flows](#user-flows)
4. [Access control](#access-control)
5. [Pause mechanics](#pause-mechanics)
6. [On-chain metadata (ERC1155 uri)](#on-chain-metadata-erc1155-uri)
7. [Test suite](#test-suite)
8. [Build & test](#build--test)
9. [Deployment](#deployment)
   - [Environment variables](#environment-variables)
   - [Deploy the protocol (Deploy.s.sol)](#deploy-the-protocol)
   - [Configure feeds and create markets (CreateMarkets.s.sol)](#configure-feeds-and-create-markets)
10. [Switching from MockPyth to the deployed Pyth oracle](#switching-from-mockpyth-to-the-deployed-pyth-oracle)
11. [Key constants and limits](#key-constants-and-limits)

---

## Architecture overview

```
┌─────────────────────────────────────────────────────┐
│                  MeridianMarket                     │
│  ERC1155 · AccessControl · Pausable · ReentrancyGuard│
│                                                     │
│  ┌────────────────┐   ┌───────────────────────────┐ │
│  │  OrderBookLib  │   │        PriceLib           │ │
│  │  (CLOB logic)  │   │  (Pyth price validation)  │ │
│  └────────────────┘   └───────────────────────────┘ │
│                                                     │
│  External deps: IPyth (oracle)  ·  IERC20 (USDC)   │
└─────────────────────────────────────────────────────┘
```

The single `MeridianMarket` contract owns all markets, tokens, and order books. There are no proxy patterns or upgradability — the contract is intentionally immutable after deployment for auditability.

---

## Component breakdown

### 1. MockUSDC

**File:** `src/MockUSDC.sol`

A free-mint ERC20 token with 6 decimals, used as collateral on testnet. Anyone can call `mint(address to, uint256 amount)` without restriction. Not deployed on mainnet — replace with real USDC.

---

### 2. PriceLib

**File:** `src/libraries/PriceLib.sol`

A stateless `internal` library for Pyth price validation and strike comparison.

**Fixed-point convention:** All prices use Pyth's native `int64` representation at a fixed exponent of `-5`. A price of `$230.00000` is stored as `23_000_000`.

**`validateAndCompare(PythStructs.Price p, int64 strikePrice, uint16 maxConfBps) → bool yesWins`**

Applies three guards before comparison:

| Check | Revert |
|-------|--------|
| `p.expo != -5` | `UnexpectedExponent` |
| `p.price <= 0` | `NegativePrice` |
| `(conf * 10_000) / absPrice > maxConfBps` | `ConfidenceTooWide` |

Returns `true` if `p.price >= strikePrice` (at-or-above = YES wins). The confidence check prevents settlement when the oracle's uncertainty interval is too wide relative to the price (default threshold: 100 bps = 1%).

**`toDisplayString(int64 price) → string`**

Converts a Pyth int64 price to a human-readable dollar string (e.g. `23_000_000 → "230.00000"`). Used only in `uri()` for on-chain ERC1155 metadata — never in settlement logic.

---

### 3. OrderBookLib

**File:** `src/libraries/OrderBookLib.sol`

An on-chain Central Limit Order Book (CLOB) for Yes token trading. The CLOB operates with 99 discrete price levels ($0.01–$0.99 per Yes token). Each price level maintains a FIFO doubly-linked list of resting orders, giving price-time priority.

**Data structures:**

| Type | Description |
|------|-------------|
| `Side` | `BID` (buy Yes) or `ASK` (sell Yes) |
| `Order` | `owner`, `remainingQty`, `priceCents`, `side`, doubly-linked list pointers |
| `PriceLevel` | `headId`, `tailId`, `totalQty` for one price bucket |
| `Fill` | A single taker↔maker execution: `orderId`, `maker`, `qty`, `priceCents` |
| `FillResult` | Up to 100 fills, `fillCount`, `filledQty`, `usdcTradedCents`, `remainderQty`, `fullyFilled` |
| `Book` | The full order book: `orders` mapping, two `PriceLevel[99]` arrays (bids/asks), `nextOrderId` |

**Hard limits:**
- `HARD_MAX_FILLS = 100` — maximum individual maker orders a single taker transaction can consume in one `matchMarket` call. At the worst case (100 separate 1-token resting orders) this costs ~30M gas, which is 50% of Base's 60M block limit. The caller-supplied `maxFills` parameter is additionally capped to this value.
- `MAX_PRICE_LEVELS = 99` — prices restricted to cents 1–99.

**Key functions:**

- `insert(book, side, priceCents, qty, owner)` — Adds a new resting order. Returns the auto-incremented `orderId`.
- `remove(book, orderId)` — Removes an order from its price level (handles head/tail/middle positions).
- `matchLimit(book, side, priceCents, qty, taker)` — Attempts to cross with resting orders on the opposite side at equal or better price. Returns a `FillResult` with per-fill details and the unfilled remainder.
- `matchMarket(book, side, qty, maxFills, isIOC, taker, fallbackPriceCents)` — Sweeps the best available prices up to `maxFills`. If `isIOC`, the remainder is discarded rather than posted.
- `applyFill(book, orderId, qty)` — Decrements a resting order's `remainingQty` (or removes it if fully filled).
- View helpers: `bestBid`, `bestAsk`, `depthAt`, `ownerOf`, `remainingOf`.

**Self-trade prevention:** Both `matchMarket` and `matchLimit` check `order.owner == taker` and revert with `SelfTradeNotAllowed`.

---

### 4. MeridianMarket

**File:** `src/MeridianMarket.sol`

The main protocol contract. Inherits `ERC1155`, `AccessControl`, `Pausable`, `ReentrancyGuard`.

**Market identity:** Each market is identified by `marketId = keccak256(abi.encode(ticker, strikePrice, expiryTimestamp))`.

**Token IDs:**
- Yes token ID: `uint256(marketId)`
- No token ID: `uint256(keccak256(abi.encode(marketId, "NO")))`

Both IDs are registered in reverse-lookup mappings (`tokenIdToMarket`, `tokenIdIsYes`) at creation time for O(1) access in `uri()`.

**Market discovery:**

Every market created is appended to a public `bytes32[] public allMarketIds` array. The order is strictly append-only (oldest first). Two view functions are provided for frontends:

- `marketCount() → uint256` — returns the total number of markets ever created.
- `getMarkets(uint256 count) → MarketView[]` — returns the `count` most recent markets, newest first. If `count` exceeds the total, all markets are returned.

`MarketView` is a read-only struct that bundles the key fields a frontend needs without requiring a separate call per market:

```solidity
struct MarketView {
    bytes32 marketId;
    bytes32 ticker;
    int64   strikePrice;
    uint64  expiryTimestamp;
    bool    settled;
    bool    yesWins;
    uint256 vaultBalance;
}
```

**Typical frontend usage:**

```js
const total = await contract.marketCount();
// Fetch the 490 most recent (7 stocks × 7 strikes × 10 days)
const markets = await contract.getMarkets(490);
```

Markets can also be discovered from the `MarketCreated` event, but the on-chain array guarantees enumeration without relying on an indexer.

**Market struct fields:**

| Field | Type | Description |
|-------|------|-------------|
| `ticker` | `bytes32` | Asset ticker (e.g. `"AAPL"`) |
| `strikePrice` | `int64` | Strike in Pyth native units (expo -5) |
| `pythFeedId` | `bytes32` | Pyth price feed ID, snapshotted at creation |
| `expiryTimestamp` | `uint64` | Unix timestamp; new mints/orders blocked at or after this |
| `totalPairsMinted` | `uint256` | Total pairs ever minted (decremented by `sellNoMarket`) |
| `vaultBalance` | `uint256` | USDC held for this market in 6-decimal units |
| `feeBpsSnapshot` | `uint16` | Protocol fee rate locked at creation time |
| `settled` | `bool` | Whether settlement has occurred |
| `yesWins` | `bool` | Settlement outcome (only valid when `settled == true`) |

**Core functions:**

#### `OrderFilled` event

Emitted on every fill — whether from a `placeOrder` cross, a `buyNoMarket` sweep, or a `sellNoMarket` sweep. The frontend uses this event to reconstruct full trade history and compute PnL without an indexer.

```solidity
event OrderFilled(
    bytes32 indexed marketId,
    uint256 indexed orderId,
    address indexed maker,
    address taker,
    uint8   side,        // takerSide: 0 = BID, 1 = ASK
    uint8   priceCents,
    uint128 qty
);
```

The `side` field reflects the **taker's** direction: `BID` means the taker was buying Yes (the maker was an ASK); `ASK` means the taker was selling Yes into a BID book.

---

#### `mintPair(bytes32 marketId, uint128 quantity)`

Deposits `quantity × 1e6` USDC and mints exactly `quantity` Yes tokens + `quantity` No tokens to the caller. Reverts after `expiryTimestamp`. Accepts any quantity ≥ 1.

#### `placeOrder(bytes32 marketId, Side side, uint8 priceCents, uint128 quantity, bool isIOC)`

Places a limit order. Full collateral is locked upfront:
- **BID:** Locks `quantity × priceCents × 1e4` USDC.
- **ASK:** Transfers `quantity` Yes tokens from caller to contract.

The order is immediately crossed against resting orders via `matchLimit`. For each fill, `_processFills` pays the maker and delivers assets to the taker. If a BID buyer paid a higher price than the fill price, the overpaid USDC is refunded atomically. The unfilled remainder is either posted as a resting order (non-IOC) or refunded (IOC).

#### `cancelOrder(uint256 orderId)` / `bulkCancelOrders(uint256[] calldata orderIds)`

Cancels a resting order and refunds collateral. Only the order owner can cancel. `bulkCancelOrders` silently skips any orders not owned by the caller. **Both functions work while the contract is paused** — users can always exit.

#### `buyNoMarket(bytes32 marketId, uint128 quantity, uint128 minYesSaleProceeds, uint8 maxFills)`

Atomic "buy No at market" operation:
1. Caller deposits `quantity × 1e6` USDC. Yes tokens are minted to the contract; No tokens are minted to the caller.
2. The contract immediately sells the Yes tokens into the BID side (market order, IOC).
3. BID makers receive their Yes tokens; proceeds flow back to the caller.
4. If the total Yes sale proceeds fall below `minYesSaleProceeds`, the entire call reverts.
5. Any unfilled Yes tokens are burned and the corresponding USDC is refunded to the caller.

Net result: caller spends `quantity × 1e6 - proceeds` USDC and holds `quantity` No tokens.

#### `buyNoLimit(bytes32 marketId, uint128 quantity, uint8 limitYesSalePrice)`

Atomic "buy No with resting Yes limit sells":
1. Caller deposits `quantity × 1e6` USDC. Yes tokens are minted to the contract; No tokens are minted to the caller.
2. The Yes tokens are posted as resting ASK orders at `limitYesSalePrice` on the caller's behalf.

Net result: caller immediately holds `quantity` No tokens and has resting Yes ASK orders totalling `quantity`.

#### `sellNoMarket(bytes32 marketId, uint128 noAmount, uint8 maxYesBuyPrice, uint8 maxFills)`

Atomic "sell No at market" operation (exit a No position):
1. Caller's No tokens move to the contract.
2. Caller locks `noAmount × maxYesBuyPrice × 1e4` USDC as collateral for the Yes purchase.
3. The contract buys Yes from the ASK side (market order, IOC).
4. Yes+No pairs are redeemed for 1 USDC each (no fee — this is a pre-settlement pair cancellation).
5. Unused USDC and unfilled No tokens are returned to the caller.

Net result: caller receives `$1 per pair redeemed - cost of Yes` USDC.

#### `settleMarket(bytes32 marketId, bytes[] calldata priceUpdate, uint64 minPublishTime, uint64 maxPublishTime)`

Settles a market using a Pyth price update VAA. Requirements:
- Caller must hold `SETTLER_ROLE`.
- `block.timestamp >= expiryTimestamp`.
- Settlement window must straddle `expiryTimestamp`: `minPublishTime <= expiryTimestamp <= maxPublishTime`.
- Window width must not exceed `MAX_PARSE_WINDOW` (900 seconds / 15 minutes).
- The Pyth fee (in ETH) must be paid via `msg.value`; any excess is refunded.

Internally calls `pyth.parsePriceFeedUpdates` to fetch the exact price at the settlement window. Price is then validated and compared against the strike via `PriceLib.validateAndCompare`.

#### `adminSettleOverride(bytes32 marketId, int64 manualPrice)`

Emergency settlement with a manually provided price. Only callable by `DEFAULT_ADMIN_ROLE` and only after `expiryTimestamp + ADMIN_OVERRIDE_DELAY` (**900 seconds / 15 minutes**). This is the fallback if Pyth data is unavailable or confidence is too wide.

The 15-minute delay was chosen to align exactly with `MAX_PARSE_WINDOW` and to allow the `adminSettle` job in `market-service` to run at 16:15 ET (15 minutes after the 16:00 ET close) and immediately call override for any markets Pyth could not settle.

#### `redeem(bytes32 marketId, uint256 quantity)`

Burns tokens after settlement. Payout logic:
- **Winners** (holding the winning side): receive `quantity × 1e6 × (1 - feeBpsSnapshot / 10_000)` USDC. The fee portion is transferred directly to `feeRecipient` in the same transaction.
- **Losers** (holding the losing side): tokens are burned, no USDC is returned.
- If the caller holds both sides (e.g. they minted a pair), the **winning token is redeemed first**.

---

## User flows

### Flow 1 — Buy Yes (limit order)
```
User approves USDC → placeOrder(BID, priceCents, qty)
  → collateral locked → crosses resting ASKs if available
  → remainder posted as resting BID
  → after settlement: redeem() to collect winnings (if YES wins)
```

### Flow 2 — Buy No (atomic, market)
```
User approves USDC → buyNoMarket(marketId, minProceeds, maxFills)
  → pays $1 → mints pair → immediately sells Yes into order book
  → receives Yes sale proceeds, holds No token
  → after settlement: redeem() (if NO wins)
```

### Flow 3 — Buy No (atomic, limit)
```
User approves USDC → buyNoLimit(marketId, limitPrice)
  → pays $1 → mints pair → Yes posted as resting ASK
  → holds No token immediately
  → Yes ASK fills over time; proceeds credited when filled
  → after settlement: redeem() (if NO wins)
```

### Flow 4 — Sell No (exit position)
```
User holds No token → sellNoMarket(marketId, qty, maxYesPrice, maxFills)
  → pays up to maxYesPrice USDC per pair
  → buys Yes from order book → redeems Yes+No pair for $1
  → receives $1 - costOfYes per pair redeemed
```

### Flow 5 — Sell Yes (exit limit position)
```
User holds Yes token → placeOrder(ASK, priceCents, qty)
  → Yes tokens locked as collateral
  → crosses resting BIDs immediately if available
  → remainder posted as resting ASK
  → USDC proceeds credited on fill via _processFills
```

---

## Access control

Three roles defined via OpenZeppelin `AccessControl`:

| Role | Constant | Capabilities |
|------|----------|-------------|
| `DEFAULT_ADMIN_ROLE` | `0x00` | Grant/revoke all roles; `setSupportedFeed`; `setFee`; `setFeeRecipient`; `setOracle`; `setMaxConfBps`; `pause`/`unpause`; `adminSettleOverride` |
| `OPERATOR_ROLE` | `keccak256("OPERATOR_ROLE")` | `createStrikeMarket` / `addStrike` |
| `SETTLER_ROLE` | `keccak256("SETTLER_ROLE")` | `settleMarket` (Pyth-based settlement) |

The deployer wallet receives `DEFAULT_ADMIN_ROLE` automatically in the constructor. Roles should be distributed to separate dedicated wallets in production.

---

## Pause mechanics

The contract uses OpenZeppelin `Pausable`. When paused, the following functions revert:

- `mintPair`
- `placeOrder`
- `buyNoMarket`
- `buyNoLimit`
- `sellNoMarket`

These functions remain available while paused:

- `cancelOrder` / `bulkCancelOrders` — users can always reclaim collateral
- `settleMarket` / `adminSettleOverride` — settlement must be possible at any time
- `redeem` — winners can always withdraw
- All admin config functions

---

## On-chain metadata (ERC1155 uri)

`uri(uint256 tokenId)` returns a `data:application/json;base64,…` URI constructed entirely on-chain. No off-chain metadata server is required.

The JSON contains:
- `name`: e.g. `"AAPL YES > $230.00000"`
- `description`: human-readable market question
- `attributes`: Ticker, Token Type (YES/NO), Strike, Expiry, Status (Active/Settled), Outcome (Pending/YES WINS/NO WINS)

The string building is split across three internal helper functions (`_buildJson`, `_buildNameDesc`, `_buildAttrs`) to stay within the Solidity stack depth limit even with `via_ir` enabled.

---

## Test suite

200 tests across 13 test suites. All tests pass.

| Suite | File | Tests | Coverage |
|-------|------|-------|----------|
| `MockUSDCTest` | `test/unit/MockUSDC.t.sol` | 13 | Metadata, minting, transfers, allowances, fuzz |
| `PriceLibTest` | `test/unit/PriceLib.t.sol` | 18 | Expo validation, negative price, confidence, comparisons, display string, fuzz |
| `OrderBookLibTest` | `test/unit/OrderBookLib.t.sol` | 36 | Insert, remove, bestBid/Ask, matchMarket (IOC, non-IOC, multi-level, HARD_MAX_FILLS), matchLimit, price-time priority, self-trade prevention, fuzz |
| `MarketCreationTest` | `test/unit/MarketCreation.t.sol` | 25 | createStrikeMarket, addStrike, token ID registration, feed snapshot, fee snapshot, duplicate revert, role gating; `allMarketIds` append behaviour, `marketCount`, `getMarkets` (empty/full/partial/field correctness) |
| `MintPairTest` | `test/unit/MintPair.t.sol` | 13 | USDC transfer, ERC1155 mint, vault accounting, supply parity, expiry guard, pause guard |
| `OrderBookTest` | `test/unit/OrderBook.t.sol` | 28 | placeOrder (bid/ask/cross/IOC), cancelOrder, bulkCancel, buyNoMarket, buyNoLimit, sellNoMarket; **OrderFilled event emission** for placeOrder cross, buyNoMarket, and sellNoMarket |
| `SettlementTest` | `test/unit/Settlement.t.sol` | 13 | YES/NO/at-strike outcomes, window validation, confidence rejection, expo mismatch, role gating, duplicate settlement |
| `AdminOverrideTest` | `test/unit/Settlement.t.sol` | 7 | Delay enforcement, role gating, duplicate settlement, outcome correctness |
| `RedemptionTest` | `test/unit/Redemption.t.sol` | 13 | Winner/loser payouts, fee forwarding to recipient, fee snapshot isolation, vault accounting, multi-user |
| `AccessControlTest` | `test/unit/AccessControl.t.sol` | 11 | Every role-gated function tested with correct and incorrect callers |
| `PauseTest` | `test/unit/Pause.t.sol` | 10 | All blocked functions revert when paused; cancel/settle/redeem work while paused |
| `FullLifecycleTest` | `test/integration/FullLifecycle.t.sol` | 7 | All 4 trade paths end-to-end; multi-market admin override; on-chain metadata |
| `MeridianInvariant` | `test/invariant/MeridianInvariant.t.sol` | 6 | 256 runs × 500 calls each; vault solvency, supply parity, outstanding pair coverage, fee non-negativity, token ID registration, uri stability |

---

## Build & test

```bash
cd contracts

# Install dependencies (first time)
forge install

# Compile
forge build

# Run all tests
forge test

# Run unit tests only (faster; skips invariant runs)
forge test --no-match-path "test/invariant/**"

# Run a single suite verbosely
forge test --match-contract MarketCreationTest -vv

# Gas snapshot
forge snapshot

# Check contract sizes
forge build --sizes
```

The `foundry.toml` configuration has two non-default settings worth knowing:
- `via_ir = true` — enables the Yul IR compilation pipeline. Required to avoid "stack too deep" errors in `OrderBookLib`'s complex matching functions.
- `optimizer = true` / `optimizer_runs = 100` — required to keep `MeridianMarket`'s bytecode under the 24,576-byte EVM contract size limit. At 100 runs the deployed size is ~24,020 bytes.

---

## Deployment

### Environment variables

Create a `.env` file in the `contracts/` directory (never commit this file):

```bash
# Required for all deployments
DEPLOYER_PK=0x...          # Private key of the deploying wallet
DEPLOYER_ADDRESS=0x...     # Public address matching DEPLOYER_PK

# Pyth oracle contract address on the target chain
# Base Sepolia:  0xA2aa501b19aff244D90cc15a4Cf739D2725B5729  ← real Pyth, has MAG7 equity feeds
# Base Mainnet:  0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a
# Leave empty only for local Anvil testing — auto-deploys MockPyth (no real data)
PYTH_ADDRESS=0x...

# USDC contract address
# Base Sepolia (bridged):  0x036CbD53842c5426634e7929541eC2318f3dCF7e
# Base Mainnet:            0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
# Leave empty on testnet to auto-deploy MockUSDC
USDC_ADDRESS=

# Address that receives protocol fees (can be deployer wallet initially)
FEE_RECIPIENT=0x...

# Protocol fee in basis points (50 = 0.5%, max 200 = 2%)
FEE_BPS=50

# Required for CreateMarkets.s.sol
OPERATOR_PK=0x...          # Private key of a wallet with OPERATOR_ROLE
MARKET_ADDRESS=0x...       # Deployed MeridianMarket address

# Optional: override expiry for CreateMarkets.s.sol
# EXPIRY_TIMESTAMP=1800000000
```

Load the file before running scripts:
```bash
source .env
```

### Deploy the protocol

**Step 1 — Deploy `MeridianMarket` (and optionally `MockUSDC`):**

```bash
# Testnet (Base Sepolia) — auto-deploys MockUSDC if USDC_ADDRESS is empty
forge script script/Deploy.s.sol \
  --rpc-url $BASE_SEPOLIA_RPC \
  --broadcast \
  --verify \
  --sig "run()"

# Mainnet (Base)
forge script script/Deploy.s.sol \
  --rpc-url $BASE_RPC \
  --broadcast \
  --verify \
  --sig "run()"
```

Note the deployed `MeridianMarket` address from the output and set it as `MARKET_ADDRESS` in `.env`.

**Step 2 — Grant roles to operational wallets (admin wallet):**

The deployer wallet automatically holds `DEFAULT_ADMIN_ROLE`. Grant the operational roles from that wallet:

```bash
# Grant OPERATOR_ROLE to the operator wallet
cast send $MARKET_ADDRESS \
  "grantRole(bytes32,address)" \
  $(cast keccak "OPERATOR_ROLE") $OPERATOR_ADDRESS \
  --private-key $DEPLOYER_PK \
  --rpc-url $BASE_SEPOLIA_RPC

# Grant SETTLER_ROLE to the settler wallet (can be the same as operator on testnet)
cast send $MARKET_ADDRESS \
  "grantRole(bytes32,address)" \
  $(cast keccak "SETTLER_ROLE") $SETTLER_ADDRESS \
  --private-key $DEPLOYER_PK \
  --rpc-url $BASE_SEPOLIA_RPC
```

**Step 3 — Configure supported tickers (admin wallet):**

Before any markets can be created, each ticker must be registered with its Pyth feed ID:

```bash
# Register AAPL feed
cast send $MARKET_ADDRESS \
  "setSupportedFeed(bytes32,bytes32,bool)" \
  $(cast --format-bytes32-string "AAPL") \
  0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688 \
  true \
  --private-key $DEPLOYER_PK \
  --rpc-url $BASE_SEPOLIA_RPC
```

Full Pyth feed ID list: https://pyth.network/developers/price-feed-ids

### Configure feeds and create markets

**Step 4 — Create initial markets (operator wallet):**

```bash
forge script script/CreateMarkets.s.sol \
  --rpc-url $BASE_SEPOLIA_RPC \
  --broadcast \
  --sig "run()"
```

`CreateMarkets.s.sol` creates a set of AAPL strike markets at predefined prices. Edit the script to adjust tickers, strikes, and expiry before running. The script checks for duplicate markets and skips gracefully.

---

## Switching to the real Pyth oracle

The real Pyth contract on Base Sepolia (`0xA2aa501b19aff244D90cc15a4Cf739D2725B5729`) has live MAG7 equity feed data and is the recommended oracle for all deployments. Switching from a `MockPyth` deployment requires **zero contract changes** — the `settleMarket` function already speaks the production `IPyth` interface.

**Step 1 — Confirm the feed is live on Pyth**

Verify that the feed exists and returns data:

```bash
curl "https://hermes.pyth.network/v2/updates/price/latest?\
ids[]=0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688"
```

If you get a `200` response with price data, the feed is live. Equity feeds (AAPL, MSFT, NVDA, GOOGL, AMZN, META, TSLA) are available on both Base mainnet and Base Sepolia via the real Pyth contract. Prices are published during NYSE market hours (09:30–16:00 ET). Check https://pyth.network/developers/price-feed-ids for the full list.

**Step 2 — Point the contract at the real Pyth address**

Call `setOracle` from the admin wallet. This takes effect for all future `settleMarket` calls:

```bash
# Base Sepolia
cast send $MARKET_ADDRESS \
  "setOracle(address)" \
  0xA2aa501b19aff244D90cc15a4Cf739D2725B5729 \
  --private-key $DEPLOYER_PK \
  --rpc-url $BASE_SEPOLIA_RPC

# Base Mainnet
cast send $MARKET_ADDRESS \
  "setOracle(address)" \
  0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a \
  --private-key $DEPLOYER_PK \
  --rpc-url $BASE_MAINNET_RPC
```

**Step 3 — Fetch a price update VAA from Hermes at settlement time**

When settling a market, the settler must fetch a Pyth VAA whose `publishTime` falls within the settlement window `[minPublishTime, maxPublishTime]` (which must straddle the market's `expiryTimestamp`):

```bash
# 1. Fetch the latest update for the feed
PRICE_UPDATE=$(curl -s "https://hermes.pyth.network/v2/updates/price/latest?\
ids[]=0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688" \
  | jq -r '.binary.data[0]')

# 2. Get the required fee
FEE=$(cast call $MARKET_ADDRESS \
  "getUpdateFee(bytes[])" "[0x$PRICE_UPDATE]" \
  --rpc-url $BASE_SEPOLIA_RPC)

# 3. Call settleMarket
# Replace EXPIRY with the market's expiryTimestamp
EXPIRY=1800000000
MIN=$((EXPIRY - 300))   # 5 min before expiry
MAX=$((EXPIRY + 300))   # 5 min after expiry (must be <= MAX_PARSE_WINDOW = 900s total)

cast send $MARKET_ADDRESS \
  "settleMarket(bytes32,bytes[],uint64,uint64)" \
  $MARKET_ID "[0x$PRICE_UPDATE]" $MIN $MAX \
  --value $FEE \
  --private-key $SETTLER_PK \
  --rpc-url $BASE_SEPOLIA_RPC
```

**Step 4 — Fallback: adminSettleOverride**

If the Pyth feed has no data in the settlement window (e.g. it was a weekend, the oracle was down, or confidence was too wide), use the admin override **15 minutes after expiry** (`ADMIN_OVERRIDE_DELAY = 900s`):

```bash
cast send $MARKET_ADDRESS \
  "adminSettleOverride(bytes32,int64)" \
  $MARKET_ID $MANUAL_PRICE \
  --private-key $DEPLOYER_PK \
  --rpc-url $BASE_SEPOLIA_RPC
```

`MANUAL_PRICE` must be in Pyth native units at expo `-5` (e.g. `$230.00` = `23000000`).

For bulk admin settlement, use the `AdminSettle.s.sol` script which handles the full workflow automatically:

```bash
# Set prices and settle all unsettled markets in one call
forge script script/AdminSettle.s.sol \
  --rpc-url $BASE_SEPOLIA_RPC \
  --broadcast \
  --sig "run()"
```

`AdminSettle.s.sol` fetches all unsettled markets, maps each ticker to a manually provided closing price (set via `PRICES_JSON` env var or hardcoded in the script), converts dollars to Pyth units, and calls `adminSettleOverride` for each. It skips markets that are already settled and reverts gracefully if the 15-minute delay has not elapsed yet.

**What does NOT need to change:**
- The contract itself
- The feed IDs registered via `setSupportedFeed` (same IDs on both mock and real Pyth)
- The test suite (continues using `MockPyth` for local unit tests)
- The settlement window logic or confidence/exponent validation

> **Current Base Sepolia deployment**: The `MeridianMarket` contract at `0x0793531B3CcE2B833298cFeCAEC63ad5c327302d` has already been switched to the real Pyth oracle via `setOracle`. The `market-service` is configured accordingly with `IS_TESTNET=true` (to enable the hourly price pusher) and `PYTH_ADDRESS=0xA2aa501b19aff244D90cc15a4Cf739D2725B5729`.

---

## Key constants and limits

| Constant | Value | Description |
|----------|-------|-------------|
| `MAX_FEE_BPS` | 200 | Maximum protocol fee (2%) |
| `ADMIN_OVERRIDE_DELAY` | 900 s | Delay after expiry before admin can override settlement (15 minutes, matching `MAX_PARSE_WINDOW`) |
| `MAX_PARSE_WINDOW` | 900 s | Maximum width of the Pyth settlement time window (15 minutes) |
| `HARD_MAX_FILLS` | 100 | Maximum fills per single order/atomic call (~30M gas worst-case on Base) |
| `MAX_PRICE_LEVELS` | 99 | Price buckets in the order book (1–99 cents) |
| `maxConfBps` (default) | 100 | Default max Pyth confidence-to-price ratio (1%); adjustable via `setMaxConfBps` |
| `feeBpsSnapshot` | set at creation | Fee rate for a market is locked at creation; changing `feeBps` does not affect existing markets |
| Collateral per pair | 1 USDC (1e6) | Fixed; no leverage |
| Pyth price exponent | -5 | All prices must use this exponent; any other value causes settlement revert |
