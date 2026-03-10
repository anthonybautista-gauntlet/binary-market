// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../../src/MeridianMarket.sol";
import "../../src/MockUSDC.sol";
import "../../src/libraries/OrderBookLib.sol";
import "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";

contract PauseTest is Test {
    MeridianMarket internal market;
    MockUSDC internal usdc;
    MockPyth internal pyth;

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal settler = makeAddr("settler");
    address internal alice = makeAddr("alice");

    bytes32 internal constant AAPL = bytes32("AAPL");
    bytes32 internal constant AAPL_FEED = 0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688;
    int64 internal constant STRIKE = 23_000_000;
    uint64 internal constant EXPIRY = 1_800_000_000;

    bytes32 internal marketId;
    uint256 internal yesId;

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
        yesId = uint256(marketId);

        usdc.mint(alice, 100e6);
        vm.prank(alice);
        usdc.approve(address(market), type(uint256).max);
    }

    // ── Pause blocks new risk-taking ──────────────────────────────────────────

    function test_pause_blocksMintPair() public {
        vm.prank(admin);
        market.pause();

        vm.prank(alice);
        vm.expectRevert();
        market.mintPair(marketId, 1);
    }

    function test_pause_blocksPlaceOrder() public {
        vm.prank(admin);
        market.pause();

        vm.prank(alice);
        vm.expectRevert();
        market.placeOrder(marketId, OrderBookLib.Side.BID, 50, 1, false);
    }

    function test_pause_blocksBuyNoMarket() public {
        vm.prank(admin);
        market.pause();

        vm.prank(alice);
        vm.expectRevert();
        market.buyNoMarket(marketId, 1, 0, 5);
    }

    function test_pause_blocksBuyNoLimit() public {
        vm.prank(admin);
        market.pause();

        vm.prank(alice);
        vm.expectRevert();
        market.buyNoLimit(marketId, 1, 50);
    }

    function test_pause_blocksSellNoMarket() public {
        vm.prank(admin);
        market.pause();

        vm.prank(alice);
        vm.expectRevert();
        market.sellNoMarket(marketId, 1, 50, 5);
    }

    // ── Pause allows cancellation (users can always exit) ────────────────────

    function test_pause_allowsCancelOrder() public {
        // Alice places a bid first (before pause)
        vm.prank(alice);
        uint256 orderId = market.placeOrder(marketId, OrderBookLib.Side.BID, 50, 1, false);

        vm.prank(admin);
        market.pause();

        // Cancel should still work while paused
        vm.prank(alice);
        market.cancelOrder(orderId); // should NOT revert
        assertEq(market.depthAt(marketId, OrderBookLib.Side.BID, 50), 0);
    }

    function test_pause_allowsBulkCancelOrders() public {
        uint256[] memory ids = new uint256[](2);
        vm.prank(alice);
        ids[0] = market.placeOrder(marketId, OrderBookLib.Side.BID, 50, 1, false);
        vm.prank(alice);
        ids[1] = market.placeOrder(marketId, OrderBookLib.Side.BID, 60, 1, false);

        vm.prank(admin);
        market.pause();

        vm.prank(alice);
        market.bulkCancelOrders(ids); // should NOT revert
    }

    // ── Pause allows settlement ───────────────────────────────────────────────

    function test_pause_allowsSettlement() public {
        vm.prank(admin);
        market.pause();

        vm.warp(EXPIRY + market.ADMIN_OVERRIDE_DELAY());
        vm.prank(admin);
        market.adminSettleOverride(marketId, STRIKE + 1); // should NOT revert

        (, , , , , , , bool settled, ) = market.markets(marketId);
        assertTrue(settled);
    }

    // ── Pause allows redemption ───────────────────────────────────────────────

    function test_pause_allowsRedeem() public {
        vm.prank(alice);
        market.mintPair(marketId, 1);

        vm.prank(admin);
        market.pause();

        vm.warp(EXPIRY + market.ADMIN_OVERRIDE_DELAY());
        vm.prank(admin);
        market.adminSettleOverride(marketId, STRIKE + 1); // YES wins

        // Redeem should still work while paused
        vm.prank(alice);
        market.redeem(marketId, 1); // should NOT revert
    }

    // ── Unpause restores normal operation ────────────────────────────────────

    function test_unpause_restoresMintPair() public {
        vm.prank(admin);
        market.pause();

        vm.prank(admin);
        market.unpause();

        vm.prank(alice);
        market.mintPair(marketId, 1); // should succeed after unpause
        assertEq(market.balanceOf(alice, yesId), 1);
    }
}
