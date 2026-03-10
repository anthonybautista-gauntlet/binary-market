// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import "../../src/MeridianMarket.sol";
import "../../src/MockUSDC.sol";
import "../../src/libraries/OrderBookLib.sol";
import "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";

/// @notice Gas measurement tests: how much does a placeOrder call cost at 1, 5, and 10 fills?
contract GasBreakdownTest is Test {
    MeridianMarket internal market;
    MockUSDC internal usdc;
    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    bytes32 internal constant AAPL = bytes32("AAPL");
    bytes32 internal constant AAPL_FEED = 0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688;
    bytes32 internal marketId;

    function setUp() public {
        vm.startPrank(admin);
        MockPyth pyth = new MockPyth(60, 0);
        usdc = new MockUSDC();
        market = new MeridianMarket(address(pyth), address(usdc), admin, 50);
        market.grantRole(market.OPERATOR_ROLE(), operator);
        market.setSupportedFeed(AAPL, AAPL_FEED, true);
        vm.stopPrank();
        vm.prank(operator);
        marketId = market.createStrikeMarket(AAPL, 23_000_000, 1_800_000_000);
    }

    function _fund(string memory name) internal returns (address u) {
        u = makeAddr(name);
        usdc.mint(u, 10_000e6);
        vm.prank(u);
        usdc.approve(address(market), type(uint256).max);
    }

    /// Post n separate 1-token ASK orders from maker, then taker hits them all with one BID.
    function _setupAsks(address maker, uint256 n) internal {
        for (uint256 i = 0; i < n; i++) {
            vm.prank(maker); market.mintPair(marketId, 1);
            vm.prank(maker); market.placeOrder(marketId, OrderBookLib.Side.ASK, 65, 1, false);
        }
    }

    // 1 fill — taker crosses 1 resting order
    function test_gas_placeOrder_1fill() public {
        address maker = _fund("maker");
        _setupAsks(maker, 1);
        address taker = _fund("taker");
        vm.prank(taker);
        market.placeOrder(marketId, OrderBookLib.Side.BID, 65, 1, false);
    }

    // 5 fills — taker crosses 5 individual resting orders (worst-case for 5)
    function test_gas_placeOrder_5fills() public {
        address maker = _fund("maker");
        _setupAsks(maker, 5);
        address taker = _fund("taker");
        vm.prank(taker);
        market.placeOrder(marketId, OrderBookLib.Side.BID, 65, 5, false);
    }

    // 10 fills — taker crosses 10 individual resting orders (absolute worst-case)
    function test_gas_placeOrder_10fills() public {
        address maker = _fund("maker");
        _setupAsks(maker, 10);
        address taker = _fund("taker");
        vm.prank(taker);
        market.placeOrder(marketId, OrderBookLib.Side.BID, 65, 10, false);
    }

    // 100 fills — absolute worst case (100 separate 1-token ASK orders from different makers)
    function test_gas_placeOrder_100fills() public {
        // Use different makers so each order is a separate resting entry
        for (uint256 i = 0; i < 100; i++) {
            address maker = _fund(string.concat("maker", vm.toString(i)));
            vm.prank(maker); market.mintPair(marketId, 1);
            vm.prank(maker); market.placeOrder(marketId, OrderBookLib.Side.ASK, 65, 1, false);
        }
        address taker = _fund("taker");
        usdc.mint(taker, 200e6);
        vm.prank(taker);
        market.placeOrder(marketId, OrderBookLib.Side.BID, 65, 100, false);
    }

    // Realistic: 1 fill for a large quantity (market maker posted 100 tokens in one order)
    function test_gas_placeOrder_1fill_100tokens() public {
        address maker = _fund("maker");
        usdc.mint(maker, 200e6);
        for (uint256 i = 0; i < 100; i++) {
            vm.prank(maker); market.mintPair(marketId, 1);
        }
        vm.prank(maker);
        market.placeOrder(marketId, OrderBookLib.Side.ASK, 65, 100, false);

        address taker = _fund("taker");
        usdc.mint(taker, 200e6);
        vm.prank(taker);
        market.placeOrder(marketId, OrderBookLib.Side.BID, 65, 100, false);
    }
}
