// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

/// @title PriceLib
/// @notice Stateless library for Pyth price validation and strike comparison.
/// All prices are in Pyth native int64 units at a fixed exponent of -5
/// (e.g. $230.00000 is stored as 23_000_000).
library PriceLib {
    int32 internal constant EXPECTED_EXPO = -5;
    uint64 internal constant SCALE = 100_000; // 10^5 — converts Pyth units to whole dollars

    error UnexpectedExponent(int32 actual, int32 expected);
    error NegativePrice(int64 price);
    error ConfidenceTooWide(uint64 conf, uint64 absPrice, uint16 thresholdBps);

    /// @notice Validate a Pyth price feed entry and compare against a strike price.
    /// @dev Reverts on invalid exponent, non-positive price, or confidence ratio exceeding `maxConfBps`.
    /// @param p          Raw Pyth Price struct.
    /// @param strikePrice Strike in same Pyth native units (int64, expo -5).
    /// @param maxConfBps  Maximum acceptable confidence-to-price ratio in basis points (e.g. 100 = 1%).
    /// @return yesWins   True if `p.price >= strikePrice` (at-or-above wins).
    function validateAndCompare(
        PythStructs.Price memory p,
        int64 strikePrice,
        uint16 maxConfBps
    ) internal pure returns (bool yesWins) {
        if (p.expo != EXPECTED_EXPO) {
            revert UnexpectedExponent(p.expo, EXPECTED_EXPO);
        }

        if (p.price <= 0) {
            revert NegativePrice(p.price);
        }

        // Confidence ratio check: conf * 10_000 / absPrice > maxConfBps → too wide
        // Use uint256 to prevent overflow (conf and absPrice are both <= 2^63-1 in practice)
        uint256 absPrice = uint256(uint64(p.price));
        uint256 confRatioBps = (uint256(p.conf) * 10_000) / absPrice;
        if (confRatioBps > uint256(maxConfBps)) {
            revert ConfidenceTooWide(p.conf, uint64(absPrice), maxConfBps);
        }

        yesWins = p.price >= strikePrice;
    }

    /// @notice Convert a positive Pyth int64 price (expo -5) to a human-readable dollar string.
    /// @dev e.g. 23_000_000 → "230.00000". Always 5 decimal places.
    ///      Only used by MeridianMarket.uri() for on-chain metadata; not part of settlement logic.
    function toDisplayString(int64 price) internal pure returns (string memory) {
        require(price >= 0, "PriceLib: negative price");
        uint256 raw = uint256(uint64(price));
        uint256 wholeDollars = raw / SCALE;
        uint256 fractional = raw % SCALE;

        // Zero-pad the fractional part to 5 digits
        string memory fracStr = _padLeft(Strings.toString(fractional), 5);

        return string.concat(Strings.toString(wholeDollars), ".", fracStr);
    }

    /// @dev Left-pad `s` with zeros to reach `length` characters.
    function _padLeft(string memory s, uint256 length) private pure returns (string memory) {
        bytes memory sb = bytes(s);
        uint256 sbLen = sb.length;
        if (sbLen >= length) return s;

        uint256 padLen = length - sbLen;
        bytes memory padded = new bytes(length);
        for (uint256 i = 0; i < padLen; i++) {
            padded[i] = "0";
        }
        for (uint256 i = 0; i < sbLen; i++) {
            padded[padLen + i] = sb[i];
        }
        return string(padded);
    }
}
