// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../../../src/MeridianMarket.sol";
import "../../../src/MockUSDC.sol";
import "../../../src/libraries/OrderBookLib.sol";

/// @notice Stateful handler that exercises MeridianMarket with random actions.
///         Foundry's invariant runner calls the exposed functions with random inputs.
contract MeridianHandler is Test {
    MeridianMarket internal market;
    MockUSDC internal usdc;
    bytes32 internal marketId;

    address internal admin;
    address internal operator;

    // Actors whose balances we track
    address[4] internal actors;

    // Track total USDC deposited into the system (mintPair + placeOrder BID)
    uint256 public totalDeposited;
    // Track total USDC withdrawn (redeem + cancelOrder + fills to sellers)
    uint256 public totalWithdrawn;

    // Track pairs minted for supply parity checks
    uint256 public pairsMinted;
    uint256 public pairsRedeemed;

    uint64 internal constant EXPIRY = 2_000_000_000;
    int64 internal constant STRIKE = 23_000_000;
    bytes32 internal constant AAPL = bytes32("AAPL");
    bytes32 internal constant AAPL_FEED = 0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688;

    constructor(MeridianMarket _market, MockUSDC _usdc, bytes32 _marketId, address _admin, address _operator) {
        market = _market;
        usdc = _usdc;
        marketId = _marketId;
        admin = _admin;
        operator = _operator;

        actors[0] = makeAddr("actor0");
        actors[1] = makeAddr("actor1");
        actors[2] = makeAddr("actor2");
        actors[3] = makeAddr("actor3");

        for (uint256 i = 0; i < actors.length; i++) {
            usdc.mint(actors[i], 1000e6);
            vm.prank(actors[i]);
            usdc.approve(address(market), type(uint256).max);
        }
    }

    // ── Actions ────────────────────────────────────────────────────────────────

    function mintPair(uint256 actorSeed) external {
        address actor = actors[actorSeed % actors.length];
        (, , , uint64 expiry, , , , bool settled, ) = market.markets(marketId);
        if (block.timestamp >= expiry || settled) return;
        if (usdc.balanceOf(actor) < 1e6) return;

        vm.prank(actor);
        market.mintPair(marketId, 1);
        totalDeposited += 1e6;
        pairsMinted++;
    }

    function placeBid(uint256 actorSeed, uint8 priceCents, uint128 qty) external {
        priceCents = uint8(bound(priceCents, 1, 99));
        qty = uint128(bound(qty, 1, 10));
        address actor = actors[actorSeed % actors.length];

        (, , , uint64 expiry, , , , bool settled, ) = market.markets(marketId);
        if (block.timestamp >= expiry || settled) return;

        uint256 cost = uint256(qty) * uint256(priceCents) * 1e4;
        if (usdc.balanceOf(actor) < cost) return;

        vm.prank(actor);
        try market.placeOrder(marketId, OrderBookLib.Side.BID, priceCents, qty, false) {}
        catch {}
    }

    function placeAsk(uint256 actorSeed, uint8 priceCents, uint128 qty) external {
        priceCents = uint8(bound(priceCents, 1, 99));
        qty = uint128(bound(qty, 1, 5));
        address actor = actors[actorSeed % actors.length];

        (, , , uint64 expiry, , , , bool settled, ) = market.markets(marketId);
        if (block.timestamp >= expiry || settled) return;

        uint256 yesId = uint256(marketId);
        if (market.balanceOf(actor, yesId) < qty) return;

        vm.prank(actor);
        try market.placeOrder(marketId, OrderBookLib.Side.ASK, priceCents, qty, false) {}
        catch {}
    }

    function cancelRandomOrder(uint256 actorSeed, uint256 orderIdSeed) external {
        address actor = actors[actorSeed % actors.length];
        // Try cancelling order IDs 1–20
        uint256 orderId = (orderIdSeed % 20) + 1;
        if (market.orderOwner(orderId) != actor) return;

        vm.prank(actor);
        try market.cancelOrder(orderId) {} catch {}
    }

    function settle(bool yesWins) external {
        (, , , uint64 expiry, , , , bool settled, ) = market.markets(marketId);
        if (settled || block.timestamp < expiry + market.ADMIN_OVERRIDE_DELAY()) return;

        int64 price = yesWins ? STRIKE + 1 : STRIKE - 1;
        vm.prank(admin);
        try market.adminSettleOverride(marketId, price) {} catch {}
    }

    function redeem(uint256 actorSeed) external {
        (, , , , , , , bool settled, ) = market.markets(marketId);
        if (!settled) return;

        address actor = actors[actorSeed % actors.length];
        uint256 yesId = uint256(marketId);
        uint256 noId = uint256(keccak256(abi.encode(marketId, "NO")));
        uint256 qty = market.balanceOf(actor, yesId) + market.balanceOf(actor, noId);
        if (qty == 0) return;

        vm.prank(actor);
        try market.redeem(marketId, 1) {
            pairsRedeemed++;
        } catch {}
    }

    function warpTime(uint256 seconds_) external {
        // Only allow warping forward by up to 1 hour at a time
        vm.warp(block.timestamp + (seconds_ % 3601));
    }

    // ── View helpers for invariant assertions ──────────────────────────────────

    function sumActorYesBalances() external view returns (uint256 total) {
        uint256 yesId = uint256(marketId);
        for (uint256 i = 0; i < actors.length; i++) {
            total += market.balanceOf(actors[i], yesId);
        }
    }

    function sumActorNoBalances() external view returns (uint256 total) {
        uint256 noId = uint256(keccak256(abi.encode(marketId, "NO")));
        for (uint256 i = 0; i < actors.length; i++) {
            total += market.balanceOf(actors[i], noId);
        }
    }

    function contractYesBalance() external view returns (uint256) {
        return market.balanceOf(address(market), uint256(marketId));
    }

    function contractNoBalance() external view returns (uint256) {
        return market.balanceOf(address(market), uint256(keccak256(abi.encode(marketId, "NO"))));
    }
}
