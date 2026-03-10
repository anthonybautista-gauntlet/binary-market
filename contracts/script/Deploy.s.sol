// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/MeridianMarket.sol";
import "../src/MockUSDC.sol";
import "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";

/// @notice Deploys MeridianMarket (+ optional mock dependencies) and registers
///         all 7 MAG7 Pyth feed IDs in a single transaction bundle.
///
/// Usage (testnet):
///   forge script script/Deploy.s.sol --rpc-url $BASE_SEPOLIA_RPC \
///     --broadcast --verify --private-key $DEPLOYER_PK \
///     --sig "run()"
///
/// Required env vars (set in .env, never commit):
///   DEPLOYER_PK       — private key of the deploying wallet (receives DEFAULT_ADMIN_ROLE)
///   DEPLOYER_ADDRESS  — public address matching DEPLOYER_PK
///
/// Optional env vars (sensible defaults shown):
///   PYTH_ADDRESS      — Pyth contract on target chain; leave empty only for local Anvil testing (auto-deploys MockPyth).
///                       Base Sepolia: 0xA2aa501b19aff244D90cc15a4Cf739D2725B5729
///                       Base Mainnet: 0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a
///   USDC_ADDRESS      — USDC on target chain; leave empty to deploy MockUSDC
///   FEE_RECIPIENT     — address receiving protocol fees (defaults to DEPLOYER_ADDRESS)
///   FEE_BPS           — fee in basis points, e.g. 50 = 0.5% (default: 50)
contract DeployScript is Script {
    // ── MAG7 Pyth feed IDs (verified on Base mainnet 2026-03-06) ──────────────
    bytes32 constant AAPL_FEED = 0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688;
    bytes32 constant MSFT_FEED = 0xd0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1;
    bytes32 constant NVDA_FEED = 0x61c4ca5b9731a79e285a01e24432d57d89f0ecdd4cd7828196ca8992d5eafef6;
    bytes32 constant GOOGL_FEED = 0xe65ff435be42630439c96396653a342829e877e2aafaeaf1a10d0ee5fd2cf3f2;
    bytes32 constant AMZN_FEED = 0x82c59e36a8e0247e15283748d6cd51f5fa1019d73fbf3ab6d927e17d9e357a7f;
    bytes32 constant META_FEED = 0x78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe;
    bytes32 constant TSLA_FEED = 0x42676a595d0099c381687124805c8bb22c75424dffcaa55e3dc6549854ebe20a;

    function run() external {
        address deployer      = vm.envAddress("DEPLOYER_ADDRESS");
        address pythAddress   = vm.envOr("PYTH_ADDRESS",   address(0));
        address usdcAddress   = vm.envOr("USDC_ADDRESS",   address(0));
        address feeRecipient  = vm.envOr("FEE_RECIPIENT",  deployer);
        address operatorAddr  = vm.envOr("OPERATOR_ADDRESS", address(0));
        address settlerAddr   = vm.envOr("SETTLER_ADDRESS",  address(0));
        uint16 feeBps         = uint16(vm.envOr("FEE_BPS", uint256(50)));

        vm.startBroadcast(vm.envUint("DEPLOYER_PK"));

        // Deploy MockPyth if no Pyth address is provided — for local Anvil testing only.
        // For Base Sepolia or mainnet, always set PYTH_ADDRESS to the real Pyth contract.
        if (pythAddress == address(0)) {
            MockPyth mockPyth = new MockPyth(3600, 0);
            pythAddress = address(mockPyth);
            console.log("MockPyth deployed at:", pythAddress);
        }

        // Deploy MockUSDC if no real USDC is provided (testnet only)
        if (usdcAddress == address(0)) {
            MockUSDC mockUsdc = new MockUSDC();
            usdcAddress = address(mockUsdc);
            console.log("MockUSDC deployed at:", usdcAddress);
        }

        MeridianMarket market = new MeridianMarket(
            pythAddress,
            usdcAddress,
            feeRecipient,
            feeBps
        );

        // Register all MAG7 feeds — deployer holds DEFAULT_ADMIN_ROLE
        market.setSupportedFeed(bytes32("AAPL"),  AAPL_FEED,  true);
        market.setSupportedFeed(bytes32("MSFT"),  MSFT_FEED,  true);
        market.setSupportedFeed(bytes32("NVDA"),  NVDA_FEED,  true);
        market.setSupportedFeed(bytes32("GOOGL"), GOOGL_FEED, true);
        market.setSupportedFeed(bytes32("AMZN"),  AMZN_FEED,  true);
        market.setSupportedFeed(bytes32("META"),  META_FEED,  true);
        market.setSupportedFeed(bytes32("TSLA"),  TSLA_FEED,  true);

        // Grant roles to operational wallets if provided
        if (operatorAddr != address(0)) {
            market.grantRole(market.OPERATOR_ROLE(), operatorAddr);
        }
        if (settlerAddr != address(0)) {
            market.grantRole(market.SETTLER_ROLE(), settlerAddr);
        }

        vm.stopBroadcast();

        console.log("MeridianMarket deployed at:", address(market));
        console.log("  Pyth oracle:             ", pythAddress);
        console.log("  USDC:                    ", usdcAddress);
        console.log("  Fee recipient:           ", feeRecipient);
        console.log("  Fee bps:                 ", feeBps);
        console.log("  Admin (DEFAULT_ADMIN_ROLE):", deployer);
        console.log("  MAG7 feeds registered:   7");
        if (operatorAddr != address(0)) {
            console.log("  OPERATOR_ROLE granted to:", operatorAddr);
        } else {
            console.log("  OPERATOR_ROLE: not granted (OPERATOR_ADDRESS not set)");
        }
        if (settlerAddr != address(0)) {
            console.log("  SETTLER_ROLE granted to: ", settlerAddr);
        } else {
            console.log("  SETTLER_ROLE:  not granted (SETTLER_ADDRESS not set)");
        }
    }
}
