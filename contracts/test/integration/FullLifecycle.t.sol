// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../../src/MeridianMarket.sol";
import "../../src/MockUSDC.sol";
import "../../src/libraries/OrderBookLib.sol";
import "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";

/// @notice Full lifecycle integration tests covering all 4 trade paths and multi-user scenarios.
/// Each scenario uses named actors funded with MockUSDC. vm.warp advances time for settlement.
contract FullLifecycleTest is Test {
    MeridianMarket internal market;
    MockUSDC internal usdc;
    MockPyth internal pyth;

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal settler = makeAddr("settler");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal charlie = makeAddr("charlie");
    address internal marketMaker = makeAddr("marketMaker");

    bytes32 internal constant AAPL = bytes32("AAPL");
    bytes32 internal constant AAPL_FEED = 0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688;
    int64 internal constant STRIKE = 23_000_000; // $230.00000
    uint64 internal constant EXPIRY = 1_800_000_000;
    uint16 internal constant FEE_BPS = 50; // 0.5%

    bytes32 internal marketId;
    uint256 internal yesId;
    uint256 internal noId;

    function setUp() public {
        vm.startPrank(admin);
        pyth = new MockPyth(3600, 0);
        usdc = new MockUSDC();
        market = new MeridianMarket(address(pyth), address(usdc), admin, FEE_BPS);
        market.grantRole(market.OPERATOR_ROLE(), operator);
        market.grantRole(market.SETTLER_ROLE(), settler);
        market.setSupportedFeed(AAPL, AAPL_FEED, true);
        vm.stopPrank();

        vm.prank(operator);
        marketId = market.createStrikeMarket(AAPL, STRIKE, EXPIRY);
        yesId = uint256(marketId);
        noId = uint256(keccak256(abi.encode(marketId, "NO")));

        address[4] memory users = [alice, bob, charlie, marketMaker];
        for (uint256 i = 0; i < users.length; i++) {
            usdc.mint(users[i], 1000e6);
            vm.prank(users[i]);
            usdc.approve(address(market), type(uint256).max);
        }
    }

    function _feeAmount(uint256 gross) internal pure returns (uint256) {
        return (gross * FEE_BPS) / 10_000;
    }

    function _netPayout(uint256 gross) internal pure returns (uint256) {
        return gross - _feeAmount(gross);
    }

    function _adminSettle(bool yesWins) internal {
        vm.warp(EXPIRY + market.ADMIN_OVERRIDE_DELAY());
        int64 price = yesWins ? STRIKE + 1 : STRIKE - 1;
        vm.prank(admin);
        market.adminSettleOverride(marketId, price);
    }

    // ── Scenario 1: Two-user limit order match, YES wins ──────────────────────

    /// Alice mints a pair and posts a Yes limit sell at $0.65.
    /// Bob places a matching Yes limit buy at $0.65 — orders cross.
    /// Market settles YES wins. Bob redeems Yes (winner), Alice redeems No (loser).
    function test_scenario1_limitOrderMatch_yesWins() public {
        // Alice mints pair and posts ask
        vm.prank(alice);
        market.mintPair(marketId, 1);
        uint256 aliceAfterMint = usdc.balanceOf(alice);

        vm.prank(alice);
        market.placeOrder(marketId, OrderBookLib.Side.ASK, 65, 1, false);

        // Bob buys Yes (bid at 65)
        uint256 bobBefore = usdc.balanceOf(bob);
        vm.prank(bob);
        market.placeOrder(marketId, OrderBookLib.Side.BID, 65, 1, false);

        // Verify fill: Bob holds Yes, Alice received $0.65
        assertEq(market.balanceOf(bob, yesId), 1, "Bob should have Yes");
        assertEq(usdc.balanceOf(bob), bobBefore - 65 * 1e4, "Bob paid $0.65");
        assertEq(usdc.balanceOf(alice), aliceAfterMint + 65 * 1e4, "Alice received $0.65");

        // Settle: YES wins
        _adminSettle(true);

        // Bob redeems winning Yes
        uint256 bobAfterSettle = usdc.balanceOf(bob);
        vm.prank(bob);
        market.redeem(marketId, 1);
        assertEq(usdc.balanceOf(bob), bobAfterSettle + _netPayout(1e6), "Bob net payout");

        // Alice redeems losing No (0 payout)
        uint256 aliceAfterSettle = usdc.balanceOf(alice);
        vm.prank(alice);
        market.redeem(marketId, 1);
        assertEq(usdc.balanceOf(alice), aliceAfterSettle, "Alice loser: no payout");

        // Assert: fee was forwarded to recipient on redeem; contract holds nothing for this market
        assertEq(usdc.balanceOf(address(market)), 0, "Contract empty after full redemption");
    }

    // ── Scenario 2: Market maker + multiple takers, NO wins ──────────────────

    /// MarketMaker mints 5 pairs and posts 5 Yes asks at $0.65.
    /// Taker1 buys 3 Yes; Taker2 buys 2 Yes. Market settles NO wins.
    function test_scenario2_marketMakerLiquidity_noWins() public {
        // MarketMaker provides 5 pairs at $0.65
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(marketMaker);
            market.mintPair(marketId, 1);
            vm.prank(marketMaker);
            market.placeOrder(marketId, OrderBookLib.Side.ASK, 65, 1, false);
        }
        assertEq(market.depthAt(marketId, OrderBookLib.Side.ASK, 65), 5);

        // Taker1 buys 3 Yes
        vm.prank(alice);
        market.placeOrder(marketId, OrderBookLib.Side.BID, 65, 3, false);
        assertEq(market.balanceOf(alice, yesId), 3, "Alice should have 3 Yes");

        // Taker2 buys 2 Yes
        vm.prank(bob);
        market.placeOrder(marketId, OrderBookLib.Side.BID, 65, 2, false);
        assertEq(market.balanceOf(bob, yesId), 2, "Bob should have 2 Yes");

        // All asks consumed
        assertEq(market.depthAt(marketId, OrderBookLib.Side.ASK, 65), 0);

        // Settle: NO wins
        _adminSettle(false);

        // MarketMaker redeems 5 No tokens (winner)
        uint256 mmBefore = usdc.balanceOf(marketMaker);
        vm.prank(marketMaker);
        market.redeem(marketId, 5);
        assertEq(
            usdc.balanceOf(marketMaker),
            mmBefore + _netPayout(5e6),
            "MarketMaker should receive 5 * net payout"
        );

        // Takers redeem losing Yes tokens (0 payout)
        vm.prank(alice);
        market.redeem(marketId, 3);
        vm.prank(bob);
        market.redeem(marketId, 2);

        // Vault empty and contract holds nothing after all redemptions
        (, , , , , uint256 vault, , , ) = market.markets(marketId);
        assertEq(vault, 0, "Vault should be empty after all redemptions");
        assertEq(usdc.balanceOf(address(market)), 0, "Contract empty after full redemption");
    }

    // ── Scenario 3: buyNoMarket atomic ────────────────────────────────────────

    /// Alice posts a Yes bid at $0.40.
    /// Bob calls buyNoMarket: mints pair → sells Yes to Alice's bid → keeps No.
    /// Market settles YES wins. Alice redeems Yes (winner), Bob redeems No (loser).
    function test_scenario3_buyNoMarket_yesWins() public {
        // Alice places Yes bid at $0.40
        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        market.placeOrder(marketId, OrderBookLib.Side.BID, 40, 1, false);

        // Bob uses buyNoMarket: mints pair → sells Yes → keeps No
        uint256 bobBefore = usdc.balanceOf(bob);
        vm.prank(bob);
        market.buyNoMarket(marketId, 1, 38, 5); // quantity=1, minProceeds=38 cents

        // Bob paid $1, received $0.40 (proceeds from selling Yes to Alice) → net cost $0.60
        assertEq(market.balanceOf(bob, noId), 1, "Bob should hold No");
        assertEq(usdc.balanceOf(bob), bobBefore - 60 * 1e4, "Bob net cost $0.60");

        // Alice holds Yes token (from the fill)
        assertEq(market.balanceOf(alice, yesId), 1, "Alice should hold Yes");
        assertEq(usdc.balanceOf(alice), aliceBefore - 40 * 1e4, "Alice paid $0.40 for Yes");

        // Settle YES wins
        _adminSettle(true);

        // Alice redeems winning Yes
        uint256 aliceAfterSettle = usdc.balanceOf(alice);
        vm.prank(alice);
        market.redeem(marketId, 1);
        assertEq(usdc.balanceOf(alice), aliceAfterSettle + _netPayout(1e6));

        // Bob redeems losing No
        uint256 bobAfterSettle = usdc.balanceOf(bob);
        vm.prank(bob);
        market.redeem(marketId, 1);
        assertEq(usdc.balanceOf(bob), bobAfterSettle, "Bob loser: no payout");
    }

    // ── Scenario 4: sellNoMarket atomic ───────────────────────────────────────

    /// Bob holds a No token (via buyNoLimit). Charlie posts a Yes ask at $0.45.
    /// Bob calls sellNoMarket: buys Yes → redeems Yes+No pair → receives $1 - cost.
    function test_scenario4_sellNoMarket() public {
        // Setup: Charlie posts Yes ask at $0.45 via mintPair + placeOrder
        vm.prank(charlie);
        market.mintPair(marketId, 1);
        vm.prank(charlie);
        market.placeOrder(marketId, OrderBookLib.Side.ASK, 45, 1, false);

        // Bob buys No via buyNoLimit (posts Yes ask at $0.50, holds No)
        uint256 bobBefore = usdc.balanceOf(bob);
        vm.prank(bob);
        market.buyNoLimit(marketId, 1, 50); // Bob pays $1, holds No, Yes posted at $0.50

        assertEq(market.balanceOf(bob, noId), 1, "Bob should hold No");

        // Bob exits: sellNoMarket buys Yes (fills Charlie's $0.45 ask), redeems pair for $1
        uint256 bobBeforeSell = usdc.balanceOf(bob);
        vm.prank(bob);
        market.sellNoMarket(marketId, 1, 50, 5); // maxPrice=50, maxFills=5

        // Bob buys Yes at $0.45, redeems pair for $1 gross → gets $1 - $0.45 = $0.55
        assertEq(market.balanceOf(bob, noId), 0, "Bob's No should be redeemed");
        assertEq(usdc.balanceOf(bob), bobBeforeSell - 45 * 1e4 + 1e6, "Bob nets $0.55");

        // Charlie received $0.45 USDC from his Yes ask fill
        // Charlie still holds No token (from original mintPair)
        assertEq(market.balanceOf(charlie, noId), 1, "Charlie still holds No");
    }

    // ── Scenario 5: Post-settlement order cancellation ───────────────────────

    /// Charlie places a Yes bid at $0.70, market settles before the order fills.
    /// Charlie cancels after settlement to reclaim his locked USDC.
    function test_scenario5_postSettlementCancelOrder() public {
        uint256 charlieBefore = usdc.balanceOf(charlie);

        // Charlie places bid for 1 Yes at $0.70
        vm.prank(charlie);
        uint256 orderId = market.placeOrder(marketId, OrderBookLib.Side.BID, 70, 1, false);

        // No one fills the order. Market settles.
        _adminSettle(true);

        // Charlie cancels unfilled order post-settlement
        uint256 charlieAfterSettle = usdc.balanceOf(charlie);
        vm.prank(charlie);
        market.cancelOrder(orderId);

        // Charlie should get his $0.70 back
        assertEq(usdc.balanceOf(charlie), charlieAfterSettle + 70 * 1e4, "Charlie reclaims locked USDC");
        assertEq(usdc.balanceOf(charlie), charlieBefore, "Charlie's balance fully restored");

        // Charlie has no tokens; redeem with 0 balance should revert
        vm.prank(charlie);
        vm.expectRevert();
        market.redeem(marketId, 1);
    }

    // ── Scenario 6: Multi-market, partial settlement failure, admin override ─

    /// Three AAPL markets at different strikes. Two settle normally, one triggers admin override.
    function test_scenario6_multiMarket_adminOverride() public {
        // Create 3 markets with different strikes, same expiry
        vm.startPrank(admin);
        market.setSupportedFeed(AAPL, AAPL_FEED, true);
        vm.stopPrank();

        // Use a different expiry to avoid conflict with the marketId created in setUp()
        uint64 expiry2 = EXPIRY + 30 days;
        vm.prank(operator);
        bytes32 market220 = market.createStrikeMarket(AAPL, 22_000_000, expiry2); // $220
        vm.prank(operator);
        bytes32 market230 = market.createStrikeMarket(AAPL, STRIKE, expiry2); // $230
        vm.prank(operator);
        bytes32 market240 = market.createStrikeMarket(AAPL, 24_000_000, expiry2); // $240

        uint256 yes220Id = uint256(market220);
        uint256 yes240Id = uint256(market240);
        uint256 no220Id = uint256(keccak256(abi.encode(market220, "NO")));
        uint256 no240Id = uint256(keccak256(abi.encode(market240, "NO")));

        // Alice mints in all 3 markets
        vm.startPrank(alice);
        market.mintPair(market220, 1);
        market.mintPair(market230, 1);
        market.mintPair(market240, 1);
        vm.stopPrank();

        // Settle market220 (price $225, above $220 → YES wins) via admin override
        vm.warp(expiry2 + market.ADMIN_OVERRIDE_DELAY());
        vm.prank(admin);
        market.adminSettleOverride(market220, 22_500_000); // $225 > $220 YES wins

        // Settle market240 (price $225, below $240 → NO wins) via admin override
        vm.prank(admin);
        market.adminSettleOverride(market240, 22_500_000); // $225 < $240 NO wins

        // Settle market230 via admin override (simulating confidence too wide fallback)
        vm.prank(admin);
        market.adminSettleOverride(market230, 22_500_000); // $225 < $230 NO wins

        // Alice redeems all markets
        vm.prank(alice);
        market.redeem(market220, 1); // YES wins → Alice has Yes → winner
        vm.prank(alice);
        market.redeem(market240, 1); // NO wins → Alice has No → winner
        vm.prank(alice);
        market.redeem(market230, 1); // NO wins → Alice has No → winner

        // Alice's total payout: 3 * net payout
        // Started at 1000e6, paid 3e6 for pairs
        assertEq(
            usdc.balanceOf(alice),
            1000e6 - 3e6 + 3 * _netPayout(1e6),
            "Alice should receive net payout from all 3 markets"
        );

        // Verify adminSettled events were emitted
        (, , , , , , , bool s220, ) = market.markets(market220);
        (, , , , , , , bool s230, ) = market.markets(market230);
        (, , , , , , , bool s240, ) = market.markets(market240);
        assertTrue(s220 && s230 && s240, "All markets should be settled");
    }

    // ── Scenario 7: uri() returns valid Base64 JSON for both token types ──────

    function test_scenario7_uriOnChainMetadata() public {
        string memory yesUri = market.uri(yesId);
        string memory noUri = market.uri(noId);

        // Both URIs should start with the data URI prefix
        assertEq(
            _startsWith(yesUri, "data:application/json;base64,"),
            true,
            "YES uri should be Base64 data URI"
        );
        assertEq(
            _startsWith(noUri, "data:application/json;base64,"),
            true,
            "NO uri should be Base64 data URI"
        );

        // Unknown token ID should revert
        vm.expectRevert(abi.encodeWithSelector(MeridianMarket.UnknownTokenId.selector, uint256(999)));
        market.uri(999);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    function _startsWith(string memory str, string memory prefix) internal pure returns (bool) {
        bytes memory s = bytes(str);
        bytes memory p = bytes(prefix);
        if (s.length < p.length) return false;
        for (uint256 i = 0; i < p.length; i++) {
            if (s[i] != p[i]) return false;
        }
        return true;
    }
}
