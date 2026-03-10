# Oracle Research: Equity Price Feeds for Binary Options MVP

## Table of Contents

- [Executive Summary](#executive-summary)
- [Project Context](#project-context)
- [Pyth Core: Confirmed Equity Feed Availability](#pyth-core-confirmed-equity-feed-availability)
- [Testnet Strategy: Mock Oracle on Base Sepolia](#testnet-strategy-mock-oracle-on-base-sepolia)
- [Pyth Core Integration Guide](#pyth-core-integration-guide)
- [L2 Sequencer / Uptime Considerations](#l2-sequencer--uptime-considerations)
- [Pyth vs Chainlink: Detailed Comparison](#pyth-vs-chainlink-detailed-comparison)
- [Appendix A: Other Oracles Investigated](#appendix-a-other-oracles-investigated)
- [Appendix B: Sources](#appendix-b-sources)

---

## Executive Summary

We need MAG7 equity price feeds (AAPL, MSFT, NVDA, GOOGL, AMZN, META, TSLA) for a binary options market MVP on Base.

**Key findings:**

1. **Pyth Core has live MAG7 equity data on Base mainnet** -- confirmed via direct contract calls on 2026-03-06. All 7 feeds return valid prices.
2. **No oracle provides equity data on any EVM testnet.** Pyth Core (Base Sepolia), Pyth Pro/Lazer, Supra, and Chainlink were all tested -- equity feeds are either `PriceFeedNotFound`, return zeros, or are marked `coming_soon`.
3. **We will build on Base Sepolia with a mock Pyth oracle**, matching the `IPyth` interface so the swap to mainnet is a single address change.
4. **Pyth is recommended over Chainlink** for this use case due to its pull-based model (ideal for options settlement), first-mover equity coverage, confidence intervals, and cost efficiency on L2.

---

## Project Context

- **Product:** Binary options market for MAG7 equities
- **Testnet:** Base Sepolia
- **Mainnet target:** Base
- **Oracle (mainnet):** Pyth Core at `0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a`
- **Oracle (testnet):** Mock Pyth contract (to be deployed on Base Sepolia)

---

## Pyth Core: Confirmed Equity Feed Availability

### Verified on Base Mainnet (2026-03-06)

All MAG7 feeds were confirmed live via `getPriceUnsafe()` on the Pyth Core contract on Base:

| Ticker | Feed ID | Price (at check) | Exponent |
|--------|---------|-------------------|----------|
| **AAPL** | `0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688` | $256.57 | -5 |
| **MSFT** | `0xd0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1` | $410.33 | -5 |
| **NVDA** | `0x61c4ca5b9731a79e285a01e24432d57d89f0ecdd4cd7828196ca8992d5eafef6` | $179.79 | -5 |
| **GOOGL** | `0xe65ff435be42630439c96396653a342829e877e2aafaeaf1a10d0ee5fd2cf3f2` | $298.65 | -5 |
| **AMZN** | `0x82c59e36a8e0247e15283748d6cd51f5fa1019d73fbf3ab6d927e17d9e357a7f` | $215.02 | -5 |
| **META** | `0x78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe` | $645.27 | -5 |
| **TSLA** | `0x42676a595d0099c381687124805c8bb22c75424dffcaa55e3dc6549854ebe20a` | $398.16 | -5 |

### Verification Commands

```bash
# Check any feed (example: AAPL)
cast call 0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a \
  "getPriceUnsafe(bytes32)(int64,uint64,int32,uint256)" \
  0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688 \
  --rpc-url https://mainnet.base.org

# Returns: price, confidence, exponent, publishTimestamp
# Actual price = price * 10^exponent
```

### Also Confirmed on Monad Testnet

AAPL data was confirmed present on the Pyth Core contract on Monad testnet (`0x2880aB155794e7179c9eE2e38200202908C17B43`), though we are not targeting Monad for this project.

### Base Sepolia: PriceFeedNotFound

On Base Sepolia, `getPrice()` reverts with `0x14aebe68` (`PriceFeedNotFound`) for all equity feed IDs. Pyth does not push equity data to testnets.

---

## Testnet Strategy: Mock Oracle on Base Sepolia

Since no oracle provides equity data on any EVM testnet, we will deploy a mock oracle that implements the same `IPyth` interface used on mainnet.

### Design Principles

1. **Match the `IPyth` interface exactly** so consuming contracts need zero changes when switching to mainnet.
2. **Maintain the same `PythStructs.Price` return type** (price, conf, expo, publishTime).
3. **Expose an owner-controlled `setPrice()`** for a backend service to push real prices.
4. **Preserve the update fee mechanism** so the integration flow is identical.

### Mock Oracle Contract

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title MockPyth
/// @notice A mock Pyth oracle for testnet development. Implements the subset
///         of IPyth used by consumers so the mainnet migration is a single
///         address swap.
contract MockPyth is Ownable {
    mapping(bytes32 => PythStructs.Price) private prices;
    mapping(bytes32 => bool) private feedExists;
    uint256 public updateFee;
    uint256 public validTimePeriod;

    event PriceUpdated(bytes32 indexed feedId, int64 price, uint64 conf, int32 expo, uint publishTime);

    constructor(uint256 _updateFee, uint256 _validTimePeriod) Ownable(msg.sender) {
        updateFee = _updateFee;
        validTimePeriod = _validTimePeriod;
    }

    // ---------------------------------------------------------------
    // Owner-only: set prices (called by backend service)
    // ---------------------------------------------------------------

    /// @notice Set the price for a single feed. Called by the price-pusher service.
    function setPrice(
        bytes32 feedId,
        int64 price,
        uint64 conf,
        int32 expo,
        uint publishTime
    ) external onlyOwner {
        prices[feedId] = PythStructs.Price({
            price: price,
            conf: conf,
            expo: expo,
            publishTime: publishTime
        });
        feedExists[feedId] = true;
        emit PriceUpdated(feedId, price, conf, expo, publishTime);
    }

    /// @notice Batch-set prices for multiple feeds.
    function setBatchPrices(
        bytes32[] calldata feedIds,
        int64[] calldata _prices,
        uint64[] calldata confs,
        int32[] calldata expos,
        uint[] calldata publishTimes
    ) external onlyOwner {
        require(feedIds.length == _prices.length, "length mismatch");
        for (uint i = 0; i < feedIds.length; i++) {
            prices[feedIds[i]] = PythStructs.Price({
                price: _prices[i],
                conf: confs[i],
                expo: expos[i],
                publishTime: publishTimes[i]
            });
            feedExists[feedIds[i]] = true;
            emit PriceUpdated(feedIds[i], _prices[i], confs[i], expos[i], publishTimes[i]);
        }
    }

    // ---------------------------------------------------------------
    // IPyth-compatible read functions
    // ---------------------------------------------------------------

    function getPriceUnsafe(bytes32 id) external view returns (PythStructs.Price memory) {
        require(feedExists[id], "PriceFeedNotFound");
        return prices[id];
    }

    function getPriceNoOlderThan(bytes32 id, uint age) external view returns (PythStructs.Price memory) {
        require(feedExists[id], "PriceFeedNotFound");
        PythStructs.Price memory p = prices[id];
        require(block.timestamp - p.publishTime <= age, "StalePrice");
        return p;
    }

    function getEmaPriceUnsafe(bytes32 id) external view returns (PythStructs.Price memory) {
        require(feedExists[id], "PriceFeedNotFound");
        return prices[id]; // Mock: EMA == spot
    }

    function getEmaPriceNoOlderThan(bytes32 id, uint age) external view returns (PythStructs.Price memory) {
        require(feedExists[id], "PriceFeedNotFound");
        PythStructs.Price memory p = prices[id];
        require(block.timestamp - p.publishTime <= age, "StalePrice");
        return p;
    }

    function priceFeedExists(bytes32 id) external view returns (bool) {
        return feedExists[id];
    }

    function getValidTimePeriod() external view returns (uint) {
        return validTimePeriod;
    }

    // ---------------------------------------------------------------
    // IPyth-compatible update functions (no-ops on mock, but preserve
    // the calling convention so consumer contracts don't change)
    // ---------------------------------------------------------------

    function getUpdateFee(bytes[] calldata) external view returns (uint) {
        return updateFee;
    }

    function updatePriceFeeds(bytes[] calldata) external payable {
        require(msg.value >= updateFee, "InsufficientFee");
        // No-op: prices are set by owner via setPrice()
    }

    // ---------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------

    function setUpdateFee(uint256 _fee) external onlyOwner {
        updateFee = _fee;
    }

    function setValidTimePeriod(uint256 _period) external onlyOwner {
        validTimePeriod = _period;
    }

    function withdraw() external onlyOwner {
        payable(owner()).transfer(address(this).balance);
    }
}
```

### Price Pusher Service

A simple backend service to fetch real prices and push them to the mock oracle:

```typescript
// price-pusher.ts
import { ethers } from "ethers";

const MOCK_ORACLE_ADDRESS = "0x..."; // Deployed MockPyth on Base Sepolia
const OWNER_PRIVATE_KEY = process.env.OWNER_PRIVATE_KEY!;
const RPC_URL = "https://sepolia.base.org";

// MAG7 feed IDs (same as mainnet Pyth)
const FEEDS = {
  AAPL: "0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
  MSFT: "0xd0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1",
  NVDA: "0x61c4ca5b9731a79e285a01e24432d57d89f0ecdd4cd7828196ca8992d5eafef6",
  GOOGL: "0xe65ff435be42630439c96396653a342829e877e2aafaeaf1a10d0ee5fd2cf3f2",
  AMZN: "0x82c59e36a8e0247e15283748d6cd51f5fa1019d73fbf3ab6d927e17d9e357a7f",
  META: "0x78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe",
  TSLA: "0x42676a595d0099c381687124805c8bb22c75424dffcaa55e3dc6549854ebe20a",
};

const MOCK_ABI = [
  "function setBatchPrices(bytes32[],int64[],uint64[],int32[],uint256[]) external",
];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(OWNER_PRIVATE_KEY, provider);
const oracle = new ethers.Contract(MOCK_ORACLE_ADDRESS, MOCK_ABI, wallet);

// Fetch real prices from Pyth Hermes (free, no auth required)
async function fetchPrices(): Promise<Map<string, { price: bigint; conf: bigint; expo: number }>> {
  const ids = Object.values(FEEDS).map((id) => `ids[]=${id}`).join("&");
  const url = `https://hermes.pyth.network/v2/updates/price/latest?${ids}`;
  const resp = await fetch(url);
  const data = await resp.json();

  const result = new Map();
  for (const parsed of data.parsed) {
    result.set(`0x${parsed.id}`, {
      price: BigInt(parsed.price.price),
      conf: BigInt(parsed.price.conf),
      expo: parsed.price.expo,
    });
  }
  return result;
}

async function pushPrices() {
  const priceData = await fetchPrices();
  const now = Math.floor(Date.now() / 1000);

  const feedIds: string[] = [];
  const prices: bigint[] = [];
  const confs: bigint[] = [];
  const expos: number[] = [];
  const timestamps: number[] = [];

  for (const [ticker, feedId] of Object.entries(FEEDS)) {
    const data = priceData.get(feedId);
    if (!data) {
      console.warn(`No data for ${ticker}`);
      continue;
    }
    feedIds.push(feedId);
    prices.push(data.price);
    confs.push(data.conf);
    expos.push(data.expo);
    timestamps.push(now);
  }

  const tx = await oracle.setBatchPrices(feedIds, prices, confs, expos, timestamps);
  console.log(`Pushed ${feedIds.length} prices, tx: ${tx.hash}`);
  await tx.wait();
}

// Push every 1 hour during market hours
async function main() {
  console.log("Starting price pusher...");
  while (true) {
    try {
      await pushPrices();
    } catch (err) {
      console.error("Push failed:", err);
    }
    await new Promise((r) => setTimeout(r, 3_600_000));
  }
}

main();
```

### Mainnet Migration

When moving to mainnet, the only change needed is the oracle address in your consuming contracts:

```solidity
// Testnet
IPyth pyth = IPyth(MOCK_ORACLE_ADDRESS);

// Mainnet -- just swap the address
IPyth pyth = IPyth(0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a);
```

The `updatePriceFeeds` call on mainnet will use real Hermes data instead of being a no-op. Your frontend/keeper will need to fetch from Hermes and pass the `priceUpdate` bytes -- but the contract interface is identical.

---

## Pyth Core Integration Guide

### How the Pull Model Works

Pyth is a **pull oracle**. Prices are NOT automatically pushed on-chain. The flow is:

1. **Publishers** (120+ institutions: Jane Street, CBOE, Binance, Wintermute, etc.) submit prices to **Pythnet** (a Solana-based appchain) every 400ms.
2. Pythnet aggregates publisher data into a single price + confidence interval.
3. **Hermes** (off-chain web service) makes these aggregated prices available via REST API and SSE streaming.
4. **Your contract's caller** fetches a signed price update from Hermes, submits it on-chain via `updatePriceFeeds()`, then reads the price.

```
Publisher -> Pythnet -> Hermes API -> Your Frontend/Keeper -> updatePriceFeeds() -> getPriceNoOlderThan()
```

### Key Solidity Interface

```solidity
import "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";

// The Price struct
struct Price {
    int64 price;       // Price value
    uint64 conf;       // Confidence interval (95%)
    int32 expo;        // Exponent -- actual price = price * 10^expo
    uint publishTime;  // Unix timestamp of publication
}
```

### Core Functions

| Function | Description |
|----------|-------------|
| `getUpdateFee(bytes[])` | Returns the fee (in wei) required to submit price updates |
| `updatePriceFeeds(bytes[])` | Submit signed price data on-chain (payable, must send fee) |
| `getPriceNoOlderThan(bytes32, uint)` | Read price with staleness check -- **recommended for production** |
| `getPriceUnsafe(bytes32)` | Read price without staleness check -- **do not use in production** |
| `getEmaPriceNoOlderThan(bytes32, uint)` | Read EMA (smoothed) price with staleness check |
| `parsePriceFeedUpdates(bytes[], bytes32[], uint64, uint64)` | Parse price at a specific timestamp without updating on-chain state -- **critical for delayed settlement** |
| `priceFeedExists(bytes32)` | Check if a feed has ever been initialized |

### Complete Integration Pattern

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";

contract BinaryOptionsMarket {
    IPyth public immutable pyth;

    uint256 public constant MAX_STALENESS = 60;      // 60 seconds
    uint256 public constant MAX_CONF_BPS = 200;      // 2% max confidence/price ratio

    constructor(address _pyth) {
        pyth = IPyth(_pyth);
    }

    function settleOption(
        bytes[] calldata priceUpdate,
        bytes32 priceFeedId,
        uint256 optionId
    ) external payable {
        // 1. Calculate and pay the update fee
        uint fee = pyth.getUpdateFee(priceUpdate);
        pyth.updatePriceFeeds{value: fee}(priceUpdate);

        // 2. Read price with staleness check
        PythStructs.Price memory price = pyth.getPriceNoOlderThan(
            priceFeedId,
            MAX_STALENESS
        );

        // 3. Validate confidence interval
        uint256 absPrice = uint256(uint64(price.price > 0 ? price.price : -price.price));
        uint256 confRatio = (uint256(price.conf) * 10000) / absPrice;
        require(confRatio <= MAX_CONF_BPS, "Price confidence too wide");

        // 4. Convert to actual price: price.price * 10^price.expo
        //    For MAG7 feeds, expo = -5, so 25657249 * 10^-5 = $256.57249

        // 5. Settle the option using price.price and price.expo
        // ... your settlement logic ...

        // 6. Refund excess ETH
        if (msg.value > fee) {
            payable(msg.sender).transfer(msg.value - fee);
        }
    }

    /// @notice For binary options with delayed settlement, use parsePriceFeedUpdates
    ///         to get the price at the exact expiry timestamp.
    function settleAtExpiry(
        bytes[] calldata priceUpdate,
        bytes32 priceFeedId,
        uint256 optionId,
        uint64 expiryTimestamp
    ) external payable {
        uint fee = pyth.getUpdateFee(priceUpdate);

        bytes32[] memory ids = new bytes32[](1);
        ids[0] = priceFeedId;

        // Get the price at the exact expiry time (within 10s window)
        PythStructs.PriceFeed[] memory priceFeeds = pyth.parsePriceFeedUpdates{value: fee}(
            priceUpdate,
            ids,
            expiryTimestamp,
            expiryTimestamp + 10
        );

        PythStructs.Price memory price = priceFeeds[0].price;

        // ... settle using the expiry-time price ...
    }
}
```

### Fetching Price Updates (Frontend / Keeper)

```typescript
import { HermesClient } from "@pythnetwork/hermes-client";

const hermes = new HermesClient("https://hermes.pyth.network", {});

// Fetch latest price update bytes for on-chain submission
const priceIds = [
  "0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688", // AAPL
];

const updates = await hermes.getLatestPriceUpdates(priceIds);
const updateBytes = updates.binary.data; // Pass this to your contract

// For streaming (SSE) -- reconnects needed every 24h
const eventSource = await hermes.getStreamingPriceUpdates(priceIds);
eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  // Use data for real-time UI + on-chain submissions
};
```

### Error Codes

| Selector | Error | Meaning |
|----------|-------|---------|
| `0x14aebe68` | `PriceFeedNotFound` | Feed ID has never received an update on this chain |
| `0x19abf40e` | `StalePrice` | Price is older than the allowed staleness period |
| `0x025dbdd4` | `InsufficientFee` | Not enough ETH sent with `updatePriceFeeds` |
| `0xe69ffece` | `InvalidUpdateData` | Malformed or tampered price update bytes |
| `0x45805f5d` | `PriceFeedNotFoundWithinRange` | No price in the requested time range (for `parsePriceFeedUpdates`) |

### Confidence Intervals

Every Pyth price includes a **confidence interval** (`conf`) representing the 95% confidence range of the true price: `[price - conf, price + conf]`.

**For binary options settlement, this is particularly important:**

- If the settlement price is near the strike price, a wide confidence interval means the outcome is uncertain.
- Consider requiring `conf/price < threshold` before settling, or using the adverse side of the confidence interval.
- During market stress, confidence widens -- your protocol should handle this gracefully (e.g., delay settlement, pause new positions).

```solidity
// Conservative: use adverse side of confidence interval
int64 conservativePrice = price.price - int64(price.conf); // lower bound
int64 aggressivePrice = price.price + int64(price.conf);   // upper bound
```

### Market Hours

Equity feeds **do not update outside US market hours**. Your protocol must handle this:

- `getPriceNoOlderThan()` will revert with `StalePrice` outside trading hours.
- Options expiring outside market hours should use the last available price (via `getPriceUnsafe()` with your own timestamp validation) or defer settlement to the next market open.
- Consider using `parsePriceFeedUpdates()` with a time range matching market close to get the closing price.

### Installation

```bash
# Hardhat
npm install @pythnetwork/pyth-sdk-solidity

# Foundry
npm init -y
npm install @pythnetwork/pyth-sdk-solidity
# Add to remappings.txt:
# @pythnetwork/pyth-sdk-solidity/=node_modules/@pythnetwork/pyth-sdk-solidity
```

---

## L2 Sequencer / Uptime Considerations

### Chainlink's Approach

Chainlink provides an **L2 Sequencer Uptime Feed** on chains like Arbitrum, Optimism, and Base. Protocols check this feed to detect sequencer downtime and pause operations to prevent stale-price exploitation.

### Pyth's Approach

**Pyth does NOT have a built-in sequencer uptime oracle.**

However, Pyth's pull model provides **natural resilience** against sequencer downtime:

1. **If the sequencer is down, no transactions execute at all** -- so no stale prices can be consumed.
2. **When the sequencer comes back up**, the first transaction must submit a fresh `updatePriceFeeds()`. The staleness check in `getPriceNoOlderThan()` will reject any update that is too old relative to `block.timestamp`.
3. The risk scenario is: sequencer comes back up, `block.timestamp` jumps forward, but someone submits a price update from just before the outage that technically falls within the staleness window. With tight staleness thresholds (e.g., 60s), this window is small.

### Recommendations for Base

- **Use tight staleness thresholds** (30-60 seconds). After a sequencer outage, stale prices will be rejected.
- **Monitor confidence intervals** post-outage. They may be wider than normal, indicating price uncertainty.
- **Consider adding Chainlink's L2 Sequencer Uptime Feed as a secondary check** if your protocol is high-stakes:

```solidity
// Optional: add Chainlink sequencer check alongside Pyth
AggregatorV3Interface sequencerFeed = AggregatorV3Interface(SEQUENCER_FEED_ADDRESS);
(, int256 answer, uint256 startedAt, , ) = sequencerFeed.latestRoundData();
bool isSequencerUp = answer == 0;
uint256 timeSinceUp = block.timestamp - startedAt;
require(isSequencerUp && timeSinceUp > GRACE_PERIOD, "Sequencer down or grace period");
```

---

## Pyth vs Chainlink: Detailed Comparison

### Architecture

| Aspect | Pyth | Chainlink (Push Feeds) | Chainlink (Data Streams) |
|--------|------|----------------------|------------------------|
| **Model** | Pull (consumer fetches + submits) | Push (automated on-chain updates) | Pull (similar to Pyth) |
| **Update trigger** | On-demand by consumer | Heartbeat + deviation threshold | On-demand by consumer |
| **Data source** | First-party (120+ institutions publish directly) | Third-party aggregators via independent nodes | Same as push, but delivered differently |
| **Latency** | ~400ms on Pythnet | Heartbeat-dependent (1-60 min) | Sub-second |

### Cost

| Aspect | Pyth | Chainlink Push | Chainlink Data Streams |
|--------|------|---------------|----------------------|
| **Who pays** | Consumer pays per update (~$0.05 on L2) | Chainlink/sponsors subsidize | Subscription + per-use |
| **Gas per read** | ~60K gas (update) + ~5K gas (read) | ~5K gas (read only) | Similar to Pyth |
| **Wasted updates** | None (only pay when you need data) | Many (updates happen whether used or not) | None |

**For binary options on L2**: Pyth is cheaper. You only pay for updates when settling options, not continuously.

### Data Quality

| Aspect | Pyth | Chainlink |
|--------|------|-----------|
| **Data sources** | First-party: exchanges & market makers publish directly (Jane Street, CBOE, Binance, Wintermute, Two Sigma) | Third-party: nodes aggregate from data providers (CoinGecko, CoinMarketCap, CCData) |
| **Transparency** | Publisher public keys are on-chain; each data point is attributable | Node operators visible, but underlying data sources are opaque |
| **Confidence interval** | Built-in `conf` field on every price | Not provided |
| **EMA price** | Built-in `getEmaPriceNoOlderThan()` | Not built-in (must compute yourself) |

### Equity Feed Support

| Aspect | Pyth | Chainlink |
|--------|------|-----------|
| **Equity feeds since** | 2023 (first oracle to offer real-time equities on-chain) | August 2025 (via Data Streams) |
| **MAG7 coverage** | All 7 confirmed live on Base mainnet | Available on mainnet via Data Streams |
| **ETF coverage** | 100+ ETFs (BlackRock, Vanguard, State Street) | Growing, launched August 2025 |
| **Testnet equity feeds** | Not available (PriceFeedNotFound on Base Sepolia) | Not available on testnets |
| **Market hours handling** | Feeds stop updating outside market hours; staleness checks catch this | Data Streams provide 24/5 coverage with market status flags |

### Security & Track Record

| Aspect | Pyth | Chainlink |
|--------|------|-----------|
| **Live since** | 2021 (Solana), 2023 (cross-chain) | 2019 (mainnet) |
| **TVS** | ~$5.5B (growing rapidly, 46x in 9 months during 2024) | ~$39.7B |
| **TTE** | $1T+ | $18.2T+ (2024) |
| **Known incidents** | Clean record (fewer integrations, less time) | Multiple oracle mis-pricing events (wrstETH on Base Nov 2025 ~$1M, deUSD May 2025 ~$500K, LUNA 2022 ~$11.2M) |
| **Bridge dependency** | Yes (Wormhole) -- adds attack surface | No (native per-chain) |
| **Staking security** | OIS (Oracle Integrity Staking) -- 938M PYTH staked | LINK staking (limited scope) |

**Important caveat:** Most Chainlink "incidents" were caused by protocols **incorrectly consuming** Chainlink data (missing staleness checks, no sequencer validation, ignoring circuit breakers), not Chainlink itself being broken.

### Developer Experience

| Aspect | Pyth | Chainlink Push |
|--------|------|---------------|
| **Integration complexity** | Medium: 2-step (update + read), frontend must fetch from Hermes | Low: 1-step (just read the contract) |
| **Testing** | MockPyth available; need price pusher for testnet | Feeds available on Sepolia (crypto only) |
| **SDK quality** | Good: `@pythnetwork/pyth-sdk-solidity`, `@pythnetwork/hermes-client` | Excellent: mature ecosystem, extensive docs |
| **Audit coverage** | Fewer public audits of Pyth integrations | Massive corpus of audit findings to learn from |

### Pros of Pyth for This Project

1. **Pull model is ideal for binary options** -- you only need the price at settlement time, not continuously. Pay-per-use is cheaper than subsidized continuous updates.
2. **`parsePriceFeedUpdates()` enables exact-timestamp settlement** -- critical for options that expire at a specific time.
3. **Confidence intervals** let you handle edge cases where the settlement price is near the strike.
4. **First-party equity data** from actual trading venues, not aggregated third-party feeds.
5. **Cost-efficient on L2** -- Base gas is cheap, so the update cost is negligible.
6. **100+ chain coverage** if you expand beyond Base.

### Cons of Pyth for This Project

1. **Integration complexity** -- the 2-step update+read pattern requires a keeper or frontend to fetch from Hermes.
2. **No built-in sequencer uptime check** -- must implement separately if needed.
3. **Wormhole dependency** -- adds an attack surface that Chainlink doesn't have.
4. **Shorter track record** -- less battle-tested, especially for equity feeds.
5. **No testnet equity data** -- requires mock oracle for development.
6. **Market hours gap** -- equity feeds go stale outside trading hours; protocol must handle this.
7. **Smaller audit corpus** -- fewer public examples of correct Pyth integration to reference.

### Pros of Chainlink for This Project

1. **Simpler integration** (push feeds) -- just read a contract, no update transaction needed.
2. **L2 Sequencer Uptime Feed** -- built-in sequencer health check on Base.
3. **Battle-tested** -- 6+ years, $18T+ transaction volume, well-understood failure modes.
4. **Institutional credibility** -- "nobody gets fired for choosing Chainlink."
5. **Broader ecosystem** -- CCIP, VRF, Functions, Automation if you need them later.
6. **Extensive audit corpus** -- large body of public findings showing correct/incorrect usage.

### Cons of Chainlink for This Project

1. **Data Streams required for equity** -- the simple push model doesn't support equities. Data Streams is pull-based (same complexity as Pyth).
2. **No testnet equity data** either -- same mock oracle problem.
3. **Subscription cost** -- Data Streams requires a paid subscription, whereas Pyth's Hermes API is free.
4. **No confidence intervals** -- harder to handle edge cases at settlement.
5. **No `parsePriceFeedUpdates` equivalent** -- harder to settle at a specific historical timestamp.
6. **Known circuit breaker issues** -- `minPrice`/`maxPrice` bounds can mask true prices during crashes.

### Recommendation

**Pyth is the better fit for this binary options MVP** because:

- The pull model with `parsePriceFeedUpdates()` is purpose-built for settling at a specific timestamp.
- Confidence intervals provide a natural mechanism for handling uncertain settlements.
- Cost is lower on L2 (pay per settlement, not continuous subscription).
- Equity coverage is more mature (live since 2023 vs Chainlink's August 2025).
- The Hermes API is free (no subscription required).

The main trade-off is integration complexity and the Wormhole dependency, but for a binary options product these are acceptable given the benefits.

---

## Appendix A: Other Oracles Investigated

### Pyth Pro (Lazer)

- **Contract:** `0xACeA761c27A909d4D3895128EBe6370FDE2dF481` (Base Sepolia)
- **Result:** Verification-only contract with no price storage. Has `verifyUpdate(bytes)` but no `getPrice()`. Equity feeds (1,679 of them) are all marked `coming_soon` in the symbols API.
- **Verdict:** Not usable for equity data currently.

### Supra Oracle (Push)

- **Contracts tested:** Base Sepolia (`0x6Cd59830AAD978446e6cc7f6cc173aF7656Fb917`), Arbitrum Sepolia (same address)
- **MAG7 pair indices:** TSLA=6000, MSFT=6001, NVDA=6002, GOOG=6003, AAPL=6004, AMZN=6005, META=6006
- **Result:** All equity feeds return `(0, 0, 0, 0)`. Crypto feeds (BTC, ETH) return live data, confirming the contract works.
- **Verdict:** Equity feeds defined but not populated on any testnet.

### Chainlink (Push Feeds)

- **Equity feeds on testnets:** Not available. Testnet feeds are limited to crypto pairs (BTC/USD, ETH/USD).
- **Equity Data Streams:** Launched August 2025 on 37 mainnet chains. Pull-based model requiring subscription. No testnet deployment found.
- **Verdict:** Equity data available on mainnet only, behind a paid subscription.

---

## Appendix B: Sources

- [Pyth Price Feeds Documentation](https://docs.pyth.network/price-feeds)
- [Pyth EVM Integration Guide](https://docs.pyth.network/price-feeds/use-real-time-data/evm)
- [Pyth Best Practices](https://docs.pyth.network/price-feeds/best-practices)
- [Pyth How It Works](https://docs.pyth.network/price-feeds/how-pyth-works)
- [Pyth SDK Solidity (GitHub)](https://github.com/pyth-network/pyth-sdk-solidity)
- [Pyth Pro Documentation](https://docs.pyth.network/price-feeds/pro)
- [Pyth Pro Price Feed IDs / Symbols API](https://history.pyth-lazer.dourolabs.app/history/v1/symbols)
- [Pyth Equity Feed Page (AAPL/USD)](https://www.pyth.network/price-feeds/equity-us-aapl-usd)
- [Pyth Launches on Base](https://www.pyth.network/blog/pyth-launches-price-oracles-on-base)
- [Chainlink Data Streams Documentation](https://docs.chain.link/data-streams)
- [Chainlink Tokenized Equity Feeds](https://docs.chain.link/data-feeds/tokenized-equity-feeds)
- [Chainlink Data Streams for US Equities (PR)](https://www.prnewswire.com/news-releases/chainlink-launches-data-streams-for-us-equities-and-etfs-to-power-secure-tokenized-rwa-markets-onchain-302520632.html)
- [Chainlink Price Feed Addresses](https://docs.chain.link/data-feeds/price-feeds/addresses)
- [Supra Data Feeds Index](https://docs.supra.com/oracles/data-feeds/data-feeds-index)
- [Supra Push Oracle Networks](https://docs.supra.com/oracles/data-feeds/push-oracle/networks)
- [Blockchain Oracles Comparison 2025 (RedStone Blog)](https://blog.redstone.finance/2025/01/16/blockchain-oracles-comparison-chainlink-vs-pyth-vs-redstone-2025/)
- [Pyth vs LINK: Comparative Analysis (OneKey)](https://onekey.so/blog/ecosystem/pyth-vs-link-a-comparative-analysis-of-two-oracle-giants-in-2025/)
- [Battle of the Oracles (VanEck)](https://www.vaneck.com/ch/en/blog/digital-assets/battle-of-the-oracles-comparating-leading-decentralized-oracle-networks/)
- [Chainlink Oracle DeFi Attacks (Cyfrin)](https://medium.com/cyfrin/chainlink-oracle-defi-attacks-93b6cb6541bf)
- [Oracle Integrity Staking (Pyth Blog)](https://www.pyth.network/blog/oracle-integrity-staking-incentivizing-safer-price-feeds-for-a-more-secure-defi)
