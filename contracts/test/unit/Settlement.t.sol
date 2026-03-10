// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../../src/MeridianMarket.sol";
import "../../src/MockUSDC.sol";
import "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";
import "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";

contract SettlementTest is Test {
    MeridianMarket internal market;
    MockUSDC internal usdc;
    MockPyth internal pyth;

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal settler = makeAddr("settler");

    bytes32 internal constant AAPL = bytes32("AAPL");
    bytes32 internal constant AAPL_FEED = 0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688;
    int64 internal constant STRIKE = 23_000_000; // $230.00000
    uint64 internal constant EXPIRY = 1_800_000_000;

    bytes32 internal marketId;

    function setUp() public {
        vm.startPrank(admin);
        pyth = new MockPyth(3600, 0); // fee = 0
        usdc = new MockUSDC();
        market = new MeridianMarket(address(pyth), address(usdc), admin, 50);
        market.grantRole(market.OPERATOR_ROLE(), operator);
        market.grantRole(market.SETTLER_ROLE(), settler);
        market.setSupportedFeed(AAPL, AAPL_FEED, true);
        vm.stopPrank();

        vm.prank(operator);
        marketId = market.createStrikeMarket(AAPL, STRIKE, EXPIRY);
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    function _makePriceUpdate(int64 price, uint64 conf, uint64 publishTime)
        internal view returns (bytes[] memory updateData)
    {
        PythStructs.PriceFeed memory feed;
        feed.id = AAPL_FEED;
        feed.price = PythStructs.Price({
            price: price,
            conf: conf,
            expo: -5,
            publishTime: publishTime
        });
        feed.emaPrice = feed.price;

        updateData = new bytes[](1);
        updateData[0] = pyth.createPriceFeedUpdateData(
            AAPL_FEED,
            price,
            conf,
            -5,
            price,
            conf,
            publishTime
        );
    }

    function _settle(int64 price, uint64 conf, uint64 publishTime) internal {
        bytes[] memory updateData = _makePriceUpdate(price, conf, publishTime);
        uint64 min = publishTime - 30;
        uint64 max = publishTime + 120;
        vm.prank(settler);
        market.settleMarket{value: 0}(marketId, updateData, min, max);
    }

    // ── Basic settlement ───────────────────────────────────────────────────────

    function test_settle_priceAboveStrike_yesWins() public {
        vm.warp(EXPIRY + 1);
        _settle(STRIKE + 1, 10, EXPIRY);

        (, , , , , , , bool settled, bool yesWins) = market.markets(marketId);
        assertTrue(settled);
        assertTrue(yesWins);
    }

    function test_settle_priceAtStrike_yesWins() public {
        vm.warp(EXPIRY + 1);
        _settle(STRIKE, 10, EXPIRY);

        (, , , , , , , bool settled, bool yesWins) = market.markets(marketId);
        assertTrue(settled);
        assertTrue(yesWins);
    }

    function test_settle_priceBelowStrike_noWins() public {
        vm.warp(EXPIRY + 1);
        _settle(STRIKE - 1, 10, EXPIRY);

        (, , , , , , , bool settled, bool yesWins) = market.markets(marketId);
        assertTrue(settled);
        assertFalse(yesWins);
    }

    function test_settle_emitsMarketSettled() public {
        vm.warp(EXPIRY + 1);
        bytes[] memory updateData = _makePriceUpdate(STRIKE + 100, 10, EXPIRY);
        uint64 min = EXPIRY - 30;
        uint64 max = EXPIRY + 120;

        vm.expectEmit(true, false, false, false);
        emit MeridianMarket.MarketSettled(marketId, true, STRIKE + 100, EXPIRY);

        vm.prank(settler);
        market.settleMarket{value: 0}(marketId, updateData, min, max);
    }

    // ── Settlement window guards ───────────────────────────────────────────────

    function test_settle_revertsBeforeExpiry() public {
        vm.warp(EXPIRY - 1);
        bytes[] memory updateData = _makePriceUpdate(STRIKE, 10, EXPIRY);
        vm.prank(settler);
        vm.expectRevert(
            abi.encodeWithSelector(MeridianMarket.MarketNotExpired.selector, marketId)
        );
        market.settleMarket{value: 0}(marketId, updateData, EXPIRY - 30, EXPIRY + 120);
    }

    function test_settle_revertsWindowMissesExpiry_minTooLate() public {
        vm.warp(EXPIRY + 1);
        bytes[] memory updateData = _makePriceUpdate(STRIKE, 10, EXPIRY + 100);
        vm.prank(settler);
        vm.expectRevert(MeridianMarket.InvalidSettlementWindow.selector);
        // min > expiry
        market.settleMarket{value: 0}(marketId, updateData, EXPIRY + 1, EXPIRY + 200);
    }

    function test_settle_revertsWindowMissesExpiry_maxTooEarly() public {
        vm.warp(EXPIRY + 1);
        bytes[] memory updateData = _makePriceUpdate(STRIKE, 10, EXPIRY - 100);
        vm.prank(settler);
        vm.expectRevert(MeridianMarket.InvalidSettlementWindow.selector);
        // max < expiry
        market.settleMarket{value: 0}(marketId, updateData, EXPIRY - 200, EXPIRY - 1);
    }

    function test_settle_revertsWindowTooWide() public {
        vm.warp(EXPIRY + 1);
        bytes[] memory updateData = _makePriceUpdate(STRIKE, 10, EXPIRY);
        vm.prank(settler);
        vm.expectRevert(MeridianMarket.WindowTooWide.selector);
        // window = 1000 > MAX_PARSE_WINDOW (900)
        market.settleMarket{value: 0}(marketId, updateData, EXPIRY - 500, EXPIRY + 501);
    }

    function test_settle_revertsAlreadySettled() public {
        vm.warp(EXPIRY + 1);
        _settle(STRIKE, 10, EXPIRY);

        bytes[] memory updateData = _makePriceUpdate(STRIKE, 10, EXPIRY);
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(MeridianMarket.AlreadySettled.selector, marketId));
        market.settleMarket{value: 0}(marketId, updateData, EXPIRY - 30, EXPIRY + 120);
    }

    function test_settle_revertsNonSettler() public {
        vm.warp(EXPIRY + 1);
        bytes[] memory updateData = _makePriceUpdate(STRIKE, 10, EXPIRY);
        vm.prank(admin);
        vm.expectRevert();
        market.settleMarket{value: 0}(marketId, updateData, EXPIRY - 30, EXPIRY + 120);
    }

    // ── Confidence rejection ──────────────────────────────────────────────────

    function test_settle_revertsConfidenceTooWide() public {
        vm.warp(EXPIRY + 1);
        // price = 100_000, conf = 1_100 → ratio = 1100 * 10000 / 100000 = 110 bps > maxConfBps (100)
        bytes[] memory updateData = _makePriceUpdate(100_000, 1_100, EXPIRY);
        vm.prank(settler);
        vm.expectRevert();
        market.settleMarket{value: 0}(marketId, updateData, EXPIRY - 30, EXPIRY + 120);
    }

    // ── Expo mismatch ──────────────────────────────────────────────────────────

    function test_settle_revertsWrongExponent() public {
        // MockPyth encodes expo directly — use wrong expo
        // We test this via a custom encoded feed that doesn't match -5
        vm.warp(EXPIRY + 1);
        // Build a price update with expo = -4 (wrong)
        bytes[] memory updateData = new bytes[](1);
        updateData[0] = pyth.createPriceFeedUpdateData(
            AAPL_FEED,
            STRIKE,
            10,
            -4, // wrong expo
            STRIKE,
            10,
            EXPIRY
        );
        vm.prank(settler);
        vm.expectRevert();
        market.settleMarket{value: 0}(marketId, updateData, EXPIRY - 30, EXPIRY + 120);
    }

    // ── Unknown market ─────────────────────────────────────────────────────────

    function test_settle_revertsUnknownMarket() public {
        vm.warp(EXPIRY + 1);
        bytes[] memory updateData = _makePriceUpdate(STRIKE, 10, EXPIRY);
        bytes32 badId = bytes32("badmarket");
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSelector(MeridianMarket.MarketNotFound.selector, badId));
        market.settleMarket{value: 0}(badId, updateData, EXPIRY - 30, EXPIRY + 120);
    }
}

// ── AdminOverride tests ───────────────────────────────────────────────────────

contract AdminOverrideTest is Test {
    MeridianMarket internal market;
    MockUSDC internal usdc;
    MockPyth internal pyth;

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal settler = makeAddr("settler");

    bytes32 internal constant AAPL = bytes32("AAPL");
    bytes32 internal constant AAPL_FEED = 0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688;
    int64 internal constant STRIKE = 23_000_000;
    uint64 internal constant EXPIRY = 1_800_000_000;

    bytes32 internal marketId;

    function setUp() public {
        vm.startPrank(admin);
        pyth = new MockPyth(3600, 0);
        usdc = new MockUSDC();
        market = new MeridianMarket(address(pyth), address(usdc), admin, 50);
        market.grantRole(market.OPERATOR_ROLE(), operator);
        market.grantRole(market.SETTLER_ROLE(), settler);
        market.setSupportedFeed(AAPL, AAPL_FEED, true);
        vm.stopPrank();

        vm.prank(operator);
        marketId = market.createStrikeMarket(AAPL, STRIKE, EXPIRY);
    }

    function test_adminOverride_exactDelay_succeeds() public {
        vm.warp(EXPIRY + market.ADMIN_OVERRIDE_DELAY());
        vm.prank(admin);
        market.adminSettleOverride(marketId, STRIKE + 1);

        (, , , , , , , bool settled, bool yesWins) = market.markets(marketId);
        assertTrue(settled);
        assertTrue(yesWins);
    }

    function test_adminOverride_priceBelowStrike_noWins() public {
        vm.warp(EXPIRY + market.ADMIN_OVERRIDE_DELAY());
        vm.prank(admin);
        market.adminSettleOverride(marketId, STRIKE - 1);

        (, , , , , , , bool settled, bool yesWins) = market.markets(marketId);
        assertTrue(settled);
        assertFalse(yesWins);
    }

    function test_adminOverride_revertsTooEarly() public {
        vm.warp(EXPIRY + market.ADMIN_OVERRIDE_DELAY() - 1);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(MeridianMarket.MarketNotExpired.selector, marketId));
        market.adminSettleOverride(marketId, STRIKE);
    }

    function test_adminOverride_revertsNonAdmin() public {
        vm.warp(EXPIRY + market.ADMIN_OVERRIDE_DELAY());
        vm.prank(settler);
        vm.expectRevert();
        market.adminSettleOverride(marketId, STRIKE);
    }

    function test_adminOverride_revertsAlreadySettled() public {
        vm.warp(EXPIRY + market.ADMIN_OVERRIDE_DELAY());
        vm.prank(admin);
        market.adminSettleOverride(marketId, STRIKE);

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(MeridianMarket.AlreadySettled.selector, marketId));
        market.adminSettleOverride(marketId, STRIKE);
    }

    function test_adminOverride_emitsAdminSettled() public {
        vm.warp(EXPIRY + market.ADMIN_OVERRIDE_DELAY());
        vm.expectEmit(true, false, false, true);
        emit MeridianMarket.AdminSettled(marketId, true, STRIKE + 500);

        vm.prank(admin);
        market.adminSettleOverride(marketId, STRIKE + 500);
    }

    function test_adminOverride_atExactStrike_yesWins() public {
        vm.warp(EXPIRY + market.ADMIN_OVERRIDE_DELAY());
        vm.prank(admin);
        market.adminSettleOverride(marketId, STRIKE);

        (, , , , , , , , bool yesWins) = market.markets(marketId);
        assertTrue(yesWins);
    }
}
