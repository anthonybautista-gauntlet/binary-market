// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../../src/MeridianMarket.sol";
import "../../src/MockUSDC.sol";
import "./handlers/MeridianHandler.sol";
import "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";

/// @notice Foundry invariant test suite for MeridianMarket.
///         The invariant runner calls random sequences of MeridianHandler functions,
///         checking each invariant after every call.
contract MeridianInvariant is Test {
    MeridianMarket internal market;
    MockUSDC internal usdc;
    MockPyth internal pyth;
    MeridianHandler internal handler;

    address internal admin;
    address internal operator;
    bytes32 internal marketId;

    bytes32 internal constant AAPL = bytes32("AAPL");
    bytes32 internal constant AAPL_FEED = 0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688;
    int64 internal constant STRIKE = 23_000_000;
    uint64 internal constant EXPIRY = 2_000_000_000;

    function setUp() public {
        admin = makeAddr("invariantAdmin");
        operator = makeAddr("invariantOperator");

        vm.startPrank(admin);
        pyth = new MockPyth(3600, 0);
        usdc = new MockUSDC();
        market = new MeridianMarket(address(pyth), address(usdc), admin, 50);
        market.grantRole(market.OPERATOR_ROLE(), operator);
        market.grantRole(market.SETTLER_ROLE(), admin);
        market.setSupportedFeed(AAPL, AAPL_FEED, true);
        vm.stopPrank();

        vm.prank(operator);
        marketId = market.createStrikeMarket(AAPL, STRIKE, EXPIRY);

        handler = new MeridianHandler(market, usdc, marketId, admin, operator);

        // Target only the handler for fuzzing
        targetContract(address(handler));
    }

    // ── Invariant 1: USDC balance >= vault balance ─────────────────────────────

    /// @notice The contract's actual USDC balance must always be >= vaultBalance.
    ///         (Accrued fees are included in vaultBalance but held in the contract.)
    function invariant_contractUSDCBalanceCoversVault() public view {
        (, , , , , uint256 vault, , , ) = market.markets(marketId);
        uint256 contractBalance = usdc.balanceOf(address(market));
        assertGe(contractBalance, vault, "USDC balance below vault");
    }

    // ── Invariant 2: Supply parity while unsettled ────────────────────────────

    /// @notice When the market is not settled, yesSupply must equal noSupply across all holders.
    ///         Yes and No tokens are always minted and burned in pairs.
    function invariant_supplyParityWhileUnsettled() public view {
        (, , , , , , , bool settled, ) = market.markets(marketId);
        if (settled) return; // skip after settlement

        uint256 yesSupply = handler.sumActorYesBalances() + handler.contractYesBalance();
        uint256 noSupply = handler.sumActorNoBalances() + handler.contractNoBalance();
        assertEq(yesSupply, noSupply, "YES/NO supply mismatch");
    }

    // ── Invariant 3: Vault covers redeemable obligations ─────────────────────

    /// @notice The vault balance must be >= total unredeemed pairs * 1e6.
    ///         After redemptions, the vault should have enough for remaining pairs.
    function invariant_vaultCoversOutstandingPairs() public view {
        (, , , , uint256 totalPairs, uint256 vault, , bool settled, ) = market.markets(marketId);
        if (!settled) {
            // Before settlement: vault should hold enough for all pairs (plus any pending orders)
            assertGe(vault, totalPairs * 1e6, "vault underfunded for pairs");
        }
    }

    // ── Invariant 4: Token IDs are always registered ─────────────────────────

    function invariant_tokenIdsRegistered() public view {
        uint256 yesId = uint256(marketId);
        uint256 noId = uint256(keccak256(abi.encode(marketId, "NO")));
        assertEq(market.tokenIdToMarket(yesId), marketId, "yesId not registered");
        assertEq(market.tokenIdToMarket(noId), marketId, "noId not registered");
    }

    // ── Invariant 5: uri() never reverts for valid token IDs ─────────────────

    function invariant_uriDoesNotRevert() public view {
        uint256 yesId = uint256(marketId);
        uint256 noId = uint256(keccak256(abi.encode(marketId, "NO")));
        market.uri(yesId);
        market.uri(noId);
    }
}
