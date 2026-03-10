// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../../src/MeridianMarket.sol";
import "../../src/MockUSDC.sol";
import "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";

contract MarketCreationTest is Test {
    MeridianMarket internal market;
    MockUSDC internal usdc;
    MockPyth internal pyth;

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal settler = makeAddr("settler");
    address internal feeRecipient = makeAddr("feeRecipient");

    bytes32 internal constant AAPL = bytes32("AAPL");
    bytes32 internal constant AAPL_FEED = 0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688;
    int64 internal constant STRIKE = 23_000_000; // $230.00000
    uint64 internal constant EXPIRY = 1_800_000_000; // some future timestamp

    function setUp() public {
        vm.startPrank(admin);
        pyth = new MockPyth(60, 0); // validTimePeriod=60s, fee=0
        usdc = new MockUSDC();
        market = new MeridianMarket(address(pyth), address(usdc), feeRecipient, 50); // 50 bps

        market.grantRole(market.OPERATOR_ROLE(), operator);
        market.grantRole(market.SETTLER_ROLE(), settler);
        market.setSupportedFeed(AAPL, AAPL_FEED, true);
        vm.stopPrank();
    }

    // ── createStrikeMarket: success ────────────────────────────────────────────

    function test_createStrikeMarket_success() public {
        vm.prank(operator);
        bytes32 marketId = market.createStrikeMarket(AAPL, STRIKE, EXPIRY);

        bytes32 expected = keccak256(abi.encode(AAPL, STRIKE, EXPIRY));
        assertEq(marketId, expected);

        (
            bytes32 ticker,
            int64 strikePrice,
            bytes32 feedId,
            uint64 expiry,
            ,
            ,
            uint16 feeBps,
            bool settled,
        ) = market.markets(marketId);

        assertEq(ticker, AAPL);
        assertEq(strikePrice, STRIKE);
        assertEq(feedId, AAPL_FEED);
        assertEq(expiry, EXPIRY);
        assertEq(feeBps, 50);
        assertFalse(settled);
    }

    function test_createStrikeMarket_emitsEvent() public {
        bytes32 marketId = keccak256(abi.encode(AAPL, STRIKE, EXPIRY));

        vm.expectEmit(true, true, false, true);
        emit MeridianMarket.MarketCreated(marketId, AAPL, STRIKE, EXPIRY, AAPL_FEED);

        vm.prank(operator);
        market.createStrikeMarket(AAPL, STRIKE, EXPIRY);
    }

    function test_createStrikeMarket_tokenIdsRegistered() public {
        vm.prank(operator);
        bytes32 marketId = market.createStrikeMarket(AAPL, STRIKE, EXPIRY);

        uint256 yesId = uint256(marketId);
        uint256 noId = uint256(keccak256(abi.encode(marketId, "NO")));

        assertEq(market.tokenIdToMarket(yesId), marketId);
        assertEq(market.tokenIdToMarket(noId), marketId);
        assertTrue(market.tokenIdIsYes(yesId));
        assertFalse(market.tokenIdIsYes(noId));
    }

    function test_createStrikeMarket_feedDerivedFromAllowlist() public {
        vm.prank(operator);
        bytes32 marketId = market.createStrikeMarket(AAPL, STRIKE, EXPIRY);

        (, , bytes32 feedId, , , , , , ) = market.markets(marketId);
        assertEq(feedId, AAPL_FEED);
    }

    // ── createStrikeMarket: duplicate revert ──────────────────────────────────

    function test_createStrikeMarket_revertsDuplicate() public {
        vm.startPrank(operator);
        market.createStrikeMarket(AAPL, STRIKE, EXPIRY);

        vm.expectRevert(
            abi.encodeWithSelector(
                MeridianMarket.MarketExists.selector,
                keccak256(abi.encode(AAPL, STRIKE, EXPIRY))
            )
        );
        market.createStrikeMarket(AAPL, STRIKE, EXPIRY);
        vm.stopPrank();
    }

    // ── createStrikeMarket: role gating ───────────────────────────────────────

    function test_createStrikeMarket_revertsNonOperator() public {
        address rando = makeAddr("rando");
        vm.prank(rando);
        vm.expectRevert();
        market.createStrikeMarket(AAPL, STRIKE, EXPIRY);
    }

    function test_createStrikeMarket_revertsUnsupportedTicker() public {
        bytes32 unsupported = bytes32("GOOGL"); // not configured
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(MeridianMarket.UnsupportedTicker.selector, unsupported));
        market.createStrikeMarket(unsupported, STRIKE, EXPIRY);
    }

    // ── addStrike: alias works ─────────────────────────────────────────────────

    function test_addStrike_success() public {
        int64 strike2 = 24_000_000; // $240.00000
        vm.prank(operator);
        bytes32 marketId = market.addStrike(AAPL, strike2, EXPIRY);

        bytes32 expected = keccak256(abi.encode(AAPL, strike2, EXPIRY));
        assertEq(marketId, expected);
    }

    // ── setSupportedFeed ───────────────────────────────────────────────────────

    function test_setSupportedFeed_revertsNonAdmin() public {
        vm.prank(operator);
        vm.expectRevert();
        market.setSupportedFeed(bytes32("TSLA"), bytes32(0), true);
    }

    function test_setSupportedFeed_canDisableTicker() public {
        vm.prank(admin);
        market.setSupportedFeed(AAPL, AAPL_FEED, false);
        assertFalse(market.supportedTickers(AAPL));

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(MeridianMarket.UnsupportedTicker.selector, AAPL));
        market.createStrikeMarket(AAPL, STRIKE, EXPIRY);
    }

    function test_setSupportedFeed_updatedFeedUsedForNewMarkets() public {
        bytes32 newFeed = bytes32("newFeedId");
        vm.prank(admin);
        market.setSupportedFeed(AAPL, newFeed, true);

        vm.prank(operator);
        bytes32 marketId = market.createStrikeMarket(AAPL, STRIKE, EXPIRY);

        (, , bytes32 feedId, , , , , , ) = market.markets(marketId);
        assertEq(feedId, newFeed);
    }

    // ── allMarketIds / marketCount / getMarkets ───────────────────────────────

    function test_marketCount_zeroBeforeAnyMarkets() public view {
        assertEq(market.marketCount(), 0);
    }

    function test_marketCount_incrementsOnCreate() public {
        vm.prank(operator);
        market.createStrikeMarket(AAPL, STRIKE, EXPIRY);
        assertEq(market.marketCount(), 1);

        vm.prank(operator);
        market.createStrikeMarket(AAPL, STRIKE + 1_000_000, EXPIRY);
        assertEq(market.marketCount(), 2);
    }

    function test_allMarketIds_appendedInOrder() public {
        vm.prank(operator);
        bytes32 id1 = market.createStrikeMarket(AAPL, STRIKE, EXPIRY);
        vm.prank(operator);
        bytes32 id2 = market.createStrikeMarket(AAPL, STRIKE + 1_000_000, EXPIRY);

        assertEq(market.allMarketIds(0), id1);
        assertEq(market.allMarketIds(1), id2);
    }

    function test_getMarkets_returnsAll_whenCountExceedsTotal() public {
        vm.prank(operator);
        bytes32 id1 = market.createStrikeMarket(AAPL, STRIKE, EXPIRY);
        vm.prank(operator);
        bytes32 id2 = market.createStrikeMarket(AAPL, STRIKE + 1_000_000, EXPIRY);

        // Ask for 490 but only 2 exist → should return both
        MeridianMarket.MarketView[] memory result = market.getMarkets(490);
        assertEq(result.length, 2);
        assertEq(result[0].marketId, id1);
        assertEq(result[1].marketId, id2);
    }

    function test_getMarkets_returnsNewest_whenCountLessThanTotal() public {
        // Create 3 markets
        vm.prank(operator);
        market.createStrikeMarket(AAPL, STRIKE, EXPIRY);
        vm.prank(operator);
        bytes32 id2 = market.createStrikeMarket(AAPL, STRIKE + 1_000_000, EXPIRY);
        vm.prank(operator);
        bytes32 id3 = market.createStrikeMarket(AAPL, STRIKE + 2_000_000, EXPIRY);

        // Ask for 2 → should return the 2 newest
        MeridianMarket.MarketView[] memory result = market.getMarkets(2);
        assertEq(result.length, 2);
        assertEq(result[0].marketId, id2);
        assertEq(result[1].marketId, id3);
    }

    function test_getMarkets_returnsCorrectFields() public {
        vm.prank(operator);
        bytes32 marketId = market.createStrikeMarket(AAPL, STRIKE, EXPIRY);

        MeridianMarket.MarketView[] memory result = market.getMarkets(1);
        assertEq(result.length, 1);

        MeridianMarket.MarketView memory v = result[0];
        assertEq(v.marketId,        marketId);
        assertEq(v.ticker,          AAPL);
        assertEq(v.strikePrice,     STRIKE);
        assertEq(v.expiryTimestamp, EXPIRY);
        assertFalse(v.settled);
        assertFalse(v.yesWins);
        assertEq(v.vaultBalance,    0);
        assertEq(v.feeBpsSnapshot,  50);
    }

    function test_getMarkets_settledFieldUpdatesAfterSettlement() public {
        vm.prank(operator);
        bytes32 marketId = market.createStrikeMarket(AAPL, STRIKE, EXPIRY);

        vm.warp(EXPIRY + market.ADMIN_OVERRIDE_DELAY());
        vm.prank(admin);
        market.adminSettleOverride(marketId, STRIKE + 1);

        MeridianMarket.MarketView[] memory result = market.getMarkets(1);
        assertTrue(result[0].settled);
        assertTrue(result[0].yesWins);
    }

    function test_getMarkets_emptyResult_whenCountZero() public {
        vm.prank(operator);
        market.createStrikeMarket(AAPL, STRIKE, EXPIRY);

        MeridianMarket.MarketView[] memory result = market.getMarkets(0);
        assertEq(result.length, 0);
    }

    function test_getMarkets_emptyResult_whenNoMarketsExist() public view {
        MeridianMarket.MarketView[] memory result = market.getMarkets(490);
        assertEq(result.length, 0);
    }

    function test_getMarkets_exactCount_returnsAll() public {
        vm.prank(operator);
        bytes32 id1 = market.createStrikeMarket(AAPL, STRIKE, EXPIRY);
        vm.prank(operator);
        bytes32 id2 = market.createStrikeMarket(AAPL, STRIKE + 1_000_000, EXPIRY);

        // Ask for exactly 2 when 2 exist
        MeridianMarket.MarketView[] memory result = market.getMarkets(2);
        assertEq(result.length, 2);
        assertEq(result[0].marketId, id1);
        assertEq(result[1].marketId, id2);
    }

    function test_getMarkets_yesTokenIdDerivation() public {
        vm.prank(operator);
        bytes32 marketId = market.createStrikeMarket(AAPL, STRIKE, EXPIRY);

        MeridianMarket.MarketView[] memory result = market.getMarkets(1);
        // Yes token ID is simply uint256(marketId)
        uint256 expectedYesId = uint256(marketId);
        assertEq(uint256(result[0].marketId), expectedYesId);
        // No token ID is derived — confirm the mapping agrees
        uint256 noId = uint256(keccak256(abi.encode(marketId, "NO")));
        assertEq(market.tokenIdToMarket(noId), marketId);
    }

    // ── feeBpsSnapshot is captured at creation ────────────────────────────────

    function test_feeBpsSnapshot_lockedAtCreation() public {
        vm.prank(operator);
        bytes32 marketId = market.createStrikeMarket(AAPL, STRIKE, EXPIRY);

        // Admin changes fee
        vm.prank(admin);
        market.setFee(100);

        // Market still has old snapshot
        (, , , , , , uint16 snapshot, , ) = market.markets(marketId);
        assertEq(snapshot, 50);
    }

    // ── setFee bounds ──────────────────────────────────────────────────────────

    function test_setFee_revertsAboveMaxBps() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(MeridianMarket.FeeTooHigh.selector, 201));
        market.setFee(201);
    }

    function test_setFee_acceptsMaxBps() public {
        vm.prank(admin);
        market.setFee(200);
        assertEq(market.feeBps(), 200);
    }

    // ── constructor fee guard ──────────────────────────────────────────────────

    function test_constructor_revertsFeeTooHigh() public {
        vm.expectRevert(abi.encodeWithSelector(MeridianMarket.FeeTooHigh.selector, 201));
        new MeridianMarket(address(pyth), address(usdc), feeRecipient, 201);
    }
}
