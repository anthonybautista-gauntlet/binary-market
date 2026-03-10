// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUSDC
/// @notice Free-mint ERC20 with 6 decimals for testnet use. No access control — anyone can mint.
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mint `amount` tokens to `to`. No restrictions — testnet only.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
