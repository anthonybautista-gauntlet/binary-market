# Meridian Frontend Integration Guide

## Deployed Contracts (Base Sepolia)

| Contract | Address |
|---|---|
| MeridianMarket | `0x0793531B3CcE2B833298cFeCAEC63ad5c327302d` |
| MockUSDC | `0x1907827426fbE7F79801425014CA32c53C104DB3` |
| Pyth Oracle | `0xA2aa501b19aff244D90cc15a4Cf739D2725B5729` |

Chain ID: `84532` (Base Sepolia)

---

## ABI Files

All ABIs are committed to the repository and must be imported directly — do not re-generate them.

| Contract | ABI Path |
|---|---|
| MeridianMarket | `contracts/out/MeridianMarket.sol/MeridianMarket.json` |
| MockUSDC | `contracts/out/MockUSDC.sol/MockUSDC.json` |

The full ABI is inside the `abi` key of each JSON file, not the file root. Extract with:
```javascript
import artifact from '../contracts/out/MeridianMarket.sol/MeridianMarket.json';
const abi = artifact.abi;
```

---

## Units and Encoding

### USDC (MockUSDC)
- ERC20, 6 decimals
- `$1.00 = 1_000_000` (1e6) raw units
- All contract functions that accept or return USDC use 6-decimal raw units

### Yes/No Token Prices (Order Book)
- Prices are in whole **cents** as `uint8` integers in the range **1–99**
- `1 cent = $0.01`, `99 cents = $0.99`
- A Yes token at price 50 means $0.50 per token
- To compute USDC cost: `quantity * priceCents * 10_000` (the 1e4 factor converts cent-qty products to 6-decimal USDC)
  - Example: 3 tokens at 40 cents → `3 * 40 * 10_000 = 1_200_000` raw USDC = $1.20

### Strike Prices (Pyth format)
- `int64`, exponent -5: `$256.00 = 25_600_000`
- To display: `strikePrice / 100_000`
- To construct: `dollarAmount * 100_000`

### Tickers
- Stored as `bytes32` right-padded with null bytes
- In ethers.js v6: `ethers.encodeBytes32String("AAPL")` to encode, `ethers.decodeBytes32String(bytes32)` to decode
- The bytes32 representation for "AAPL" is `0x4141504c000000000000000000000000000000000000000000000000000000`

### Token IDs (ERC1155)
The contract derives two token IDs per market:
```javascript
// Yes token ID
const yesId = BigInt(marketId); // marketId is bytes32, treat as uint256

// No token ID  
const noId = BigInt(ethers.keccak256(
  ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'string'], [marketId, "NO"])
));
```

Both can also be read via view functions (no gas):
```javascript
const yesId = await market.yesTokenId(marketId);
const noId  = await market.noTokenId(marketId);
```

### Market ID Derivation
```javascript
const marketId = ethers.keccak256(
  ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'int64', 'uint64'],
    [tickerBytes32, strikePrice, expiryTimestamp]
  )
);
```

### OrderBookLib.Side Enum
```javascript
const Side = { BID: 0, ASK: 1 };
```
- `BID` = resting buy order for Yes tokens (buyer locked USDC)
- `ASK` = resting sell order for Yes tokens (seller locked Yes tokens)

---

## MAG7 Pyth Feed IDs

These are needed to fetch live prices from Hermes.

| Ticker | Feed ID |
|---|---|
| AAPL | `0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688` |
| MSFT | `0xd0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1` |
| NVDA | `0x61c4ca5b9731a79e285a01e24432d57d89f0ecdd4cd7828196ca8992d5eafef6` |
| GOOGL | `0xe65ff435be42630439c96396653a342829e877e2aafaeaf1a10d0ee5fd2cf3f2` |
| AMZN | `0x82c59e36a8e0247e15283748d6cd51f5fa1019d73fbf3ab6d927e17d9e357a7f` |
| META | `0x78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe` |
| TSLA | `0x42676a595d0099c381687124805c8bb22c75424dffcaa55e3dc6549854ebe20a` |

---

## 1. Getting Live Prices from Pyth Hermes

Prices are fetched directly from the Pyth Hermes REST API — no API key required.

### Fetch latest prices for all MAG7

```
GET https://hermes.pyth.network/v2/updates/price/latest
  ?ids[]=0x49f6b65cb1...  (AAPL)
  &ids[]=0xd0ca23c1...    (MSFT)
  ...all 7 feed IDs...
  &parsed=true
  &encoding=base64
```

### Response structure

```json
{
  "binary": {
    "encoding": "base64",
    "data": ["<base64-encoded VAA bytes per feed>"]
  },
  "parsed": [
    {
      "id": "49f6b65cb1...",
      "price": {
        "price": "25600000",
        "conf": "50000",
        "expo": -5,
        "publish_time": 1741564800
      },
      "ema_price": { ... }
    }
  ]
}
```

### Displaying the price

```javascript
const rawPrice = BigInt(parsed[i].price.price);  // e.g. 25600000n
const expo = parsed[i].price.expo;               // always -5 for equity feeds
const displayPrice = Number(rawPrice) / 100_000; // → 256.00
```

### Fetch historical price (for settlement window display)

```
GET https://hermes.pyth.network/v2/updates/price/{unix_timestamp}
  ?ids[]=<feedId>
  &parsed=true
```

Replace `{unix_timestamp}` with the market's `expiryTimestamp`. This returns the price closest to that timestamp — used to show what settlement price will likely be.

---

## 2. USDC — Balance, Approval, and Testnet Minting

### Read user USDC balance

```javascript
const usdc = new ethers.Contract(USDC_ADDRESS, usdcAbi, provider);
const balance = await usdc.balanceOf(userAddress); // uint256, 6 decimals
// Display: Number(balance) / 1_000_000
```

### Check existing allowance

```javascript
const allowance = await usdc.allowance(userAddress, MARKET_ADDRESS);
```

### Set USDC approval

The user must approve the MeridianMarket contract to spend their USDC before any trading function. The contract uses `safeTransferFrom` internally.

Minimum amounts required per operation:
- `mintPair`: `quantity * 1_000_000` (1 USDC per pair)
- `placeOrder(BID)`: `quantity * priceCents * 10_000`
- `buyNoMarket`: `quantity * 1_000_000` (1 USDC per pair)
- `buyNoLimit`: `quantity * 1_000_000` (1 USDC per pair)
- `sellNoMarket`: `noAmount * maxYesBuyPrice * 10_000`

Approve max uint256 for a one-time approval (common pattern):
```javascript
const tx = await usdc.connect(signer).approve(
  MARKET_ADDRESS,
  ethers.MaxUint256
);
await tx.wait();
```

### Testnet: Mint MockUSDC (no restrictions)

```javascript
const usdc = new ethers.Contract(USDC_ADDRESS, usdcAbi, signer);
const tx = await usdc.mint(
  userAddress,
  10_000_000n  // 10 USDC
);
await tx.wait();
```

The `mint(address to, uint256 amount)` function has no access control on testnet.

---

## 3. Market Discovery

### Read total market count

```javascript
const market = new ethers.Contract(MARKET_ADDRESS, marketAbi, provider);
const count = await market.marketCount(); // uint256
```

### Fetch recent markets

```javascript
// Returns the `count` most recently created markets, oldest first within the slice
const markets = await market.getMarkets(count); // MarketView[]
```

`MarketView` struct returned as an array of tuples in ethers.js:

| Field | Solidity type | JS type | Notes |
|---|---|---|---|
| `marketId` | `bytes32` | `string` (hex) | Use as Yes token ID via `BigInt(marketId)` |
| `ticker` | `bytes32` | `string` (hex) | Decode with `ethers.decodeBytes32String` |
| `strikePrice` | `int64` | `bigint` | Divide by 100_000 for dollar display |
| `expiryTimestamp` | `uint64` | `bigint` | Unix seconds |
| `settled` | `bool` | `boolean` | |
| `yesWins` | `bool` | `boolean` | Only meaningful when `settled == true` |
| `vaultBalance` | `uint256` | `bigint` | USDC locked (6 decimals) |
| `feeBpsSnapshot` | `uint16` | `number` | Fee rate at creation time, in basis points |

### Access full market struct

For fields not in `MarketView` (e.g. `totalPairsMinted`, `pythFeedId`):

```javascript
const m = await market.markets(marketId);
// Returns tuple in ABI order:
// [ticker, strikePrice, pythFeedId, expiryTimestamp, totalPairsMinted, vaultBalance, feeBpsSnapshot, settled, yesWins]
const totalPairsMinted = m[4];
const pythFeedId       = m[2];
```

### Read individual allMarketIds

```javascript
const marketId = await market.allMarketIds(index); // bytes32
```

---

## 4. User Token Balances (ERC1155)

`MeridianMarket` is ERC1155. Yes and No tokens for each market are distinct token IDs.

### Get Yes and No token IDs for a market

```javascript
const yesId = await market.yesTokenId(marketId); // uint256
const noId  = await market.noTokenId(marketId);  // uint256
```

Or compute locally (no RPC call):
```javascript
const yesId = BigInt(marketId);
const noId  = BigInt(ethers.keccak256(
  ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'string'], [marketId, "NO"])
));
```

### Get user balance for one market

```javascript
const yesBalance = await market.balanceOf(userAddress, yesId); // uint256
const noBalance  = await market.balanceOf(userAddress, noId);  // uint256
```

### Get user balances for multiple markets (batch)

```javascript
const accounts = [userAddress, userAddress, userAddress, userAddress];
const ids      = [yes1, no1, yes2, no2];
const balances = await market.balanceOfBatch(accounts, ids);
// returns uint256[] in the same order
```

### ERC1155 Approval for Yes/No token transfers

Some operations (`placeOrder(ASK)`, `sellNoMarket`) require the contract to transfer the user's tokens. The user must call:
```javascript
const tx = await market.connect(signer).setApprovalForAll(MARKET_ADDRESS, true);
await tx.wait();
```

Check current approval:
```javascript
const approved = await market.isApprovedForAll(userAddress, MARKET_ADDRESS);
```

---

## 5. Contract-Level Token and Vault Information

### Total pairs outstanding per market

`totalPairsMinted` in the Market struct tracks outstanding Yes/No pairs. It increments on each `mintPair`/`buyNoMarket`/`buyNoLimit` call and decrements when `sellNoMarket` redeems pairs pre-settlement.

```javascript
const m = await market.markets(marketId);
const totalPairsMinted = m[4]; // uint256
```

### USDC locked in contract for a market

```javascript
const m = await market.markets(marketId);
const vaultBalance = m[5]; // uint256, 6-decimal USDC
```

### Yes tokens currently locked in contract (ASK order collateral)

```javascript
const yesId = BigInt(marketId);
const contractYesBalance = await market.balanceOf(MARKET_ADDRESS, yesId);
```

These are Yes tokens posted by ASK makers that are held in escrow by the contract while their orders are resting.

---

## 6. Order Book

### Best bid and ask prices

```javascript
const bestBid = await market.bestBid(marketId); // uint8 (cents, 0 = no bids)
const bestAsk = await market.bestAsk(marketId); // uint8 (cents, 0 = no asks)
```

Returns 0 if there are no resting orders on that side.

### Depth at a specific price level

```javascript
const qty = await market.depthAt(
  marketId,
  0,    // Side.BID = 0, Side.ASK = 1
  50    // priceCents: 1–99
); // uint128 — total resting quantity (whole Yes tokens)
```

### Full order book (all 99 levels)

There is no single function to fetch all levels. Use multicall to batch 198 calls (99 bid levels + 99 ask levels):

```javascript
// Using ethers.js multicall pattern or a multicall contract:
const calls = [];
for (let price = 1; price <= 99; price++) {
  calls.push(market.depthAt(marketId, 0, price)); // BID
  calls.push(market.depthAt(marketId, 1, price)); // ASK
}
const results = await Promise.all(calls);

const bids = {}; // price (1-99) → qty
const asks = {};
for (let price = 1; price <= 99; price++) {
  bids[price] = results[(price - 1) * 2];
  asks[price] = results[(price - 1) * 2 + 1];
}
```

Filter out zero-quantity levels when displaying. A price level with qty=0 has no resting orders.

### Order book display conventions

- BID side: sorted descending by price (highest bid first)
- ASK side: sorted ascending by price (lowest ask first)
- Quantities are in whole Yes tokens (integers)
- To display USDC value at a level: `qty * priceCents * 10_000` raw USDC units

### Tracking orders via events

Listen for `OrderPlaced` and `OrderCancelled` events to maintain a local order book state. There is no fill event emitted, so `depthAt` calls are the canonical source of truth.

```javascript
// OrderPlaced
market.on("OrderPlaced", (marketId, orderId, owner, side, priceCents, quantity) => {
  // side: 0=BID, 1=ASK
});

// OrderCancelled
market.on("OrderCancelled", (orderId, owner, remainingQty) => {
  // orderId maps back to market via orderMarket(orderId) if needed
});
```

### Look up a specific order

```javascript
const ownerAddr     = await market.orderOwner(orderId);     // address
const side          = await market.orderSide(orderId);      // 0=BID, 1=ASK
const priceCents    = await market.orderPriceCents(orderId); // uint8
const marketIdForOrder = await market.orderMarket(orderId); // bytes32
```

A non-existent or fully filled/cancelled order returns `address(0)` for `orderOwner`.

---

## 7. Trading Functions

All trading functions revert if the market is paused. Check paused state:
```javascript
const paused = await market.paused(); // bool (inherited from OpenZeppelin Pausable)
```

### 7a. Mint Pair

Deposit `quantity` USDC, receive `quantity` Yes tokens + `quantity` No tokens in one transaction.

**Pre-requisite**: USDC approval ≥ `quantity * 1_000_000`

```javascript
function mintPair(bytes32 marketId, uint128 quantity) external
```

```javascript
// Mint 5 pairs in one call (costs 5 USDC, receive 5 Yes + 5 No)
const tx = await market.connect(signer).mintPair(marketId, 5n);
const receipt = await tx.wait();
// Emits: PairMinted(marketId, user, quantity)
```

Reverts:
- `MarketNotFound` — marketId doesn't exist
- `MarketExpired` — past `expiryTimestamp`
- `ZeroQuantity` — quantity must be > 0

### 7b. Place Limit Order (placeOrder)

Place a BID (buy Yes) or ASK (sell Yes) limit order. Immediately crosses resting orders where possible; remainder rests unless `isIOC = true`.

```javascript
function placeOrder(
  bytes32 marketId,
  uint8 side,       // 0=BID, 1=ASK
  uint8 priceCents, // 1–99
  uint128 quantity, // whole Yes tokens
  bool isIOC        // true = cancel unfilled remainder immediately
) external returns (uint256 orderId)
```

**Pre-requisites:**
- BID: USDC approval ≥ `quantity * priceCents * 10_000`
- ASK: ERC1155 `setApprovalForAll` AND sufficient Yes token balance

```javascript
// Example: place a bid for 5 Yes tokens at 45 cents
const tx = await market.connect(signer).placeOrder(
  marketId,
  0,         // BID
  45,        // $0.45 per Yes token
  5n,        // 5 tokens
  false      // post remainder as resting order
);
const receipt = await tx.wait();
// Returns orderId — read from OrderPlaced event if needed
// Emits: OrderPlaced(marketId, orderId, owner, side, priceCents, quantity)
```

The returned `orderId` is only accessible from the receipt logs. Parse the `OrderPlaced` event:
```javascript
const iface = new ethers.Interface(marketAbi);
for (const log of receipt.logs) {
  const parsed = iface.parseLog(log);
  if (parsed?.name === "OrderPlaced") {
    const orderId = parsed.args[1]; // uint256
  }
}
```

USDC overpayment on BID is automatically refunded in the same transaction (if you bid $0.45 but resting asks were at $0.40).

Reverts:
- `MarketNotFound`, `MarketExpired`, `ZeroQuantity`
- `InvalidPrice` — priceCents outside 1–99
- `SelfTradeNotAllowed` — your order would match your own resting order

### 7c. Cancel Order

```javascript
function cancelOrder(uint256 orderId) external
function bulkCancelOrders(uint256[] calldata orderIds) external
```

```javascript
// Single cancel
const tx = await market.connect(signer).cancelOrder(orderId);
await tx.wait();
// Emits: OrderCancelled(orderId, owner, remainingQty)
// Collateral is automatically returned:
//   BID: locked USDC refunded
//   ASK: locked Yes tokens returned
```

```javascript
// Bulk cancel
const tx = await market.connect(signer).bulkCancelOrders([id1, id2, id3]);
await tx.wait();
// Orders not owned by msg.sender are silently skipped (no revert)
```

Reverts:
- `OrderNotOwned` — caller does not own the order

### 7d. Buy No (Market Order)

Atomic: mint pair, immediately sell Yes at market price, keep No.

```javascript
function buyNoMarket(
  bytes32 marketId,
  uint128 quantity,           // number of No tokens to acquire (pairs to mint)
  uint128 minYesSaleProceeds, // minimum total USDC proceeds in cents across all Yes sales — pass 0 to accept any price
  uint8 maxFills              // gas limit on number of order book fills, max 100
) external
```

**Pre-requisite**: USDC approval ≥ `quantity * 1_000_000`

`minYesSaleProceeds` is in the same units as `usdcTradedCents`: the total sum of `fillQty * priceCents` across all fills. For 3 Yes tokens each sold at or above 40 cents, pass `120` (3 × 40). Pass `0` to accept any price.

```javascript
// Buy 3 No tokens at market — mint 3 pairs, sell all 3 Yes
const tx = await market.connect(signer).buyNoMarket(
  marketId,
  3n,   // quantity: acquire 3 No tokens
  100n, // minYesSaleProceeds: at least 100 cents total (e.g. 3 × 34 cents)
  10    // fill up to 10 resting bids
);
await tx.wait();
```

Behavior:
- Mints `quantity` pairs (costs `quantity` USDC)
- Sells all `quantity` Yes tokens against resting BIDs at market price (IOC)
- If total proceeds < `minYesSaleProceeds`: reverts `InsufficientProceed`
- Unfilled Yes (if maxFills hit before full fill): burned, 1 USDC refunded per unfilled token
- Net cost: `quantity * 1 USDC - totalYesSaleProceeds`

Reverts:
- `MarketNotFound`, `MarketExpired`
- `InsufficientProceed(got, minExpected)` — proceeds below `minYesSaleProceeds`

### 7e. Buy No (Limit Order)

Atomic: mint pair, post Yes as a resting limit ASK, keep No immediately.

```javascript
function buyNoLimit(
  bytes32 marketId,
  uint128 quantity,        // number of No tokens to acquire (pairs to mint)
  uint8 limitYesSalePrice  // 1–99 cents: the ASK price for all Yes tokens
) external
```

**Pre-requisite**: USDC approval ≥ `quantity * 1_000_000`

```javascript
// Acquire 5 No tokens via limit order
const tx = await market.connect(signer).buyNoLimit(
  marketId,
  5n, // quantity: mint 5 pairs, post 5 Yes as a single ASK
  60  // post all 5 Yes at $0.60 each; caller keeps all 5 No immediately
);
await tx.wait();
```

Behavior:
- Mints `quantity` pairs (costs `quantity` USDC)
- All `quantity` Yes tokens are locked in the contract as a **single** resting ASK order at `limitYesSalePrice`
- All `quantity` No tokens are sent to caller immediately
- When the ASK fills, caller receives `filled * limitYesSalePrice * 10_000` USDC
- If the ASK is cancelled, the remaining Yes tokens are returned to the caller

**Important**: the resulting ASK order is owned by `msg.sender`, not the contract. The caller must track the `orderId` from the `OrderPlaced` event to cancel it later.

### 7f. Sell No (Market Order)

Atomic: buy Yes at market, immediately redeem Yes+No pair for $1 USDC (pre-settlement).

```javascript
function sellNoMarket(
  bytes32 marketId,
  uint128 noAmount,       // number of No tokens to sell
  uint8 maxYesBuyPrice,   // maximum price in cents to pay for Yes (1–99)
  uint8 maxFills          // gas limit on fills, max 100
) external
```

**Pre-requisites:**
- ERC1155 `setApprovalForAll` for No tokens
- USDC approval ≥ `noAmount * maxYesBuyPrice * 10_000`

```javascript
const tx = await market.connect(signer).sellNoMarket(
  marketId,
  1n,   // sell 1 No token
  60,   // buy Yes for at most 60 cents
  10    // up to 10 fills
);
await tx.wait();
```

Behavior:
- Transfers `noAmount` No tokens from caller to contract
- Locks `noAmount * maxYesBuyPrice * 10_000` USDC from caller
- Buys Yes from resting ASKs up to `maxYesBuyPrice`
- Each filled Yes+No pair is burned; caller receives 1 USDC per pair
- Unfilled No tokens are returned to caller
- Unused USDC is refunded to caller
- Net result: if 1 pair filled at Yes price 40 cents → caller receives $1 and paid $0.40 → net $0.60 received

### 7g. Redeem After Settlement

```javascript
function redeem(bytes32 marketId, uint256 quantity) external
```

**Pre-requisite**: market must be settled (`settled == true`)

```javascript
const tx = await market.connect(signer).redeem(marketId, quantity);
await tx.wait();
// Emits: Redeemed(marketId, user, quantity, payout)
```

**Important redemption logic** (read from source):
- The contract checks which token the caller holds and prioritizes the winning token:
  - If `yesWins == true` AND caller holds Yes → redeems Yes at `1e6 - fee` per token
  - If `yesWins == true` AND caller holds No → redeems No at `0` per token (burn only)
  - If `yesWins == false` AND caller holds No → redeems No at `1e6 - fee` per token
  - If `yesWins == false` AND caller holds Yes → redeems Yes at `0` per token (burn only)
- If caller holds both Yes and No, only the winning token is redeemed in one call. A second call is needed to burn the losing tokens (returns 0 USDC)
- Fee deducted from winners: `payout = quantity * 1e6 - (quantity * 1e6 * feeBpsSnapshot / 10_000)`
- Fee is sent directly to `feeRecipient` in the same transaction
- Losing token redemption (`payout = 0`) still burns the tokens

Reverts:
- `MarketNotSettled` — market not yet settled
- `ZeroQuantity`
- `"Insufficient tokens"` — caller does not hold enough of the token being redeemed

---

## 8. Contract State Reads (Protocol Config)

```javascript
const feeBps     = await market.feeBps();        // uint16 (basis points, e.g. 50 = 0.5%)
const feeRecipient = await market.feeRecipient(); // address
const usdcAddr   = await market.usdc();          // address
const pythAddr   = await market.pyth();          // address
const paused     = await market.paused();        // bool
const maxConfBps = await market.maxConfBps();    // uint16 (default 100 = 1%)
```

---

## 9. Event Reference

All events emitted by MeridianMarket (subscribe with `contract.on(eventName, handler)`):

| Event | Parameters | Notes |
|---|---|---|
| `MarketCreated` | `marketId, ticker, strikePrice, expiryTimestamp, pythFeedId` | `marketId` and `ticker` are indexed |
| `PairMinted` | `marketId, user, quantity` | `marketId` and `user` indexed |
| `OrderPlaced` | `marketId, orderId, owner, side, priceCents, quantity` | All three are indexed |
| `OrderCancelled` | `orderId, owner, remainingQty` | `orderId` and `owner` indexed |
| `MarketSettled` | `marketId, yesWins, settlePrice, publishTime` | `marketId` indexed |
| `AdminSettled` | `marketId, yesWins, manualPrice` | `marketId` indexed |
| `Redeemed` | `marketId, user, quantity, payout` | `marketId` and `user` indexed |
| `FeeUpdated` | `oldBps, newBps` | |
| `FeeRecipientUpdated` | `oldRecipient, newRecipient` | |
| `SupportedFeedSet` | `ticker, feedId, enabled` | `ticker` indexed |

### Filter by market

```javascript
const filter = market.filters.OrderPlaced(marketId);
const events = await market.queryFilter(filter, fromBlock, toBlock);
```

---

## 10. ERC1155 Token Metadata (On-Chain)

Token metadata is fully on-chain. No IPFS or external server.

```javascript
const uri = await market.uri(tokenId);
// Returns: "data:application/json;base64,<base64-encoded JSON>"
const json = JSON.parse(atob(uri.split(',')[1]));
// json.name: e.g. "AAPL YES > $256"
// json.description: human-readable market description
// json.attributes: array of {trait_type, value} — Ticker, Token Type, Strike, Expiry, Status, Outcome
```

---

## 11. Common Error Signatures

These revert with custom errors. Decode them from transaction receipts to show user-friendly messages.

| Error | Likely cause |
|---|---|
| `MarketNotFound(bytes32)` | Invalid or non-existent marketId |
| `MarketExpired(bytes32)` | Market has passed its expiry |
| `MarketNotSettled(bytes32)` | Trying to redeem before settlement |
| `AlreadySettled(bytes32)` | Settlement called twice |
| `ZeroQuantity()` | Quantity parameter is 0 |
| `OrderNotOwned(uint256)` | Trying to cancel someone else's order |
| `InsufficientProceed(uint128 got, uint128 minExpected)` | buyNoMarket proceeds below slippage threshold |
| `InvalidPrice(uint8)` | priceCents outside 1–99 |
| `SelfTradeNotAllowed()` | Order would fill against the same address |

---

## 12. Recommended Read Pattern on Page Load

```
1. Call marketCount() → total
2. Call getMarkets(min(total, 490)) → recent markets (7 stocks × 7 strikes × 10 days)
3. For each market:
   a. Decode ticker (decodeBytes32String), format strike (/ 100_000), format expiry (Unix → date)
   b. Group by ticker+expiry for display
4. For connected wallet:
   a. Call usdc.balanceOf(user)
   b. Call usdc.allowance(user, MARKET_ADDRESS)
   c. Call market.isApprovedForAll(user, MARKET_ADDRESS)
   d. For visible markets: balanceOfBatch([user, user], [yesId, noId])
5. For selected market order book:
   a. Call bestBid(marketId) and bestAsk(marketId)
   b. Call depthAt for all 99 levels (batch via Promise.all or multicall)
6. Subscribe to OrderPlaced and OrderCancelled events for live order book updates
7. Subscribe to MarketSettled to update market status without polling
```
