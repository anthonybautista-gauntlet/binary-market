// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../../src/MeridianMarket.sol";
import "../../src/MockUSDC.sol";
import "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";

contract AccessControlTest is Test {
    MeridianMarket internal market;
    MockUSDC internal usdc;
    MockPyth internal pyth;

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal settler = makeAddr("settler");
    address internal rando = makeAddr("rando");

    bytes32 internal constant AAPL = bytes32("AAPL");
    bytes32 internal constant AAPL_FEED = 0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688;

    function setUp() public {
        vm.startPrank(admin);
        pyth = new MockPyth(3600, 0);
        usdc = new MockUSDC();
        market = new MeridianMarket(address(pyth), address(usdc), admin, 50);
        market.grantRole(market.OPERATOR_ROLE(), operator);
        market.grantRole(market.SETTLER_ROLE(), settler);
        market.setSupportedFeed(AAPL, AAPL_FEED, true);
        vm.stopPrank();
    }

    // ── DEFAULT_ADMIN_ROLE functions ───────────────────────────────────────────

    function test_setFee_requiresAdmin() public {
        vm.prank(rando);
        vm.expectRevert();
        market.setFee(100);

        vm.prank(operator);
        vm.expectRevert();
        market.setFee(100);

        vm.prank(admin);
        market.setFee(100); // should succeed
        assertEq(market.feeBps(), 100);
    }

    function test_setFeeRecipient_requiresAdmin() public {
        vm.prank(rando);
        vm.expectRevert();
        market.setFeeRecipient(rando);

        vm.prank(admin);
        market.setFeeRecipient(rando); // should succeed
        assertEq(market.feeRecipient(), rando);
    }

    function test_setOracle_requiresAdmin() public {
        vm.prank(rando);
        vm.expectRevert();
        market.setOracle(rando);

        vm.prank(admin);
        market.setOracle(rando); // should succeed
    }

    function test_setSupportedFeed_requiresAdmin() public {
        vm.prank(rando);
        vm.expectRevert();
        market.setSupportedFeed(bytes32("TSLA"), bytes32(0), true);

        vm.prank(operator);
        vm.expectRevert();
        market.setSupportedFeed(bytes32("TSLA"), bytes32(0), true);

        vm.prank(admin);
        market.setSupportedFeed(bytes32("TSLA"), bytes32(0), true); // succeed
    }

    function test_pause_requiresAdmin() public {
        vm.prank(rando);
        vm.expectRevert();
        market.pause();

        vm.prank(admin);
        market.pause(); // should succeed
        assertTrue(market.paused());
    }

    function test_unpause_requiresAdmin() public {
        vm.prank(admin);
        market.pause();

        vm.prank(rando);
        vm.expectRevert();
        market.unpause();

        vm.prank(admin);
        market.unpause();
        assertFalse(market.paused());
    }


    function test_adminSettleOverride_requiresAdmin() public {
        bytes32 marketId = _createMarket();
        vm.warp(1_800_000_000 + market.ADMIN_OVERRIDE_DELAY());

        vm.prank(settler);
        vm.expectRevert();
        market.adminSettleOverride(marketId, 23_000_000);

        vm.prank(admin);
        market.adminSettleOverride(marketId, 23_000_000); // should succeed
    }

    // ── OPERATOR_ROLE functions ────────────────────────────────────────────────

    function test_createStrikeMarket_requiresOperator() public {
        vm.prank(rando);
        vm.expectRevert();
        market.createStrikeMarket(AAPL, 23_000_000, 1_800_000_000);

        vm.prank(admin);
        vm.expectRevert();
        market.createStrikeMarket(AAPL, 23_000_000, 1_800_000_000);

        vm.prank(operator);
        market.createStrikeMarket(AAPL, 23_000_000, 1_800_000_000); // succeed
    }

    // ── SETTLER_ROLE functions ─────────────────────────────────────────────────

    function test_settleMarket_requiresSettler() public {
        bytes32 marketId = _createMarket();
        vm.warp(1_800_000_000 + 1);

        bytes[] memory updateData = new bytes[](1);
        updateData[0] = MockPyth(address(market.pyth())).createPriceFeedUpdateData(
            AAPL_FEED, 23_000_000, 10, -5, 23_000_000, 10, 1_800_000_000
        );

        vm.prank(rando);
        vm.expectRevert();
        market.settleMarket{value: 0}(
            marketId, updateData, 1_800_000_000 - 30, 1_800_000_000 + 120
        );

        vm.prank(admin);
        vm.expectRevert();
        market.settleMarket{value: 0}(
            marketId, updateData, 1_800_000_000 - 30, 1_800_000_000 + 120
        );

        vm.prank(settler);
        market.settleMarket{value: 0}(
            marketId, updateData, 1_800_000_000 - 30, 1_800_000_000 + 120
        ); // should succeed
    }

    // ── Role grant/revoke ──────────────────────────────────────────────────────

    function test_grantRole_onlyAdmin() public {
        // Cache role value first to avoid consuming the prank with an extra external call
        bytes32 opRole = market.OPERATOR_ROLE();

        vm.prank(rando);
        vm.expectRevert();
        market.grantRole(opRole, rando);

        vm.prank(admin);
        market.grantRole(opRole, rando);
        assertTrue(market.hasRole(opRole, rando));
    }

    function test_revokeRole_onlyAdmin() public {
        bytes32 opRole = market.OPERATOR_ROLE();

        vm.prank(admin);
        market.revokeRole(opRole, operator);
        assertFalse(market.hasRole(opRole, operator));

        vm.prank(operator);
        vm.expectRevert();
        market.createStrikeMarket(AAPL, 23_000_000, 1_800_000_000);
    }

    // ── Helper ────────────────────────────────────────────────────────────────

    function _createMarket() internal returns (bytes32) {
        vm.prank(operator);
        return market.createStrikeMarket(AAPL, 23_000_000, 1_800_000_000);
    }
}
