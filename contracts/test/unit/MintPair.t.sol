// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../../src/MeridianMarket.sol";
import "../../src/MockUSDC.sol";
import "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";

contract MintPairTest is Test {
    MeridianMarket internal market;
    MockUSDC internal usdc;
    MockPyth internal pyth;

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal alice = makeAddr("alice");

    bytes32 internal constant AAPL = bytes32("AAPL");
    bytes32 internal constant AAPL_FEED = 0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688;
    int64 internal constant STRIKE = 23_000_000;
    uint64 internal constant EXPIRY = 1_800_000_000;

    bytes32 internal marketId;

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

        // Fund alice with USDC and approve
        usdc.mint(alice, 100e6);
        vm.prank(alice);
        usdc.approve(address(market), type(uint256).max);
    }

    // ── mintPair: basic success ────────────────────────────────────────────────

    function test_mintPair_transfersUSDC() public {
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        market.mintPair(marketId, 1);
        assertEq(usdc.balanceOf(alice), before - 1e6);
        assertEq(usdc.balanceOf(address(market)), 1e6);
    }

    function test_mintPair_mintsOneYesOneNo() public {
        uint256 yesId = uint256(marketId);
        uint256 noId = uint256(keccak256(abi.encode(marketId, "NO")));

        vm.prank(alice);
        market.mintPair(marketId, 1);

        assertEq(market.balanceOf(alice, yesId), 1);
        assertEq(market.balanceOf(alice, noId), 1);
    }

    function test_mintPair_incrementsPairCount() public {
        vm.prank(alice);
        market.mintPair(marketId, 1);

        (, , , , uint256 totalPairs, , , , ) = market.markets(marketId);
        assertEq(totalPairs, 1);
    }

    function test_mintPair_incrementsVaultBalance() public {
        vm.prank(alice);
        market.mintPair(marketId, 1);

        (, , , , , uint256 vaultBalance, , , ) = market.markets(marketId);
        assertEq(vaultBalance, 1e6);
    }

    function test_mintPair_multipleMintsAccumulate() public {
        usdc.mint(alice, 10e6);
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(alice);
            market.mintPair(marketId, 1);
        }
        assertEq(market.balanceOf(alice, uint256(marketId)), 5);
        (, , , , , uint256 vault, , , ) = market.markets(marketId);
        assertEq(vault, 5e6);
    }

    function test_mintPair_emitsEvent() public {
        vm.expectEmit(true, true, false, true);
        emit MeridianMarket.PairMinted(marketId, alice, 1);

        vm.prank(alice);
        market.mintPair(marketId, 1);
    }

    // ── mintPair: revert cases ─────────────────────────────────────────────────

    function test_mintPair_revertsUnknownMarket() public {
        bytes32 badId = bytes32("bad");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MeridianMarket.MarketNotFound.selector, badId));
        market.mintPair(badId, 1);
    }

    function test_mintPair_revertsAfterExpiry() public {
        vm.warp(EXPIRY); // at expiry is blocked
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MeridianMarket.MarketExpired.selector, marketId));
        market.mintPair(marketId, 1);
    }

    function test_mintPair_revertsWhenPaused() public {
        vm.prank(admin);
        market.pause();

        vm.prank(alice);
        vm.expectRevert();
        market.mintPair(marketId, 1);
    }

    function test_mintPair_worksJustBeforeExpiry() public {
        vm.warp(EXPIRY - 1);
        vm.prank(alice);
        market.mintPair(marketId, 1); // should succeed
        assertEq(market.balanceOf(alice, uint256(marketId)), 1);
    }

    function test_mintPair_revertsInsufficientAllowance() public {
        address bob = makeAddr("bob");
        usdc.mint(bob, 10e6);
        // bob did not approve
        vm.prank(bob);
        vm.expectRevert();
        market.mintPair(marketId, 1);
    }

    // ── Vault invariant: supply parity ────────────────────────────────────────

    function test_supplyParity_afterMint() public {
        vm.prank(alice);
        market.mintPair(marketId, 1);

        uint256 yesId = uint256(marketId);
        uint256 noId = uint256(keccak256(abi.encode(marketId, "NO")));

        // In ERC1155 totalSupply is tracked via balances; confirm symmetry
        assertEq(market.balanceOf(alice, yesId), market.balanceOf(alice, noId));
    }

    // ── Multi-quantity mint ────────────────────────────────────────────────────

    function test_mintPair_multipleQuantity() public {
        uint256 yesId = uint256(marketId);
        uint256 noId = uint256(keccak256(abi.encode(marketId, "NO")));

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        market.mintPair(marketId, 5);

        assertEq(market.balanceOf(alice, yesId), 5);
        assertEq(market.balanceOf(alice, noId), 5);
        assertEq(usdc.balanceOf(alice), before - 5e6);

        (, , , , uint256 totalPairs, uint256 vault, , , ) = market.markets(marketId);
        assertEq(totalPairs, 5);
        assertEq(vault, 5e6);
    }

    function test_mintPair_revertsZeroQuantity() public {
        vm.prank(alice);
        vm.expectRevert(MeridianMarket.ZeroQuantity.selector);
        market.mintPair(marketId, 0);
    }

    // ── Vault balance invariant ────────────────────────────────────────────────

    function test_vaultBalance_equalsContractBalance() public {
        vm.startPrank(alice);
        market.mintPair(marketId, 1);
        market.mintPair(marketId, 1);
        vm.stopPrank();

        (, , , , , uint256 vault, , , ) = market.markets(marketId);
        assertEq(usdc.balanceOf(address(market)), vault);
    }
}
