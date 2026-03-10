// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../../src/MeridianMarket.sol";
import "../../src/MockUSDC.sol";
import "../../src/libraries/OrderBookLib.sol";
import "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";

contract RedemptionTest is Test {
    MeridianMarket internal market;
    MockUSDC internal usdc;
    MockPyth internal pyth;

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal settler = makeAddr("settler");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    bytes32 internal constant AAPL = bytes32("AAPL");
    bytes32 internal constant AAPL_FEED = 0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688;
    int64 internal constant STRIKE = 23_000_000;
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

        // Fund users
        usdc.mint(alice, 100e6);
        usdc.mint(bob, 100e6);
        vm.prank(alice);
        usdc.approve(address(market), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(market), type(uint256).max);
    }

    function _settle(bool yesWins) internal {
        vm.warp(EXPIRY + market.ADMIN_OVERRIDE_DELAY());
        int64 price = yesWins ? STRIKE + 1 : STRIKE - 1;
        vm.prank(admin);
        market.adminSettleOverride(marketId, price);
    }

    // ── Winner redemption ──────────────────────────────────────────────────────

    function test_redeem_yesWinner_receivesNetPayout() public {
        // Alice mints 1 pair, settles YES wins, redeems Yes token
        vm.prank(alice);
        market.mintPair(marketId, 1);
        _settle(true);

        uint256 before = usdc.balanceOf(alice);

        vm.prank(alice);
        market.redeem(marketId, 1);

        // Expected: 1e6 * (1 - 50/10000) = 1e6 - 5000 = 995000
        uint256 expected = 1e6 - (uint256(1e6) * FEE_BPS / 10_000);
        assertEq(usdc.balanceOf(alice), before + expected);
    }

    function test_redeem_noWinner_receivesNetPayout() public {
        vm.prank(alice);
        market.mintPair(marketId, 1);
        _settle(false);

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        market.redeem(marketId, 1);

        uint256 expected = 1e6 - (uint256(1e6) * FEE_BPS / 10_000);
        assertEq(usdc.balanceOf(alice), before + expected);
    }

    // ── Loser redemption ───────────────────────────────────────────────────────

    function test_redeem_yesLoser_receivesZero() public {
        // Alice buys YES via BID order (bob posts ASK). Alice holds only YES.
        // Setup: bob mints a pair and posts YES ask at 50 cents
        vm.prank(bob);
        market.mintPair(marketId, 1);
        vm.prank(bob);
        market.placeOrder(marketId, OrderBookLib.Side.ASK, 50, 1, false);

        // Alice buys YES by placing a BID at 50 cents
        vm.prank(alice);
        market.placeOrder(marketId, OrderBookLib.Side.BID, 50, 1, false);

        // Now alice holds 1 YES, 0 NO. NO wins.
        assertEq(market.balanceOf(alice, yesId), 1);
        assertEq(market.balanceOf(alice, noId), 0);

        _settle(false); // NO wins; alice's YES is losing

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        market.redeem(marketId, 1); // redeem losing YES token

        assertEq(usdc.balanceOf(alice), before); // no payout
        assertEq(market.balanceOf(alice, yesId), 0); // token burned
    }

    function test_redeem_noLoser_receivesZero() public {
        // Bob buys NO via buyNoMarket. Bob holds only NO.
        // Setup: alice posts YES bid so buyNoMarket has liquidity
        vm.prank(alice);
        market.placeOrder(marketId, OrderBookLib.Side.BID, 40, 1, false);

        vm.prank(bob);
        market.buyNoMarket(marketId, 1, 0, 5); // bob keeps No token

        // Bob holds 1 NO, 0 YES. YES wins.
        assertEq(market.balanceOf(bob, noId), 1);
        assertEq(market.balanceOf(bob, yesId), 0);

        _settle(true); // YES wins; bob's NO is losing

        uint256 before = usdc.balanceOf(bob);
        vm.prank(bob);
        market.redeem(marketId, 1); // redeem losing NO token

        assertEq(usdc.balanceOf(bob), before); // no payout
        assertEq(market.balanceOf(bob, noId), 0); // token burned
    }

    // ── Fee forwarding ────────────────────────────────────────────────────────

    function test_redeem_feeSentToRecipient() public {
        vm.prank(alice);
        market.mintPair(marketId, 1);
        _settle(true);

        uint256 feeExpected = uint256(1e6) * FEE_BPS / 10_000;
        uint256 recipientBefore = usdc.balanceOf(admin);

        vm.prank(alice);
        market.redeem(marketId, 1);

        assertEq(usdc.balanceOf(admin), recipientBefore + feeExpected);
    }

    function test_redeem_losingToken_noFeeSent() public {
        // Alice holds ONLY a losing YES token (bob posted ask, alice bought YES at market)
        vm.prank(bob);
        market.mintPair(marketId, 1);
        vm.prank(bob);
        market.placeOrder(marketId, OrderBookLib.Side.ASK, 50, 1, false);
        vm.prank(alice);
        market.placeOrder(marketId, OrderBookLib.Side.BID, 50, 1, false);

        assertEq(market.balanceOf(alice, yesId), 1);
        assertEq(market.balanceOf(alice, noId), 0);

        _settle(false); // NO wins → alice's YES is loser

        uint256 recipientBefore = usdc.balanceOf(admin);
        vm.prank(alice);
        market.redeem(marketId, 1); // redeem losing YES — no fee should be sent
        assertEq(usdc.balanceOf(admin), recipientBefore);
    }

    function test_redeem_multiUser_feesForwardedToRecipient() public {
        vm.prank(alice);
        market.mintPair(marketId, 1);
        vm.prank(bob);
        market.mintPair(marketId, 1);
        _settle(true); // YES wins

        uint256 feePerToken = uint256(1e6) * FEE_BPS / 10_000;
        uint256 recipientBefore = usdc.balanceOf(admin);

        vm.prank(alice);
        market.redeem(marketId, 1);
        vm.prank(bob);
        market.redeem(marketId, 1);

        assertEq(usdc.balanceOf(admin), recipientBefore + 2 * feePerToken);
    }

    // ── Vault balance after redemption ────────────────────────────────────────

    function test_redeem_vaultDecreasesCorrectly() public {
        vm.prank(alice);
        market.mintPair(marketId, 1);
        _settle(true);

        (, , , , , uint256 vaultBefore, , , ) = market.markets(marketId);
        assertEq(vaultBefore, 1e6);

        vm.prank(alice);
        market.redeem(marketId, 1); // YES winner

        (, , , , , uint256 vaultAfter, , , ) = market.markets(marketId);
        assertEq(vaultAfter, 0);
    }


    // ── Revert checks ─────────────────────────────────────────────────────────

    function test_redeem_revertsBeforeSettlement() public {
        vm.prank(alice);
        market.mintPair(marketId, 1);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MeridianMarket.MarketNotSettled.selector, marketId));
        market.redeem(marketId, 1);
    }

    function test_redeem_revertsZeroQuantity() public {
        vm.prank(alice);
        market.mintPair(marketId, 1);
        _settle(true);

        vm.prank(alice);
        vm.expectRevert(MeridianMarket.ZeroQuantity.selector);
        market.redeem(marketId, 0);
    }

    function test_redeem_revertsInsufficientTokens() public {
        vm.prank(alice);
        market.mintPair(marketId, 1);
        _settle(true); // YES wins

        vm.prank(alice);
        vm.expectRevert();
        market.redeem(marketId, 2); // only holds 1
    }

    // ── feeBpsSnapshot applied (not live fee) ─────────────────────────────────

    function test_redeem_usesFeeBpsSnapshot_notLiveFee() public {
        vm.prank(alice);
        market.mintPair(marketId, 1);

        // Admin changes fee after market creation
        vm.prank(admin);
        market.setFee(200); // 2%

        _settle(true);

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        market.redeem(marketId, 1);

        // Should use snapshot (50 bps), not live fee (200 bps)
        uint256 expected = 1e6 - (uint256(1e6) * FEE_BPS / 10_000);
        assertEq(usdc.balanceOf(alice), before + expected);
    }

    // ── Emit event ────────────────────────────────────────────────────────────

    function test_redeem_emitsRedeemed() public {
        vm.prank(alice);
        market.mintPair(marketId, 1);
        _settle(true);

        uint256 payout = 1e6 - (uint256(1e6) * FEE_BPS / 10_000);
        vm.expectEmit(true, true, false, true);
        emit MeridianMarket.Redeemed(marketId, alice, 1, payout);

        vm.prank(alice);
        market.redeem(marketId, 1);
    }
}
