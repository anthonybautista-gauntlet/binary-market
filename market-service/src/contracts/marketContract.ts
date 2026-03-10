/**
 * Typed ethers.js wrappers for MeridianMarket and MockPyth contracts.
 *
 * Exposes only the functions used by the automation jobs, with clear TypeScript
 * types instead of raw ABI call returns.
 */

import { Contract, JsonRpcProvider, NonceManager, Wallet, keccak256, AbiCoder } from "ethers";
import { config } from "../config.js";
import { logger } from "../logger.js";
import MeridianMarketAbi from "../abi/MeridianMarket.json" with { type: "json" };
import MockPythAbi from "../abi/MockPyth.json" with { type: "json" };

// ── Shared provider (read-only) ──────────────────────────────────────────────

let _provider: JsonRpcProvider | null = null;
export function getProvider(): JsonRpcProvider {
  if (!_provider) {
    _provider = new JsonRpcProvider(config.rpcUrl, config.chainId);
  }
  return _provider;
}

// ── Wallets ──────────────────────────────────────────────────────────────────
// NonceManager wraps each wallet to track nonces locally, preventing
// "nonce too low" errors when multiple transactions are sent in rapid succession.

let _operatorWallet: NonceManager | null = null;
export function getOperatorWallet(): NonceManager {
  if (!_operatorWallet) {
    _operatorWallet = new NonceManager(new Wallet(config.operatorPk, getProvider()));
  }
  return _operatorWallet;
}

let _settlerWallet: NonceManager | null = null;
export function getSettlerWallet(): NonceManager {
  if (!_settlerWallet) {
    _settlerWallet = new NonceManager(new Wallet(config.settlerPk, getProvider()));
  }
  return _settlerWallet;
}

let _adminWallet: NonceManager | null = null;
export function getAdminWallet(): NonceManager {
  if (!_adminWallet) {
    _adminWallet = new NonceManager(new Wallet(config.adminPk, getProvider()));
  }
  return _adminWallet;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface MarketView {
  marketId: string;    // bytes32 hex
  ticker: string;      // bytes32 hex (right-padded ASCII)
  strikePrice: bigint; // Pyth units (expo -5)
  expiryTimestamp: bigint;
  settled: boolean;
  yesWins: boolean;
  vaultBalance: bigint;
  feeBpsSnapshot: number;
}

export interface MarketStorage {
  ticker: string;
  strikePrice: bigint;
  pythFeedId: string;
  expiryTimestamp: bigint;
  totalPairsMinted: bigint;
  vaultBalance: bigint;
  feeBpsSnapshot: number;
  settled: boolean;
  yesWins: boolean;
}

// ── MeridianMarket contract ──────────────────────────────────────────────────

function getMarketReadContract(): Contract {
  return new Contract(config.marketAddress, MeridianMarketAbi, getProvider());
}

function getMarketWriteContract(wallet: NonceManager): Contract {
  return new Contract(config.marketAddress, MeridianMarketAbi, wallet);
}

/**
 * Compute the on-chain marketId for a (ticker, strikePrice, expiryTimestamp) triple.
 * Mirrors Solidity: keccak256(abi.encode(ticker, strikePrice, expiryTimestamp))
 */
export function computeMarketId(ticker: string, strikePrice: bigint, expiryTimestamp: bigint): string {
  // ticker must be bytes32 (right-padded)
  const tickerBytes32 = tickerToBytes32(ticker);
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "int64", "uint64"],
    [tickerBytes32, strikePrice, expiryTimestamp]
  );
  return keccak256(encoded);
}

/** Convert a ticker string (e.g. "AAPL") to bytes32 hex (right-padded with zeros). */
export function tickerToBytes32(ticker: string): string {
  const buf = Buffer.alloc(32);
  Buffer.from(ticker, "ascii").copy(buf);
  return `0x${buf.toString("hex")}`;
}

/** Convert a bytes32 hex to a trimmed ASCII ticker string. */
export function bytes32ToTicker(bytes32: string): string {
  const hex = bytes32.replace(/^0x/, "");
  const buf = Buffer.from(hex, "hex");
  // Trim null bytes
  let end = buf.length;
  while (end > 0 && buf[end - 1] === 0) end--;
  return buf.slice(0, end).toString("ascii");
}

/**
 * Check if a market already exists on-chain.
 * Returns null if not found, or the expiryTimestamp if it exists.
 */
export async function getMarketExpiry(marketId: string): Promise<bigint | null> {
  const contract = getMarketReadContract();
  const market = await contract.markets(marketId);
  const expiry = BigInt(market[3]); // expiryTimestamp is index 3
  return expiry === 0n ? null : expiry;
}

/** Return the total number of markets created. */
export async function getMarketCount(): Promise<bigint> {
  const contract = getMarketReadContract();
  return BigInt(await contract.marketCount());
}

/** Return the most recent `count` markets. */
export async function getRecentMarkets(count: bigint): Promise<MarketView[]> {
  const contract = getMarketReadContract();
  const raw: unknown[] = await contract.getMarkets(count);
  return (raw as any[]).map((m) => ({
    marketId: m.marketId,
    ticker: m.ticker,
    strikePrice: BigInt(m.strikePrice),
    expiryTimestamp: BigInt(m.expiryTimestamp),
    settled: Boolean(m.settled),
    yesWins: Boolean(m.yesWins),
    vaultBalance: BigInt(m.vaultBalance),
    feeBpsSnapshot: Number(m.feeBpsSnapshot),
  }));
}

/**
 * Create a strike market on-chain using the OPERATOR wallet.
 * @returns  The new marketId (bytes32 hex)
 */
export async function createStrikeMarket(
  ticker: string,
  strikePrice: bigint,
  expiryTimestamp: bigint
): Promise<string> {
  const wallet = getOperatorWallet();
  const contract = getMarketWriteContract(wallet);
  const tickerBytes32 = tickerToBytes32(ticker);

  logger.info(
    { ticker, strikePrice: strikePrice.toString(), expiryTimestamp: expiryTimestamp.toString() },
    "Sending createStrikeMarket tx"
  );

  const tx = await contract.createStrikeMarket(tickerBytes32, strikePrice, expiryTimestamp);
  const receipt = await tx.wait();

  // Parse the MarketCreated event to get the marketId
  const iface = contract.interface;
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === "MarketCreated") {
        return parsed.args[0] as string; // marketId is first indexed arg
      }
    } catch {
      // not our event
    }
  }

  // Fallback: compute deterministically
  return computeMarketId(ticker, strikePrice, expiryTimestamp);
}

/**
 * Settle a market using the SETTLER wallet.
 * @param priceUpdate  Array of encoded price update bytes (from pythAdapter)
 * @param minPublishTime  Unix seconds — start of settlement window
 * @param maxPublishTime  Unix seconds — end of settlement window (max spread 900s)
 * @param pythFeeWei  ETH value to attach for Pyth's getUpdateFee
 */
export async function settleMarket(
  marketId: string,
  priceUpdate: string[],
  minPublishTime: number,
  maxPublishTime: number,
  pythFeeWei: bigint
): Promise<void> {
  const wallet = getSettlerWallet();
  const contract = getMarketWriteContract(wallet);

  logger.info(
    { marketId, minPublishTime, maxPublishTime, pythFeeWei: pythFeeWei.toString() },
    "Sending settleMarket tx"
  );

  const tx = await contract.settleMarket(
    marketId,
    priceUpdate,
    minPublishTime,
    maxPublishTime,
    { value: pythFeeWei }
  );
  await tx.wait();
}

/** Get the fee required by the Pyth contract for a price update. */
export async function getPythUpdateFee(priceUpdate: string[]): Promise<bigint> {
  const pythContract = new Contract(config.pythAddress, MockPythAbi, getProvider());
  try {
    return BigInt(await pythContract.getUpdateFee(priceUpdate));
  } catch {
    // MockPyth may return 0 fee; real Pyth fee is typically very small
    return 1n; // send 1 wei as a safe default if the call fails
  }
}

/**
 * Settle a market using the admin's DEFAULT_ADMIN_ROLE and a manually supplied price.
 * Only callable >= ADMIN_OVERRIDE_DELAY (900s) after market expiry.
 *
 * @param manualPrice  Closing price in Pyth units (dollars * 100_000, expo -5)
 */
export async function adminSettleOverride(marketId: string, manualPrice: bigint): Promise<void> {
  const wallet = getAdminWallet();
  const contract = getMarketWriteContract(wallet);

  logger.info(
    { marketId, manualPrice: manualPrice.toString() },
    "Sending adminSettleOverride tx"
  );

  const tx = await contract.adminSettleOverride(marketId, manualPrice);
  await tx.wait();
}

// ── Pyth price push helpers (testnet only) ───────────────────────────────────

/**
 * Push current VAA price data to the Pyth oracle so on-chain reads stay fresh.
 * Only called on testnet (IS_TESTNET=true). The real Pyth contract on Base
 * Sepolia accepts the same updatePriceFeeds(bytes[]) interface as MockPyth.
 */
export async function pushPythPriceUpdates(updateData: string[]): Promise<void> {
  const wallet = getSettlerWallet(); // settler can push prices too
  const pythContract = new Contract(config.pythAddress, MockPythAbi, wallet);

  let fee = 0n;
  try {
    fee = BigInt(await pythContract.getUpdateFee(updateData));
  } catch {
    fee = 1n;
  }

  const tx = await pythContract.updatePriceFeeds(updateData, { value: fee });
  await tx.wait();
  logger.debug({ count: updateData.length }, "Pyth prices updated");
}
