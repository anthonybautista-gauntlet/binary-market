// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../../src/MeridianMarket.sol";
import "../../src/MockUSDC.sol";
import "../../src/libraries/OrderBookLib.sol";
import "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";

/// @notice Tests for placeOrder, cancelOrder, bulkCancelOrders, and atomic buyNo/sellNo.
contract OrderBookTest is Test {
    MeridianMarket internal market;
    MockUSDC internal usdc;
    MockPyth internal pyth;

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal charlie = makeAddr("charlie");

    bytes32 internal constant AAPL = bytes32("AAPL");
    bytes32 internal constant AAPL_FEED = 0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688;
    int64 internal constant STRIKE = 23_000_000;
    uint64 internal constant EXPIRY = 1_800_000_000;

    bytes32 internal marketId;
    uint256 internal yesId;
    uint256 internal noId;

    function setUp() public {
        vm.startPrank(admin);
        pyth = new MockPyth(60, 0);
        usdc = new MockUSDC();
        market = new MeridianMarket(address(pyth), address(usdc), admin, 50);
        market.grantRole(market.OPERATOR_ROLE(), operator);
        market.setSupportedFeed(AAPL, AAPL_FEED, true);
        vm.stopPrank();

        vm.prank(operator);
        marketId = market.createStrikeMarket(AAPL, STRIKE, EXPIRY);
        yesId = uint256(marketId);
        noId = uint256(keccak256(abi.encode(marketId, "NO")));

        // Fund and approve all test users
        address[3] memory users = [alice, bob, charlie];
        for (uint256 i = 0; i < users.length; i++) {
            usdc.mint(users[i], 1000e6);
            vm.prank(users[i]);
            usdc.approve(address(market), type(uint256).max);
        }
    }

    // ── placeOrder: resting bid ────────────────────────────────────────────────

    function test_placeOrder_bid_locksUSDC() public {
        // Bid for 5 Yes tokens at $0.60 → lock 5 * 60 * 1e4 = 3_000_000 USDC
        uint256 lockAmount = 5 * 60 * 1e4;
        uint256 before = usdc.balanceOf(alice);

        vm.prank(alice);
        market.placeOrder(marketId, OrderBookLib.Side.BID, 60, 5, false);

        assertEq(usdc.balanceOf(alice), before - lockAmount);
        assertEq(usdc.balanceOf(address(market)), lockAmount);
    }

    function test_placeOrder_bid_showsInDepth() public {
        vm.prank(alice);
        market.placeOrder(marketId, OrderBookLib.Side.BID, 60, 5, false);
        assertEq(market.depthAt(marketId, OrderBookLib.Side.BID, 60), 5);
    }

    function test_placeOrder_bid_emitsOrderPlaced() public {
        vm.expectEmit(true, false, true, true);
        emit MeridianMarket.OrderPlaced(marketId, 1, alice, OrderBookLib.Side.BID, 60, 5);
        vm.prank(alice);
        market.placeOrder(marketId, OrderBookLib.Side.BID, 60, 5, false);
    }

    // ── placeOrder: resting ask ────────────────────────────────────────────────

    function test_placeOrder_ask_locksYesTokens() public {
        // Alice mints a pair first to get Yes tokens
        vm.prank(alice);
        market.mintPair(marketId, 1);
        assertEq(market.balanceOf(alice, yesId), 1);

        // Place ask — Yes tokens move from alice to contract
        vm.prank(alice);
        market.placeOrder(marketId, OrderBookLib.Side.ASK, 65, 1, false);

        assertEq(market.balanceOf(alice, yesId), 0);
        assertEq(market.balanceOf(address(market), yesId), 1);
    }

    // ── placeOrder: immediate cross (limit buy against resting ask) ────────────

    function test_placeOrder_bid_crossesRestingAsk() public {
        // Alice posts ask at 65 cents
        vm.prank(alice);
        market.mintPair(marketId, 1);
        vm.prank(alice);
        market.placeOrder(marketId, OrderBookLib.Side.ASK, 65, 1, false);

        uint256 bobBefore = usdc.balanceOf(bob);

        // Bob places bid at 65 — crosses alice's ask
        vm.prank(bob);
        market.placeOrder(marketId, OrderBookLib.Side.BID, 65, 1, false);

        // Bob receives Yes token
        assertEq(market.balanceOf(bob, yesId), 1);
        // Bob paid 65 cents (65 * 1e4 = 650_000)
        assertEq(usdc.balanceOf(bob), bobBefore - 65 * 1e4);
        // Alice receives her payment
        assertEq(usdc.balanceOf(alice), 1000e6 - 1e6 + 65 * 1e4); // minted $1, got $0.65 back
    }

    function test_placeOrder_bid_crossesAsk_overPaidRefunded() public {
        // Alice asks at 60 cents, Bob bids at 70 → fills at 60, gets 10 cent refund
        vm.prank(alice);
        market.mintPair(marketId, 1);
        vm.prank(alice);
        market.placeOrder(marketId, OrderBookLib.Side.ASK, 60, 1, false);

        uint256 bobBefore = usdc.balanceOf(bob);

        vm.prank(bob);
        market.placeOrder(marketId, OrderBookLib.Side.BID, 70, 1, false);

        // Bob paid price of 60 cents (fill price), refund of 10 cents
        assertEq(usdc.balanceOf(bob), bobBefore - 60 * 1e4);
        assertEq(market.balanceOf(bob, yesId), 1);
    }

    // ── placeOrder: IOC partial fill ──────────────────────────────────────────

    function test_placeOrder_IOC_partialFill_refundsRemainder() public {
        // Alice posts ask for 3 tokens at 65 cents
        vm.prank(alice);
        usdc.approve(address(market), type(uint256).max);
        for (uint i = 0; i < 3; i++) {
            vm.prank(alice);
            market.mintPair(marketId, 1);
        }
        vm.prank(alice);
        market.placeOrder(marketId, OrderBookLib.Side.ASK, 65, 3, false);

        uint256 bobBefore = usdc.balanceOf(bob);

        // Bob bids for 5 tokens, IOC=true → fills 3, refunds 2 * 65
        vm.prank(bob);
        market.placeOrder(marketId, OrderBookLib.Side.BID, 65, 5, true);

        assertEq(market.balanceOf(bob, yesId), 3);
        // Bob paid only for 3 tokens (no remainder left in order book)
        assertEq(usdc.balanceOf(bob), bobBefore - 3 * 65 * 1e4);
        assertEq(market.depthAt(marketId, OrderBookLib.Side.BID, 65), 0);
    }

    // ── placeOrder: boundary / revert checks ──────────────────────────────────

    function test_placeOrder_revertsAfterExpiry() public {
        vm.warp(EXPIRY);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MeridianMarket.MarketExpired.selector, marketId));
        market.placeOrder(marketId, OrderBookLib.Side.BID, 50, 1, false);
    }

    function test_placeOrder_revertsWhenPaused() public {
        vm.prank(admin);
        market.pause();
        vm.prank(alice);
        vm.expectRevert();
        market.placeOrder(marketId, OrderBookLib.Side.BID, 50, 1, false);
    }

    function test_placeOrder_revertsZeroQuantity() public {
        vm.prank(alice);
        vm.expectRevert(MeridianMarket.ZeroQuantity.selector);
        market.placeOrder(marketId, OrderBookLib.Side.BID, 50, 0, false);
    }

    // ── cancelOrder ───────────────────────────────────────────────────────────

    function test_cancelOrder_bid_refundsUSDC() public {
        uint256 lockUsdc = 5 * 60 * 1e4;
        uint256 before = usdc.balanceOf(alice);

        vm.prank(alice);
        uint256 orderId = market.placeOrder(marketId, OrderBookLib.Side.BID, 60, 5, false);
        assertEq(usdc.balanceOf(alice), before - lockUsdc);

        vm.prank(alice);
        market.cancelOrder(orderId);
        assertEq(usdc.balanceOf(alice), before);
    }

    function test_cancelOrder_ask_refundsYesTokens() public {
        vm.prank(alice);
        market.mintPair(marketId, 1);
        vm.prank(alice);
        uint256 orderId = market.placeOrder(marketId, OrderBookLib.Side.ASK, 65, 1, false);

        assertEq(market.balanceOf(alice, yesId), 0);

        vm.prank(alice);
        market.cancelOrder(orderId);

        assertEq(market.balanceOf(alice, yesId), 1);
    }

    function test_cancelOrder_revertsNonOwner() public {
        vm.prank(alice);
        uint256 orderId = market.placeOrder(marketId, OrderBookLib.Side.BID, 60, 1, false);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(MeridianMarket.OrderNotOwned.selector, orderId));
        market.cancelOrder(orderId);
    }

    function test_cancelOrder_emitsEvent() public {
        vm.prank(alice);
        uint256 orderId = market.placeOrder(marketId, OrderBookLib.Side.BID, 60, 3, false);

        vm.expectEmit(true, true, false, true);
        emit MeridianMarket.OrderCancelled(orderId, alice, 3);

        vm.prank(alice);
        market.cancelOrder(orderId);
    }

    function test_cancelOrder_removesFromDepth() public {
        vm.prank(alice);
        uint256 orderId = market.placeOrder(marketId, OrderBookLib.Side.BID, 60, 3, false);
        assertEq(market.depthAt(marketId, OrderBookLib.Side.BID, 60), 3);

        vm.prank(alice);
        market.cancelOrder(orderId);
        assertEq(market.depthAt(marketId, OrderBookLib.Side.BID, 60), 0);
    }

    function test_cancelOrder_worksPostSettlement() public {
        // Place order, settle market, then cancel
        vm.prank(alice);
        uint256 orderId = market.placeOrder(marketId, OrderBookLib.Side.BID, 60, 2, false);

        vm.warp(EXPIRY + market.ADMIN_OVERRIDE_DELAY());
        vm.prank(admin);
        market.adminSettleOverride(marketId, STRIKE + 1); // YES wins

        // Cancel should still work post-settlement
        vm.prank(alice);
        market.cancelOrder(orderId);
        assertEq(usdc.balanceOf(alice), 1000e6); // refunded
    }

    // ── bulkCancelOrders ──────────────────────────────────────────────────────

    function test_bulkCancelOrders_cancelsAll() public {
        uint256[] memory ids = new uint256[](3);
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(alice);
            ids[i] = market.placeOrder(marketId, OrderBookLib.Side.BID, 60, 1, false);
        }

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        market.bulkCancelOrders(ids);

        // All 3 orders refunded: 3 * 60 * 1e4 = 1_800_000
        assertEq(usdc.balanceOf(alice), before + 3 * 60 * 1e4);
        assertEq(market.depthAt(marketId, OrderBookLib.Side.BID, 60), 0);
    }

    function test_bulkCancelOrders_skipsNonOwnedOrders() public {
        vm.prank(alice);
        uint256 aliceOrder = market.placeOrder(marketId, OrderBookLib.Side.BID, 60, 1, false);
        vm.prank(bob);
        uint256 bobOrder = market.placeOrder(marketId, OrderBookLib.Side.BID, 60, 1, false);

        uint256[] memory ids = new uint256[](2);
        ids[0] = aliceOrder;
        ids[1] = bobOrder; // alice doesn't own this

        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 bobBefore = usdc.balanceOf(bob);

        vm.prank(alice);
        market.bulkCancelOrders(ids);

        // Alice's order was cancelled, Bob's was skipped
        assertEq(usdc.balanceOf(alice), aliceBefore + 60 * 1e4);
        assertEq(usdc.balanceOf(bob), bobBefore); // untouched
    }

    // ── buyNoMarket atomic ─────────────────────────────────────────────────────

    function test_buyNoMarket_success() public {
        // Alice posts a Yes bid at 40 cents
        vm.prank(alice);
        market.placeOrder(marketId, OrderBookLib.Side.BID, 40, 1, false);

        uint256 bobBefore = usdc.balanceOf(bob);

        // Bob calls buyNoMarket: mints pair, sells Yes at market, keeps No
        vm.prank(bob);
        market.buyNoMarket(marketId, 1, 38, 5); // quantity=1, minProceeds=38 cents

        // Bob holds 1 No token
        assertEq(market.balanceOf(bob, noId), 1);
        // Bob received proceeds from Yes sale (40 cents = 40 * 1e4 = 400_000 USDC)
        // Bob paid $1 for pair, got $0.40 back → net cost $0.60
        assertEq(usdc.balanceOf(bob), bobBefore - 60 * 1e4);
    }

    function test_buyNoMarket_revertsInsufficientProceeds() public {
        // Only 20 cent bid available, but bob wants at least 40
        vm.prank(alice);
        market.placeOrder(marketId, OrderBookLib.Side.BID, 20, 1, false);

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(MeridianMarket.InsufficientProceed.selector, uint128(20), uint128(40))
        );
        market.buyNoMarket(marketId, 1, 40, 5);
    }

    function test_buyNoMarket_noLiquidityFillsZero_keepsNo() public {
        // No bids in book; buyNoMarket with minProceeds=0 → still gets No token, pays full $1
        uint256 bobBefore = usdc.balanceOf(bob);
        vm.prank(bob);
        market.buyNoMarket(marketId, 1, 0, 5);

        assertEq(market.balanceOf(bob, noId), 1);
        // Bob paid $1, sold no Yes, refunded Yes token portion = $1
        // Net: paid $1, got No token + $1 refund → net cost = $0 + owns No
        // Actually: mint pair costs $1 → yes minted to contract + no to bob
        // No bids to fill → yes unfilled → refund $1 to bob
        // Bob net: paid $1, refunded $1 → $0 net, holds No token
        assertEq(usdc.balanceOf(bob), bobBefore - 1e6 + 1e6); // net $0
    }

    // ── buyNoLimit atomic ─────────────────────────────────────────────────────

    function test_buyNoLimit_postsYesAsk() public {
        vm.prank(alice);
        market.buyNoLimit(marketId, 1, 65); // quantity=1, post Yes ask at 65 cents

        assertEq(market.depthAt(marketId, OrderBookLib.Side.ASK, 65), 1);
        assertEq(market.balanceOf(alice, noId), 1); // alice holds No
    }

    function test_buyNoLimit_yesMintedToContract() public {
        vm.prank(alice);
        market.buyNoLimit(marketId, 1, 65);
        assertEq(market.balanceOf(address(market), yesId), 1);
    }

    // ── sellNoMarket atomic ───────────────────────────────────────────────────

    function test_sellNoMarket_redeemsPair() public {
        // Setup: bob has No token (via buyNoLimit), charlie has Yes ask from mint
        vm.prank(bob);
        market.buyNoLimit(marketId, 1, 45); // bob posts Yes ask at 45 cents, holds No

        // Alice places Yes ask at 45 so charlie can buy at 45
        vm.prank(alice);
        market.mintPair(marketId, 1);
        vm.prank(alice);
        market.placeOrder(marketId, OrderBookLib.Side.ASK, 45, 1, false);

        // Now charlie wants to sell their No token. Charlie holds No from previous mint.
        // For this test: charlie mints pair to get No and Yes, then sells No via sellNoMarket
        // Setup charlie with No token via buyNoLimit
        vm.prank(charlie);
        market.buyNoLimit(marketId, 1, 50); // charlie holds No, Yes posted as ask at 50

        // Check charlie has No token
        assertEq(market.balanceOf(charlie, noId), 1);

        // Charlie wants to exit: sellNoMarket buys Yes at market (fills alice's 45 ask), redeems pair
        uint256 charlieBefore = usdc.balanceOf(charlie);
        vm.prank(charlie);
        market.sellNoMarket(marketId, 1, 50, 5); // maxYesBuyPrice=50, maxFills=5

        // Charlie got back $1 gross (less cost of Yes = $0.45) → nets $0.55
        assertEq(market.balanceOf(charlie, noId), 0);
        assertEq(usdc.balanceOf(charlie), charlieBefore - 45 * 1e4 + 1e6);
    }

    // ── buyNoMarket: multi-quantity ────────────────────────────────────────────

    function test_buyNoMarket_quantity() public {
        // Alice posts 3 Yes bids at 40 cents
        vm.prank(alice);
        market.placeOrder(marketId, OrderBookLib.Side.BID, 40, 3, false);

        uint256 bobBefore = usdc.balanceOf(bob);

        // Bob calls buyNoMarket with quantity=3: mints 3 pairs, sells 3 Yes, keeps 3 No
        vm.prank(bob);
        market.buyNoMarket(marketId, 3, 100, 10); // minProceeds=100 cents total (3*40=120, passes)

        assertEq(market.balanceOf(bob, noId), 3, "Bob should hold 3 No tokens");
        // Bob paid 3 USDC, received 3 * 40 cents (120 * 1e4 = 1_200_000)
        // Net cost = 3_000_000 - 1_200_000 = 1_800_000 = 3 * 60 cents
        assertEq(usdc.balanceOf(bob), bobBefore - 3 * 60 * 1e4, "Bob net cost 3 * $0.60");
    }

    // ── buyNoLimit: multi-quantity ─────────────────────────────────────────────

    function test_buyNoLimit_quantity() public {
        uint256 before = usdc.balanceOf(alice);

        // Alice buys 3 No tokens via buyNoLimit: posts a 3-token Yes ASK at 65 cents
        vm.prank(alice);
        market.buyNoLimit(marketId, 3, 65);

        // Alice immediately holds 3 No tokens
        assertEq(market.balanceOf(alice, noId), 3, "Alice should hold 3 No tokens");
        // Contract holds 3 Yes tokens locked as ASK collateral
        assertEq(market.balanceOf(address(market), yesId), 3, "Contract holds 3 Yes tokens");
        // Depth reflects the single 3-token order
        assertEq(market.depthAt(marketId, OrderBookLib.Side.ASK, 65), 3, "3 Yes tokens at 65 cents");
        // Alice paid 3 USDC
        assertEq(usdc.balanceOf(alice), before - 3e6, "Alice paid 3 USDC");
    }

    function test_sellNoMarket_revertsZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(MeridianMarket.ZeroQuantity.selector);
        market.sellNoMarket(marketId, 0, 50, 5);
    }

    // ── OrderFilled event ─────────────────────────────────────────────────────

    function test_orderFilled_emittedOnPlaceOrderCross() public {
        // Alice posts ASK at 65 cents (order ID 1 after setUp)
        vm.prank(alice);
        market.mintPair(marketId, 1);
        vm.prank(alice);
        uint256 askOrderId = market.placeOrder(marketId, OrderBookLib.Side.ASK, 65, 1, false);

        // Expect OrderFilled: marketId, orderId=askOrderId, maker=alice, taker=bob, side=0 (BID taker), priceCents=65, qty=1
        vm.expectEmit(true, true, true, true);
        emit MeridianMarket.OrderFilled(marketId, askOrderId, alice, bob, 0, 65, 1);

        vm.prank(bob);
        market.placeOrder(marketId, OrderBookLib.Side.BID, 65, 1, false);
    }

    function test_orderFilled_emittedOnBuyNoMarket() public {
        // Alice posts BID at 40 cents
        vm.prank(alice);
        uint256 bidOrderId = market.placeOrder(marketId, OrderBookLib.Side.BID, 40, 1, false);

        // buyNoMarket emits ERC20/ERC1155 Transfer events before OrderFilled,
        // so capture all logs and find OrderFilled manually.
        vm.recordLogs();
        vm.prank(bob);
        market.buyNoMarket(marketId, 1, 0, 5);

        Vm.Log[] memory entries = vm.getRecordedLogs();
        bytes32 sig = keccak256("OrderFilled(bytes32,uint256,address,address,uint8,uint8,uint128)");
        bool found = false;
        for (uint256 i = 0; i < entries.length; i++) {
            if (entries[i].topics.length > 0 && entries[i].topics[0] == sig) {
                found = true;
                assertEq(entries[i].topics[1], marketId);
                assertEq(entries[i].topics[2], bytes32(bidOrderId));
                assertEq(entries[i].topics[3], bytes32(uint256(uint160(alice))));
                (address taker, uint8 side, uint8 priceCents, uint128 qty) =
                    abi.decode(entries[i].data, (address, uint8, uint8, uint128));
                assertEq(taker, bob);
                assertEq(side, 1); // takerSide = ASK (selling Yes into alice's BID)
                assertEq(priceCents, 40);
                assertEq(qty, 1);
                break;
            }
        }
        assertTrue(found, "OrderFilled event not emitted");
    }

    function test_orderFilled_emittedOnSellNoMarket() public {
        // Alice mints pair and posts ASK at 55 cents
        vm.prank(alice);
        market.mintPair(marketId, 1);
        vm.prank(alice);
        uint256 askOrderId = market.placeOrder(marketId, OrderBookLib.Side.ASK, 55, 1, false);

        // Bob mints a pair to acquire a No token for sellNoMarket
        vm.prank(bob);
        market.mintPair(marketId, 1);
        vm.prank(bob);
        market.setApprovalForAll(address(market), true);

        // sellNoMarket emits ERC20/ERC1155 Transfer events before OrderFilled
        vm.recordLogs();
        vm.prank(bob);
        market.sellNoMarket(marketId, 1, 60, 5);

        Vm.Log[] memory entries = vm.getRecordedLogs();
        bytes32 sig = keccak256("OrderFilled(bytes32,uint256,address,address,uint8,uint8,uint128)");
        bool found = false;
        for (uint256 i = 0; i < entries.length; i++) {
            if (entries[i].topics.length > 0 && entries[i].topics[0] == sig) {
                found = true;
                assertEq(entries[i].topics[1], marketId);
                assertEq(entries[i].topics[2], bytes32(askOrderId));
                assertEq(entries[i].topics[3], bytes32(uint256(uint160(alice))));
                (address taker, uint8 side, uint8 priceCents, uint128 qty) =
                    abi.decode(entries[i].data, (address, uint8, uint8, uint128));
                assertEq(taker, bob);
                assertEq(side, 0); // takerSide = BID (buying Yes from alice's ASK)
                assertEq(priceCents, 55);
                assertEq(qty, 1);
                break;
            }
        }
        assertTrue(found, "OrderFilled event not emitted");
    }
}
