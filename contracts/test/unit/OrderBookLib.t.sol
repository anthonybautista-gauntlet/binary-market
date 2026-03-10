// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../../src/libraries/OrderBookLib.sol";

/// @dev Harness exposes internal library functions as external calls.
contract OrderBookHarness {
    using OrderBookLib for OrderBookLib.Book;

    OrderBookLib.Book internal book;

    function insert(
        OrderBookLib.Side side,
        uint8 priceCents,
        uint128 quantity,
        address owner
    ) external returns (uint256) {
        return book.insert(side, priceCents, quantity, owner);
    }

    function remove(uint256 orderId) external {
        book.remove(orderId);
    }

    function applyFill(uint256 orderId, uint128 fillQty) external {
        book.applyFill(orderId, fillQty);
    }

    function matchMarket(
        OrderBookLib.Side takerSide,
        uint128 quantity,
        uint8 maxFills,
        bool isIOC,
        address taker,
        uint8 fallbackPostPriceCents
    ) external returns (OrderBookLib.FillResult memory) {
        return book.matchMarket(takerSide, quantity, maxFills, isIOC, taker, fallbackPostPriceCents);
    }

    function matchLimit(
        OrderBookLib.Side takerSide,
        uint8 priceCents,
        uint128 quantity,
        address taker
    ) external returns (OrderBookLib.FillResult memory) {
        return book.matchLimit(takerSide, priceCents, quantity, taker);
    }

    function bestBid() external view returns (uint8) {
        return book.bestBid();
    }

    function bestAsk() external view returns (uint8) {
        return book.bestAsk();
    }

    function depthAt(OrderBookLib.Side side, uint8 priceCents) external view returns (uint128) {
        return book.depthAt(side, priceCents);
    }

    function ownerOf(uint256 orderId) external view returns (address) {
        return book.ownerOf(orderId);
    }

    function remainingOf(uint256 orderId) external view returns (uint128) {
        return book.remainingOf(orderId);
    }

    function nextOrderId() external view returns (uint256) {
        return book.nextOrderId;
    }
}

contract OrderBookLibTest is Test {
    OrderBookHarness internal h;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal charlie = makeAddr("charlie");

    function setUp() public {
        h = new OrderBookHarness();
    }

    // ── Insert ────────────────────────────────────────────────────────────────

    function test_insert_basicBid() public {
        uint256 id = h.insert(OrderBookLib.Side.BID, 50, 10, alice);
        assertEq(id, 1);
        assertEq(h.ownerOf(id), alice);
        assertEq(h.remainingOf(id), 10);
        assertEq(h.depthAt(OrderBookLib.Side.BID, 50), 10);
    }

    function test_insert_basicAsk() public {
        uint256 id = h.insert(OrderBookLib.Side.ASK, 65, 5, bob);
        assertEq(id, 1);
        assertEq(h.ownerOf(id), bob);
        assertEq(h.remainingOf(id), 5);
        assertEq(h.depthAt(OrderBookLib.Side.ASK, 65), 5);
    }

    function test_insert_multipleOrders_incrementIds() public {
        uint256 id1 = h.insert(OrderBookLib.Side.BID, 50, 5, alice);
        uint256 id2 = h.insert(OrderBookLib.Side.BID, 50, 3, bob);
        assertEq(id1, 1);
        assertEq(id2, 2);
        assertEq(h.depthAt(OrderBookLib.Side.BID, 50), 8);
    }

    function test_insert_revertsInvalidPriceTooLow() public {
        vm.expectRevert(abi.encodeWithSelector(OrderBookLib.InvalidPrice.selector, 0));
        h.insert(OrderBookLib.Side.BID, 0, 1, alice);
    }

    function test_insert_revertsInvalidPriceTooHigh() public {
        vm.expectRevert(abi.encodeWithSelector(OrderBookLib.InvalidPrice.selector, 100));
        h.insert(OrderBookLib.Side.ASK, 100, 1, alice);
    }

    function test_insert_revertsZeroQuantity() public {
        vm.expectRevert(OrderBookLib.InvalidQuantity.selector);
        h.insert(OrderBookLib.Side.BID, 50, 0, alice);
    }

    function test_insert_boundaryPrices() public {
        uint256 id1 = h.insert(OrderBookLib.Side.BID, 1, 1, alice);
        uint256 id2 = h.insert(OrderBookLib.Side.ASK, 99, 1, bob);
        assertEq(h.depthAt(OrderBookLib.Side.BID, 1), 1);
        assertEq(h.depthAt(OrderBookLib.Side.ASK, 99), 1);
        assertEq(id1, 1);
        assertEq(id2, 2);
    }

    // ── Remove ────────────────────────────────────────────────────────────────

    function test_remove_single() public {
        uint256 id = h.insert(OrderBookLib.Side.BID, 50, 10, alice);
        h.remove(id);
        assertEq(h.ownerOf(id), address(0));
        assertEq(h.depthAt(OrderBookLib.Side.BID, 50), 0);
    }

    function test_remove_head_of_two() public {
        uint256 id1 = h.insert(OrderBookLib.Side.BID, 50, 5, alice);
        uint256 id2 = h.insert(OrderBookLib.Side.BID, 50, 3, bob);
        h.remove(id1);
        assertEq(h.ownerOf(id1), address(0));
        assertEq(h.remainingOf(id2), 3);
        assertEq(h.depthAt(OrderBookLib.Side.BID, 50), 3);
    }

    function test_remove_tail_of_two() public {
        uint256 id1 = h.insert(OrderBookLib.Side.BID, 50, 5, alice);
        uint256 id2 = h.insert(OrderBookLib.Side.BID, 50, 3, bob);
        h.remove(id2);
        assertEq(h.ownerOf(id2), address(0));
        assertEq(h.remainingOf(id1), 5);
        assertEq(h.depthAt(OrderBookLib.Side.BID, 50), 5);
    }

    function test_remove_middleOfThree() public {
        uint256 id1 = h.insert(OrderBookLib.Side.ASK, 60, 5, alice);
        uint256 id2 = h.insert(OrderBookLib.Side.ASK, 60, 3, bob);
        uint256 id3 = h.insert(OrderBookLib.Side.ASK, 60, 2, charlie);
        h.remove(id2); // remove middle
        assertEq(h.ownerOf(id2), address(0));
        assertEq(h.depthAt(OrderBookLib.Side.ASK, 60), 7);
        // id1 and id3 should still be fillable via matchMarket
    }

    function test_remove_nonExistent_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(OrderBookLib.OrderNotFound.selector, 999));
        h.remove(999);
    }

    // ── bestBid / bestAsk ─────────────────────────────────────────────────────

    function test_bestBid_returnsHighest() public {
        h.insert(OrderBookLib.Side.BID, 40, 1, alice);
        h.insert(OrderBookLib.Side.BID, 70, 1, bob);
        assertEq(h.bestBid(), 70);
    }

    function test_bestAsk_returnsLowest() public {
        h.insert(OrderBookLib.Side.ASK, 80, 1, alice);
        h.insert(OrderBookLib.Side.ASK, 60, 1, bob);
        assertEq(h.bestAsk(), 60);
    }

    function test_bestBid_emptyReturnsZero() public view {
        assertEq(h.bestBid(), 0);
    }

    function test_bestAsk_emptyReturnsZero() public view {
        assertEq(h.bestAsk(), 0);
    }

    function test_bestBid_updatesAfterRemoval() public {
        uint256 id = h.insert(OrderBookLib.Side.BID, 70, 1, alice);
        h.insert(OrderBookLib.Side.BID, 50, 1, bob);
        h.remove(id);
        assertEq(h.bestBid(), 50);
    }

    // ── matchMarket ───────────────────────────────────────────────────────────

    function test_matchMarket_simpleFill_bidSweepsAsk() public {
        // Alice posts ask at $0.65 for 10 tokens
        h.insert(OrderBookLib.Side.ASK, 65, 10, alice);

        // Bob wants to buy 5 tokens at market
        OrderBookLib.FillResult memory result = h.matchMarket(
            OrderBookLib.Side.BID, 5, 10, false, bob, 65
        );

        assertEq(result.filledQty, 5);
        assertEq(result.usdcTradedCents, 5 * 65); // 325 cents
        assertEq(result.remainderQty, 0);
        assertTrue(result.fullyFilled);
        assertEq(h.depthAt(OrderBookLib.Side.ASK, 65), 5); // 5 remain
    }

    function test_matchMarket_bidSweepsAsk_fullFill() public {
        h.insert(OrderBookLib.Side.ASK, 65, 3, alice);

        OrderBookLib.FillResult memory result = h.matchMarket(
            OrderBookLib.Side.BID, 3, 10, false, bob, 65
        );

        assertEq(result.filledQty, 3);
        assertTrue(result.fullyFilled);
        assertEq(h.depthAt(OrderBookLib.Side.ASK, 65), 0);
    }

    function test_matchMarket_askSweepsBid() public {
        h.insert(OrderBookLib.Side.BID, 40, 10, alice);

        OrderBookLib.FillResult memory result = h.matchMarket(
            OrderBookLib.Side.ASK, 4, 10, false, bob, 40
        );

        assertEq(result.filledQty, 4);
        assertEq(result.usdcTradedCents, 4 * 40); // 160 cents
        assertTrue(result.fullyFilled);
    }

    function test_matchMarket_sweepsMultipleLevels() public {
        h.insert(OrderBookLib.Side.ASK, 60, 3, alice);
        h.insert(OrderBookLib.Side.ASK, 70, 3, bob);

        OrderBookLib.FillResult memory result = h.matchMarket(
            OrderBookLib.Side.BID, 6, 10, false, charlie, 70
        );

        assertEq(result.filledQty, 6);
        // 3 * 60 + 3 * 70 = 180 + 210 = 390
        assertEq(result.usdcTradedCents, 390);
        assertEq(result.worstFillPrice, 70);
        assertTrue(result.fullyFilled);
    }

    function test_matchMarket_IOC_partialFill_refundsRemainder() public {
        h.insert(OrderBookLib.Side.ASK, 65, 3, alice); // only 3 available

        OrderBookLib.FillResult memory result = h.matchMarket(
            OrderBookLib.Side.BID, 5, 10, true, bob, 65 // isIOC = true
        );

        assertEq(result.filledQty, 3);
        assertEq(result.remainderQty, 2); // 2 discarded
        assertFalse(result.fullyFilled);
    }

    function test_matchMarket_IOC_zeroFills_doesNotRevert() public {
        // No liquidity but isIOC=true → no revert, filledQty == 0
        OrderBookLib.FillResult memory result = h.matchMarket(
            OrderBookLib.Side.BID, 5, 10, true, bob, 65
        );
        assertEq(result.filledQty, 0);
        assertEq(result.remainderQty, 5);
    }

    function test_matchMarket_notIOC_zeroFills_revertsNoLiquidity() public {
        // vm.expectRevert cannot synthesize the Fill[100] return value; use try/catch instead.
        try h.matchMarket(OrderBookLib.Side.BID, 5, 10, false, bob, 65)
            returns (OrderBookLib.FillResult memory) {
            revert("expected NoLiquidity revert");
        } catch (bytes memory err) {
            assertEq(bytes4(err), OrderBookLib.NoLiquidity.selector);
        }
    }

    function test_matchMarket_notIOC_partialFill_returnsRemainder() public {
        h.insert(OrderBookLib.Side.ASK, 65, 2, alice);

        OrderBookLib.FillResult memory result = h.matchMarket(
            OrderBookLib.Side.BID, 5, 10, false, bob, 65 // isIOC = false
        );

        assertEq(result.filledQty, 2);
        assertEq(result.remainderQty, 3); // caller posts remainder at fallback price
        assertFalse(result.fullyFilled);
    }

    function test_matchMarket_selfTrade_reverts() public {
        h.insert(OrderBookLib.Side.ASK, 65, 5, alice);

        try h.matchMarket(OrderBookLib.Side.BID, 5, 10, false, alice, 65)
            returns (OrderBookLib.FillResult memory) {
            revert("expected SelfTradeNotAllowed revert");
        } catch (bytes memory err) {
            assertEq(bytes4(err), OrderBookLib.SelfTradeNotAllowed.selector);
        }
    }

    function test_matchMarket_respectsHardMaxFills() public {
        // Insert 101 asks each for 1 token (exceeds HARD_MAX_FILLS = 100)
        for (uint256 i = 0; i < 101; i++) {
            h.insert(OrderBookLib.Side.ASK, 65, 1, bob);
        }

        OrderBookLib.FillResult memory result = h.matchMarket(
            OrderBookLib.Side.BID, 101, 101, false, alice, 65
        );

        // Only 100 fills allowed by HARD_MAX_FILLS
        assertEq(result.filledQty, 100);
        assertEq(result.remainderQty, 1);
    }

    // ── matchLimit ────────────────────────────────────────────────────────────

    function test_matchLimit_noCross_returnsZeroFilled() public {
        h.insert(OrderBookLib.Side.ASK, 70, 5, alice);

        // Bob places buy limit at 60 — does not cross ask at 70
        OrderBookLib.FillResult memory result = h.matchLimit(
            OrderBookLib.Side.BID, 60, 5, bob
        );

        assertEq(result.filledQty, 0);
        assertEq(result.remainderQty, 5);
    }

    function test_matchLimit_crosses_exactFill() public {
        h.insert(OrderBookLib.Side.ASK, 65, 5, alice);

        OrderBookLib.FillResult memory result = h.matchLimit(
            OrderBookLib.Side.BID, 65, 5, bob
        );

        assertEq(result.filledQty, 5);
        assertTrue(result.fullyFilled);
    }

    function test_matchLimit_crosses_partialFill() public {
        h.insert(OrderBookLib.Side.ASK, 65, 3, alice);

        OrderBookLib.FillResult memory result = h.matchLimit(
            OrderBookLib.Side.BID, 65, 5, bob
        );

        assertEq(result.filledQty, 3);
        assertEq(result.remainderQty, 2);
        assertFalse(result.fullyFilled);
    }

    function test_matchLimit_selfTrade_reverts() public {
        h.insert(OrderBookLib.Side.ASK, 65, 5, alice);

        try h.matchLimit(OrderBookLib.Side.BID, 65, 5, alice)
            returns (OrderBookLib.FillResult memory) {
            revert("expected SelfTradeNotAllowed revert");
        } catch (bytes memory err) {
            assertEq(bytes4(err), OrderBookLib.SelfTradeNotAllowed.selector);
        }
    }

    // ── Price-time priority ───────────────────────────────────────────────────

    function test_priceTimePriority_samePrice_FIFO() public {
        // Alice and Bob both post asks at $0.65; Alice was first
        uint256 idAlice = h.insert(OrderBookLib.Side.ASK, 65, 5, alice);
        uint256 idBob = h.insert(OrderBookLib.Side.ASK, 65, 5, bob);

        // Charlie buys 5 — should fill Alice's order first
        h.matchMarket(OrderBookLib.Side.BID, 5, 10, false, charlie, 65);

        // Alice's order fully consumed, Bob's intact
        assertEq(h.ownerOf(idAlice), address(0)); // removed
        assertEq(h.remainingOf(idBob), 5);
    }

    function test_pricePriority_bestAskFilledFirst() public {
        h.insert(OrderBookLib.Side.ASK, 70, 5, alice);
        h.insert(OrderBookLib.Side.ASK, 60, 5, bob); // better ask

        // Charlie buys 5 — should fill Bob's $0.60 ask first
        OrderBookLib.FillResult memory result = h.matchMarket(
            OrderBookLib.Side.BID, 5, 10, false, charlie, 60
        );

        assertEq(result.worstFillPrice, 60);
        assertEq(h.depthAt(OrderBookLib.Side.ASK, 60), 0);
        assertEq(h.depthAt(OrderBookLib.Side.ASK, 70), 5);
    }

    // ── Partial fill → applyFill ──────────────────────────────────────────────

    function test_applyFill_partialReducesQty() public {
        uint256 id = h.insert(OrderBookLib.Side.ASK, 65, 10, alice);
        h.applyFill(id, 4);
        assertEq(h.remainingOf(id), 6);
        assertEq(h.depthAt(OrderBookLib.Side.ASK, 65), 6);
    }

    function test_applyFill_fullFill_removesOrder() public {
        uint256 id = h.insert(OrderBookLib.Side.ASK, 65, 5, alice);
        h.applyFill(id, 5);
        assertEq(h.ownerOf(id), address(0));
        assertEq(h.depthAt(OrderBookLib.Side.ASK, 65), 0);
    }

    // ── Fuzz ──────────────────────────────────────────────────────────────────

    function testFuzz_insert_validPriceRange(uint8 price, uint128 qty) public {
        vm.assume(price >= 1 && price <= 99);
        vm.assume(qty > 0 && qty < type(uint128).max / 2);
        uint256 id = h.insert(OrderBookLib.Side.BID, price, qty, alice);
        assertEq(h.remainingOf(id), qty);
        assertEq(h.depthAt(OrderBookLib.Side.BID, price), qty);
    }
}
