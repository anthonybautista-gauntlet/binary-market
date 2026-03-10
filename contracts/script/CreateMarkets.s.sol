// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/MeridianMarket.sol";

/// @notice Creates up to 49 binary options markets (7 MAG7 tickers × up to 7 strike bins)
///         on a deployed MeridianMarket. Feeds must already be registered — Deploy.s.sol
///         handles that step.
///
/// Strike bins are computed at ±9%, ±6%, ±3%, and ATM relative to the previous closing
/// price, rounded to the nearest $10. Duplicate strikes (common for lower-priced stocks)
/// are silently skipped.
///
/// Usage:
///   forge script script/CreateMarkets.s.sol --rpc-url $BASE_SEPOLIA_RPC \
///     --broadcast --private-key $OPERATOR_PK \
///     --sig "run()"
///
/// Required env vars:
///   OPERATOR_PK      — private key of an OPERATOR_ROLE holder
///   MARKET_ADDRESS   — deployed MeridianMarket address
///
/// Optional env vars:
///   EXPIRY_TIMESTAMP — Unix timestamp for all created markets
///                      (default: block.timestamp + 7 days)
///
///   Per-ticker closing prices as whole-dollar integers (script converts to Pyth units).
///   If omitted, falls back to reference prices from 2026-03-06:
///   AAPL_PRICE, MSFT_PRICE, NVDA_PRICE, GOOGL_PRICE, AMZN_PRICE, META_PRICE, TSLA_PRICE
///
///   Example:
///     AAPL_PRICE=257   →  25_700_000 Pyth units  →  strikes at $230, $240, $250, $260, $270, $280
contract CreateMarketsScript is Script {
    // ── Fallback prices (whole dollars, Base mainnet close 2026-03-06) ─────────
    uint256 constant AAPL_DEFAULT  = 256;
    uint256 constant MSFT_DEFAULT  = 410;
    uint256 constant NVDA_DEFAULT  = 179;
    uint256 constant GOOGL_DEFAULT = 298;
    uint256 constant AMZN_DEFAULT  = 215;
    uint256 constant META_DEFAULT  = 645;
    uint256 constant TSLA_DEFAULT  = 398;

    /// @dev Pyth price units per dollar at expo -5.
    int64 constant PYTH_UNITS_PER_DOLLAR = 100_000;

    function run() external {
        MeridianMarket market = MeridianMarket(payable(vm.envAddress("MARKET_ADDRESS")));
        uint64 expiry = uint64(vm.envOr("EXPIRY_TIMESTAMP", uint256(block.timestamp + 7 days)));

        // Read per-ticker prices from env (whole dollars); multiply to get Pyth units.
        int64 aaplRef  = int64(int256(vm.envOr("AAPL_PRICE",  AAPL_DEFAULT)))  * PYTH_UNITS_PER_DOLLAR;
        int64 msftRef  = int64(int256(vm.envOr("MSFT_PRICE",  MSFT_DEFAULT)))  * PYTH_UNITS_PER_DOLLAR;
        int64 nvdaRef  = int64(int256(vm.envOr("NVDA_PRICE",  NVDA_DEFAULT)))  * PYTH_UNITS_PER_DOLLAR;
        int64 googlRef = int64(int256(vm.envOr("GOOGL_PRICE", GOOGL_DEFAULT))) * PYTH_UNITS_PER_DOLLAR;
        int64 amznRef  = int64(int256(vm.envOr("AMZN_PRICE",  AMZN_DEFAULT)))  * PYTH_UNITS_PER_DOLLAR;
        int64 metaRef  = int64(int256(vm.envOr("META_PRICE",  META_DEFAULT)))  * PYTH_UNITS_PER_DOLLAR;
        int64 tslaRef  = int64(int256(vm.envOr("TSLA_PRICE",  TSLA_DEFAULT)))  * PYTH_UNITS_PER_DOLLAR;

        vm.startBroadcast(vm.envUint("OPERATOR_PK"));

        _createAll(market, bytes32("AAPL"),  aaplRef,  expiry);
        _createAll(market, bytes32("MSFT"),  msftRef,  expiry);
        _createAll(market, bytes32("NVDA"),  nvdaRef,  expiry);
        _createAll(market, bytes32("GOOGL"), googlRef, expiry);
        _createAll(market, bytes32("AMZN"),  amznRef,  expiry);
        _createAll(market, bytes32("META"),  metaRef,  expiry);
        _createAll(market, bytes32("TSLA"),  tslaRef,  expiry);

        vm.stopBroadcast();
    }

    /// @dev Creates up to 7 strike markets for a single ticker.
    function _createAll(
        MeridianMarket market,
        bytes32 ticker,
        int64 refPrice,
        uint64 expiry
    ) internal {
        int64[7] memory strikes = _computeStrikes(refPrice);
        uint256 len = strikes.length;
        for (uint256 i = 0; i < len; i++) {
            _createIfNew(market, ticker, strikes[i], expiry);
        }
    }

    /// @dev Returns 7 strike candidates at −9%, −6%, −3%, ATM, +3%, +6%, +9% of refPrice,
    ///      each rounded to the nearest $10 (1_000_000 Pyth units at expo -5).
    ///      Duplicates arise for lower-priced stocks; _createIfNew silently skips them.
    function _computeStrikes(int64 refPrice) internal pure returns (int64[7] memory strikes) {
        strikes[0] = _roundToTen(refPrice * 910  / 1000); // −9%
        strikes[1] = _roundToTen(refPrice * 940  / 1000); // −6%
        strikes[2] = _roundToTen(refPrice * 970  / 1000); // −3%
        strikes[3] = _roundToTen(refPrice);                // ATM
        strikes[4] = _roundToTen(refPrice * 1030 / 1000); // +3%
        strikes[5] = _roundToTen(refPrice * 1060 / 1000); // +6%
        strikes[6] = _roundToTen(refPrice * 1090 / 1000); // +9%
    }

    /// @dev Rounds to the nearest $10.00000 (1_000_000 units at expo -5).
    function _roundToTen(int64 price) internal pure returns (int64) {
        int64 unit = 1_000_000;
        return ((price + unit / 2) / unit) * unit;
    }

    function _createIfNew(
        MeridianMarket market,
        bytes32 ticker,
        int64 strike,
        uint64 expiry
    ) internal {
        bytes32 mId = keccak256(abi.encode(ticker, strike, expiry));
        (, , , uint64 existing, , , , ,) = market.markets(mId);
        if (existing != 0) {
            console.log("Already exists, skipping:", uint256(mId));
            return;
        }

        bytes32 newId = market.createStrikeMarket(ticker, strike, expiry);
        console.log("Created market:", uint256(newId));
        console.log("  Ticker:", string(abi.encodePacked(ticker)));
        console.log("  Strike (Pyth units):", uint256(uint64(strike)));
        console.log("  Expiry:", uint256(expiry));
    }
}
