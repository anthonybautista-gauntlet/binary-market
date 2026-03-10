// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../../src/MockUSDC.sol";

contract MockUSDCTest is Test {
    MockUSDC internal usdc;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        usdc = new MockUSDC();
    }

    // ── Metadata ─────────────────────────────────────────────────────────────

    function test_name() public view {
        assertEq(usdc.name(), "Mock USDC");
    }

    function test_symbol() public view {
        assertEq(usdc.symbol(), "USDC");
    }

    function test_decimals() public view {
        assertEq(usdc.decimals(), 6);
    }

    // ── Mint ─────────────────────────────────────────────────────────────────

    function test_mint_anyoneCanMint() public {
        vm.prank(alice);
        usdc.mint(alice, 1_000_000);
        assertEq(usdc.balanceOf(alice), 1_000_000);
    }

    function test_mint_toAnotherAddress() public {
        vm.prank(alice);
        usdc.mint(bob, 500_000);
        assertEq(usdc.balanceOf(bob), 500_000);
    }

    function test_mint_updatesTotalSupply() public {
        usdc.mint(alice, 1_000_000);
        usdc.mint(bob, 2_000_000);
        assertEq(usdc.totalSupply(), 3_000_000);
    }

    function test_mint_zeroAmount() public {
        usdc.mint(alice, 0);
        assertEq(usdc.balanceOf(alice), 0);
    }

    function testFuzz_mint(address to, uint256 amount) public {
        vm.assume(to != address(0));
        vm.assume(amount <= type(uint128).max); // avoid overflow in totalSupply
        usdc.mint(to, amount);
        assertEq(usdc.balanceOf(to), amount);
    }

    // ── Transfer ─────────────────────────────────────────────────────────────

    function test_transfer_succeeds() public {
        usdc.mint(alice, 1_000_000);
        vm.prank(alice);
        usdc.transfer(bob, 400_000);
        assertEq(usdc.balanceOf(alice), 600_000);
        assertEq(usdc.balanceOf(bob), 400_000);
    }

    function test_transfer_revertsInsufficientBalance() public {
        usdc.mint(alice, 100_000);
        vm.prank(alice);
        vm.expectRevert();
        usdc.transfer(bob, 200_000);
    }

    // ── Allowance / TransferFrom ──────────────────────────────────────────────

    function test_approve_and_transferFrom() public {
        usdc.mint(alice, 1_000_000);
        vm.prank(alice);
        usdc.approve(bob, 600_000);
        assertEq(usdc.allowance(alice, bob), 600_000);

        vm.prank(bob);
        usdc.transferFrom(alice, bob, 600_000);
        assertEq(usdc.balanceOf(alice), 400_000);
        assertEq(usdc.balanceOf(bob), 600_000);
    }

    function test_transferFrom_revertsWithoutApproval() public {
        usdc.mint(alice, 1_000_000);
        vm.prank(bob);
        vm.expectRevert();
        usdc.transferFrom(alice, bob, 1_000_000);
    }

    function test_transferFrom_revertsExceedingAllowance() public {
        usdc.mint(alice, 1_000_000);
        vm.prank(alice);
        usdc.approve(bob, 100_000);

        vm.prank(bob);
        vm.expectRevert();
        usdc.transferFrom(alice, bob, 200_000);
    }
}
