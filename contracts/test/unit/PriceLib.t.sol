// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";
import "../../src/libraries/PriceLib.sol";

/// @dev Harness exposes internal library functions as external calls so vm.expectRevert works.
contract PriceLibHarness {
    function validateAndCompare(
        PythStructs.Price memory p,
        int64 strikePrice,
        uint16 maxConfBps
    ) external pure returns (bool) {
        return PriceLib.validateAndCompare(p, strikePrice, maxConfBps);
    }

    function toDisplayString(int64 price) external pure returns (string memory) {
        return PriceLib.toDisplayString(price);
    }
}

contract PriceLibTest is Test {
    PriceLibHarness internal harness;
    function setUp() public {
        harness = new PriceLibHarness();
    }

    // Helper: build a PythStructs.Price with sane defaults
    function _price(int64 p, uint64 c, int32 expo) internal pure returns (PythStructs.Price memory) {
        return PythStructs.Price({price: p, conf: c, expo: expo, publishTime: 0});
    }

    // ── validateAndCompare: expo validation ───────────────────────────────────

    function test_validateAndCompare_revertsWrongExponent() public {
        PythStructs.Price memory p = _price(23_000_000, 1_000, -4); // wrong expo
        vm.expectRevert(abi.encodeWithSelector(PriceLib.UnexpectedExponent.selector, int32(-4), int32(-5)));
        harness.validateAndCompare(p, 23_000_000, 100);
    }

    function test_validateAndCompare_revertsPositiveExponent() public {
        PythStructs.Price memory p = _price(23_000_000, 1_000, 0);
        vm.expectRevert(abi.encodeWithSelector(PriceLib.UnexpectedExponent.selector, int32(0), int32(-5)));
        harness.validateAndCompare(p, 23_000_000, 100);
    }

    // ── validateAndCompare: negative price guard ──────────────────────────────

    function test_validateAndCompare_revertsNegativePrice() public {
        PythStructs.Price memory p = _price(-1_000, 10, -5);
        vm.expectRevert(abi.encodeWithSelector(PriceLib.NegativePrice.selector, int64(-1_000)));
        harness.validateAndCompare(p, 23_000_000, 100);
    }

    function test_validateAndCompare_revertsZeroPrice() public {
        PythStructs.Price memory p = _price(0, 0, -5);
        vm.expectRevert(abi.encodeWithSelector(PriceLib.NegativePrice.selector, int64(0)));
        harness.validateAndCompare(p, 23_000_000, 100);
    }

    // ── validateAndCompare: confidence check ─────────────────────────────────

    function test_validateAndCompare_revertsConfidenceTooWide() public {
        // price = 100_000 (=$1.00000), conf = 200 (= 0.002)
        // ratio = 200 * 10000 / 100000 = 20 bps; threshold = 10 bps → revert
        PythStructs.Price memory p = _price(100_000, 200, -5);
        vm.expectRevert(
            abi.encodeWithSelector(PriceLib.ConfidenceTooWide.selector, uint64(200), uint64(100_000), uint16(10))
        );
        harness.validateAndCompare(p, 100_000, 10);
    }

    function test_validateAndCompare_acceptsConfidenceAtThreshold() public {
        // ratio = 100 * 10000 / 100000 = 10 bps == threshold; should pass
        PythStructs.Price memory p = _price(100_000, 100, -5);
        bool result = harness.validateAndCompare(p, 100_000, 10);
        assertTrue(result); // price == strike → YES wins
    }

    function test_validateAndCompare_acceptsZeroConfidence() public {
        PythStructs.Price memory p = _price(100_000, 0, -5);
        bool result = harness.validateAndCompare(p, 100_000, 10);
        assertTrue(result);
    }

    // ── validateAndCompare: strike comparison ─────────────────────────────────

    function test_validateAndCompare_priceAboveStrike_yesWins() public {
        // AAPL $230.00001 vs strike $230.00000 → YES
        PythStructs.Price memory p = _price(23_000_001, 10, -5);
        bool result = harness.validateAndCompare(p, 23_000_000, 100);
        assertTrue(result);
    }

    function test_validateAndCompare_priceAtStrike_yesWins() public {
        // Exactly at strike → YES (at-or-above rule)
        PythStructs.Price memory p = _price(23_000_000, 10, -5);
        bool result = harness.validateAndCompare(p, 23_000_000, 100);
        assertTrue(result);
    }

    function test_validateAndCompare_priceBelowStrike_noWins() public {
        // AAPL $229.99999 vs strike $230.00000 → NO
        PythStructs.Price memory p = _price(22_999_999, 10, -5);
        bool result = harness.validateAndCompare(p, 23_000_000, 100);
        assertFalse(result);
    }

    function test_validateAndCompare_priceOneUnitBelowStrike_noWins() public {
        PythStructs.Price memory p = _price(22_999_999, 1, -5);
        bool result = harness.validateAndCompare(p, 23_000_000, 100);
        assertFalse(result);
    }

    function testFuzz_validateAndCompare_comparison(int64 price, int64 strike) public {
        vm.assume(price > 0);
        vm.assume(strike > 0);
        // conf = 0 so confidence never reverts; maxConfBps = 10000 (100%) so anything passes
        PythStructs.Price memory p = _price(price, 0, -5);
        bool result = harness.validateAndCompare(p, strike, 10000);
        if (price >= strike) {
            assertTrue(result);
        } else {
            assertFalse(result);
        }
    }

    // ── toDisplayString ────────────────────────────────────────────────────────

    function test_toDisplayString_roundDollarAmount() public {
        // $230.00000
        assertEq(harness.toDisplayString(23_000_000), "230.00000");
    }

    function test_toDisplayString_fractionalAmount() public {
        // $0.00001
        assertEq(harness.toDisplayString(1), "0.00001");
    }

    function test_toDisplayString_oneDollar() public {
        assertEq(harness.toDisplayString(100_000), "1.00000");
    }

    function test_toDisplayString_largePriceNVDA() public {
        // $680.00000
        assertEq(harness.toDisplayString(68_000_000), "680.00000");
    }

    function test_toDisplayString_noFractionalPart() public {
        // $1000.00000
        assertEq(harness.toDisplayString(100_000_000), "1000.00000");
    }

    function test_toDisplayString_nonRoundFractional() public {
        // $230.12345
        assertEq(harness.toDisplayString(23_012_345), "230.12345");
    }
}
