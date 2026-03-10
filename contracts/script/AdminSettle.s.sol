// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/MeridianMarket.sol";

/// @notice Scans all unsettled expired markets and calls adminSettleOverride using
///         manually supplied closing prices. Use this when the normal settlement path
///         (settleMarket via Pyth/Hermes) failed because price data was unavailable.
///
///         Requires DEFAULT_ADMIN_ROLE. Markets must be at least 1 hour past expiry
///         (ADMIN_OVERRIDE_DELAY) — earlier markets are skipped with a warning.
///
/// Usage:
///   forge script script/AdminSettle.s.sol \
///     --rpc-url $BASE_SEPOLIA_RPC \
///     --broadcast \
///     --private-key $DEPLOYER_PK
///
/// Required env vars:
///   DEPLOYER_PK       — private key of the DEFAULT_ADMIN_ROLE holder
///   MARKET_ADDRESS — deployed MeridianMarket address
///
/// Per-ticker closing prices as whole-dollar integers (script multiplies by 100,000
/// to convert to Pyth expo-5 units). If omitted, the hardcoded defaults below are used.
///
///   AAPL_PRICE, MSFT_PRICE, NVDA_PRICE, GOOGL_PRICE, AMZN_PRICE, META_PRICE, TSLA_PRICE
///
///   Example:
///     AAPL_PRICE=227 NVDA_PRICE=118 TSLA_PRICE=285 \
///     forge script script/AdminSettle.s.sol --rpc-url $RPC --broadcast --private-key $DEPLOYER_PK
///
/// Optional:
///   SETTLE_COUNT   — how many recent markets to scan (default: all markets on contract)
contract AdminSettleScript is Script {
    // ── Fallback closing prices (whole dollars) ────────────────────────────────
    // These are used when no env var is set. Update before running if stale.
    uint256 constant AAPL_DEFAULT  = 259;
    uint256 constant MSFT_DEFAULT  = 409;
    uint256 constant NVDA_DEFAULT  = 182;
    uint256 constant GOOGL_DEFAULT = 306;
    uint256 constant AMZN_DEFAULT  = 213;
    uint256 constant META_DEFAULT  = 647;
    uint256 constant TSLA_DEFAULT  = 398;

    // 1 dollar = 100,000 Pyth units at expo -5
    int64 constant PYTH_PER_DOLLAR = 100_000;

    // Must match MeridianMarket.ADMIN_OVERRIDE_DELAY (15 minutes)
    uint256 constant ADMIN_OVERRIDE_DELAY = 900;

    function run() external {
        MeridianMarket market = MeridianMarket(payable(vm.envAddress("MARKET_ADDRESS")));

        // ── Resolve closing prices (whole dollars → Pyth units) ───────────────
        int64 aaplClose  = int64(int256(vm.envOr("AAPL_PRICE",  AAPL_DEFAULT)))  * PYTH_PER_DOLLAR;
        int64 msftClose  = int64(int256(vm.envOr("MSFT_PRICE",  MSFT_DEFAULT)))  * PYTH_PER_DOLLAR;
        int64 nvdaClose  = int64(int256(vm.envOr("NVDA_PRICE",  NVDA_DEFAULT)))  * PYTH_PER_DOLLAR;
        int64 googlClose = int64(int256(vm.envOr("GOOGL_PRICE", GOOGL_DEFAULT))) * PYTH_PER_DOLLAR;
        int64 amznClose  = int64(int256(vm.envOr("AMZN_PRICE",  AMZN_DEFAULT)))  * PYTH_PER_DOLLAR;
        int64 metaClose  = int64(int256(vm.envOr("META_PRICE",  META_DEFAULT)))  * PYTH_PER_DOLLAR;
        int64 tslaClose  = int64(int256(vm.envOr("TSLA_PRICE",  TSLA_DEFAULT)))  * PYTH_PER_DOLLAR;

        console.log("=== AdminSettle ===");
        console.log("Closing prices (whole dollars):");
        console.log("  AAPL :", vm.envOr("AAPL_PRICE",  AAPL_DEFAULT));
        console.log("  MSFT :", vm.envOr("MSFT_PRICE",  MSFT_DEFAULT));
        console.log("  NVDA :", vm.envOr("NVDA_PRICE",  NVDA_DEFAULT));
        console.log("  GOOGL:", vm.envOr("GOOGL_PRICE", GOOGL_DEFAULT));
        console.log("  AMZN :", vm.envOr("AMZN_PRICE",  AMZN_DEFAULT));
        console.log("  META :", vm.envOr("META_PRICE",  META_DEFAULT));
        console.log("  TSLA :", vm.envOr("TSLA_PRICE",  TSLA_DEFAULT));
        console.log("-------------------------------------------");

        // ── Fetch markets ─────────────────────────────────────────────────────
        uint256 total = market.marketCount();
        if (total == 0) {
            console.log("No markets found on contract - nothing to do.");
            return;
        }

        uint256 scanCount = vm.envOr("SETTLE_COUNT", total);
        if (scanCount > total) scanCount = total;

        MeridianMarket.MarketView[] memory mv = market.getMarkets(scanCount);
        console.log("Scanning", mv.length, "market(s)...");
        console.log("-------------------------------------------");

        uint256 settledCount      = 0;
        uint256 skippedAlready    = 0;
        uint256 skippedTooEarly   = 0;
        uint256 skippedNotExpired = 0;
        uint256 skippedBadTicker  = 0;
        uint256 mvLen = mv.length;

        vm.startBroadcast(vm.envUint("DEPLOYER_PK"));

        for (uint256 i = 0; i < mvLen; i++) {
            MeridianMarket.MarketView memory m = mv[i];

            // Already settled — nothing to do
            if (m.settled) {
                skippedAlready++;
                continue;
            }

            // Market hasn't expired yet
            if (block.timestamp < uint256(m.expiryTimestamp)) {
                skippedNotExpired++;
                continue;
            }

            // Within the mandatory 1-hour delay after expiry
            if (block.timestamp < uint256(m.expiryTimestamp) + ADMIN_OVERRIDE_DELAY) {
                console.log("Skipping - within 1h override delay:");
                console.log("  MarketId:", uint256(m.marketId));
                console.log("  Ticker  :", _tickerStr(m.ticker));
                console.log("  Eligible in ~", uint256(m.expiryTimestamp) + ADMIN_OVERRIDE_DELAY - block.timestamp, "seconds");
                skippedTooEarly++;
                continue;
            }

            // Look up the closing price for this ticker
            int64 closingPrice = _priceForTicker(
                m.ticker,
                aaplClose, msftClose, nvdaClose, googlClose, amznClose, metaClose, tslaClose
            );

            if (closingPrice == 0) {
                console.log("Skipping - unrecognised ticker (add a price env var):");
                console.logBytes32(m.ticker);
                skippedBadTicker++;
                continue;
            }

            bool yesWins = closingPrice >= m.strikePrice;

            console.log("Settling:");
            console.log("  MarketId  :", uint256(m.marketId));
            console.log("  Ticker    :", _tickerStr(m.ticker));
            console.log("  Strike ($):", uint256(uint64(m.strikePrice)) / uint256(uint64(PYTH_PER_DOLLAR)));
            console.log("  Close  ($):", uint256(uint64(closingPrice))  / uint256(uint64(PYTH_PER_DOLLAR)));
            console.log("  Outcome   :", yesWins ? "YES wins" : "NO wins");

            market.adminSettleOverride(m.marketId, closingPrice);
            settledCount++;
        }

        vm.stopBroadcast();

        console.log("===========================================");
        console.log("Summary:");
        console.log("  Settled         :", settledCount);
        console.log("  Already settled :", skippedAlready);
        console.log("  Not yet expired :", skippedNotExpired);
        console.log("  Too early (1h)  :", skippedTooEarly);
        console.log("  Unknown ticker  :", skippedBadTicker);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /// @dev Maps a ticker bytes32 to its closing price. Returns 0 for unrecognised tickers.
    function _priceForTicker(
        bytes32 ticker,
        int64 aapl, int64 msft, int64 nvda, int64 googl,
        int64 amzn, int64 meta, int64 tsla
    ) internal pure returns (int64) {
        if (ticker == bytes32("AAPL"))  return aapl;
        if (ticker == bytes32("MSFT"))  return msft;
        if (ticker == bytes32("NVDA"))  return nvda;
        if (ticker == bytes32("GOOGL")) return googl;
        if (ticker == bytes32("AMZN"))  return amzn;
        if (ticker == bytes32("META"))  return meta;
        if (ticker == bytes32("TSLA"))  return tsla;
        return 0;
    }

    /// @dev Returns a human-readable ticker label for console output.
    function _tickerStr(bytes32 ticker) internal pure returns (string memory) {
        if (ticker == bytes32("AAPL"))  return "AAPL";
        if (ticker == bytes32("MSFT"))  return "MSFT";
        if (ticker == bytes32("NVDA"))  return "NVDA";
        if (ticker == bytes32("GOOGL")) return "GOOGL";
        if (ticker == bytes32("AMZN"))  return "AMZN";
        if (ticker == bytes32("META"))  return "META";
        if (ticker == bytes32("TSLA"))  return "TSLA";
        return "UNKNOWN";
    }
}
