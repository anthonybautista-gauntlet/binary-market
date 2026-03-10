/**
 * Typed ethers.js wrappers for MeridianMarket and MockUSDC.
 *
 * Exposes only the functions needed by the maker and buyer bots, with clear
 * TypeScript types. Each wallet is wrapped in NonceManager to prevent nonce
 * collisions when multiple transactions are sent in rapid succession.
 */

import {
  AbiCoder,
  Contract,
  JsonRpcProvider,
  keccak256,
  MaxUint256,
  NonceManager,
  Wallet,
} from "ethers";
import { config } from "../config.js";
import { logger } from "../logger.js";
import MeridianMarketAbi from "../abi/MeridianMarket.json" with { type: "json" };
import MockUSDCAbiJson from "../abi/MockUSDC.json" with { type: "json" };

// MockUSDC.json is a Foundry artifact: { abi: [...], bytecode: ... }
// MeridianMarket.json is a raw ABI array — no unwrapping needed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MockUSDCAbi = (MockUSDCAbiJson as any).abi as readonly object[];

// ── Side enum (mirrors OrderBookLib.Side) ────────────────────────────────────

export const Side = { BID: 0, ASK: 1 } as const;
export type SideValue = (typeof Side)[keyof typeof Side];

// ── Shared read-only provider ─────────────────────────────────────────────────

let _provider: JsonRpcProvider | null = null;
export function getProvider(): JsonRpcProvider {
  if (!_provider) {
    _provider = new JsonRpcProvider(config.rpcUrl, config.chainId);
  }
  return _provider;
}

// ── Wallets ───────────────────────────────────────────────────────────────────

let _makerWallet: NonceManager | null = null;
export function getMakerWallet(): NonceManager {
  if (!_makerWallet) {
    _makerWallet = new NonceManager(new Wallet(config.makerPk, getProvider()));
  }
  return _makerWallet;
}

let _buyerWallet: NonceManager | null = null;
export function getBuyerWallet(): NonceManager {
  if (!_buyerWallet) {
    _buyerWallet = new NonceManager(new Wallet(config.buyerPk, getProvider()));
  }
  return _buyerWallet;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function marketRead(): Contract {
  return new Contract(config.marketAddress, MeridianMarketAbi, getProvider());
}

function marketWrite(wallet: NonceManager): Contract {
  return new Contract(config.marketAddress, MeridianMarketAbi, wallet);
}

function usdcRead(): Contract {
  return new Contract(config.usdcAddress, MockUSDCAbi, getProvider());
}

function usdcWrite(wallet: NonceManager): Contract {
  return new Contract(config.usdcAddress, MockUSDCAbi, wallet);
}

// ── Token ID helpers ──────────────────────────────────────────────────────────

/** YES token ID for a market (mirrors on-chain: uint256(marketId)). */
export function yesTokenId(marketId: string): bigint {
  return BigInt(marketId);
}

/**
 * NO token ID for a market.
 * Mirrors on-chain: uint256(keccak256(abi.encode(marketId, "NO")))
 */
export function noTokenId(marketId: string): bigint {
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "string"],
    [marketId, "NO"]
  );
  return BigInt(keccak256(encoded));
}

/** Convert a bytes32 hex ticker to a trimmed ASCII string. */
export function bytes32ToTicker(bytes32: string): string {
  const hex = bytes32.replace(/^0x/, "");
  const buf = Buffer.from(hex, "hex");
  let end = buf.length;
  while (end > 0 && buf[end - 1] === 0) end--;
  return buf.slice(0, end).toString("ascii");
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MarketView {
  marketId: string;
  ticker: string;         // bytes32 hex
  strikePrice: bigint;    // Pyth units (expo -5)
  expiryTimestamp: bigint;
  settled: boolean;
  yesWins: boolean;
  vaultBalance: bigint;
  feeBpsSnapshot: number;
}

// ── Market reads ──────────────────────────────────────────────────────────────

/** Return all markets (pass a large count to fetch everything). */
export async function getMarkets(count: bigint): Promise<MarketView[]> {
  const contract = marketRead();
  const raw: unknown[] = await contract.getMarkets(count);
  return (raw as any[]).map((m) => ({
    marketId: m.marketId as string,
    ticker: m.ticker as string,
    strikePrice: BigInt(m.strikePrice),
    expiryTimestamp: BigInt(m.expiryTimestamp),
    settled: Boolean(m.settled),
    yesWins: Boolean(m.yesWins),
    vaultBalance: BigInt(m.vaultBalance),
    feeBpsSnapshot: Number(m.feeBpsSnapshot),
  }));
}

export async function getMarketCount(): Promise<bigint> {
  return BigInt(await marketRead().marketCount());
}

/** Best resting BID price in cents; 0 means no bids. */
export async function bestBid(marketId: string): Promise<number> {
  return Number(await marketRead().bestBid(marketId));
}

/** Best resting ASK price in cents; 0 means no asks. */
export async function bestAsk(marketId: string): Promise<number> {
  return Number(await marketRead().bestAsk(marketId));
}

/** Total resting quantity at a specific price level on a given side. */
export async function depthAt(
  marketId: string,
  side: SideValue,
  priceCents: number
): Promise<bigint> {
  return BigInt(await marketRead().depthAt(marketId, side, priceCents));
}

// ── ERC1155 balance reads ─────────────────────────────────────────────────────

export async function getYesBalance(address: string, marketId: string): Promise<bigint> {
  return BigInt(await marketRead().balanceOf(address, yesTokenId(marketId)));
}

export async function getNoBalance(address: string, marketId: string): Promise<bigint> {
  return BigInt(await marketRead().balanceOf(address, noTokenId(marketId)));
}

// ── USDC helpers ──────────────────────────────────────────────────────────────

/** Return the USDC balance (raw 6-decimal units) for an address. */
export async function getUsdcBalance(address: string): Promise<bigint> {
  return BigInt(await usdcRead().balanceOf(address));
}

/** Return the USDC allowance that `owner` has granted to the market contract. */
export async function getUsdcAllowance(owner: string): Promise<bigint> {
  return BigInt(await usdcRead().allowance(owner, config.marketAddress));
}

/**
 * Mint `amount` raw USDC units to `wallet`'s address if the current balance
 * is below `amount`. MockUSDC has no access control — testnet only.
 */
export async function ensureUsdcBalance(
  wallet: NonceManager,
  amount: bigint
): Promise<void> {
  const address = await wallet.getAddress();
  const balance = await getUsdcBalance(address);
  if (balance >= amount) return;

  const needed = amount - balance;
  logger.debug(
    { address, needed: needed.toString(), amount: amount.toString() },
    "Minting USDC"
  );
  const tx = await usdcWrite(wallet).mint(address, needed);
  await tx.wait();
  logger.debug({ address, needed: needed.toString() }, "USDC minted");
}

/**
 * Approve the market contract to spend USDC from `wallet` if the current
 * allowance is below `amount`. Uses MaxUint256 to avoid repeated approvals.
 */
export async function ensureUsdcAllowance(
  wallet: NonceManager,
  amount: bigint
): Promise<void> {
  const address = await wallet.getAddress();
  const allowance = await getUsdcAllowance(address);
  if (allowance >= amount) return;

  logger.debug({ address, amount: amount.toString() }, "Approving USDC");
  const tx = await usdcWrite(wallet).approve(config.marketAddress, MaxUint256);
  await tx.wait();
  logger.debug({ address }, "USDC approved (MaxUint256)");
}

/**
 * Grant setApprovalForAll on the ERC1155 contract so the market can transfer
 * YES tokens on behalf of `wallet` when placing ASK orders.
 */
export async function ensureErc1155Approval(wallet: NonceManager): Promise<void> {
  const address = await wallet.getAddress();
  const approved: boolean = await marketRead().isApprovedForAll(
    address,
    config.marketAddress
  );
  if (approved) return;

  logger.debug({ address }, "Setting ERC1155 approval for market contract");
  const tx = await marketWrite(wallet).setApprovalForAll(config.marketAddress, true);
  await tx.wait();
  logger.debug({ address }, "ERC1155 approval set");
}

// ── Market write calls ────────────────────────────────────────────────────────

/**
 * Mint `quantity` YES + NO token pairs for a market. Costs quantity × 1 USDC
 * (6-decimal raw: quantity × 1_000_000). Requires prior USDC approval.
 */
export async function mintPair(
  wallet: NonceManager,
  marketId: string,
  quantity: bigint
): Promise<void> {
  logger.debug({ marketId, quantity: quantity.toString() }, "mintPair");
  // Explicit gasLimit skips eth_estimateGas — avoids stale-read failures on
  // public load-balanced RPC endpoints (read-your-writes inconsistency).
  const tx = await marketWrite(wallet).mintPair(marketId, quantity, { gasLimit: 300_000n });
  await tx.wait();
}

/**
 * Place a resting limit order (BID or ASK). Returns the on-chain orderId which
 * must be stored for later cancellation. Requires:
 *  - BID: USDC approval for quantity × priceCents × 1e4 raw units
 *  - ASK: ERC1155 approval + YES tokens in wallet (from mintPair)
 */
export async function placeOrder(
  wallet: NonceManager,
  marketId: string,
  side: SideValue,
  priceCents: number,
  quantity: bigint,
  isIOC = false
): Promise<bigint> {
  logger.debug(
    { marketId, side, priceCents, quantity: quantity.toString(), isIOC },
    "placeOrder"
  );
  const contract = marketWrite(wallet);
  // Explicit gasLimit skips eth_estimateGas — avoids stale-read failures on
  // public load-balanced RPC endpoints (read-your-writes inconsistency).
  // 1.5M covers resting orders (avg ~290k) and several crossing fills comfortably.
  const tx = await contract.placeOrder(marketId, side, priceCents, quantity, isIOC, { gasLimit: 1_500_000n });
  const receipt = await tx.wait();

  // Parse OrderPlaced event to extract the orderId
  const iface = contract.interface;
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === "OrderPlaced") {
        return BigInt(parsed.args[1]); // orderId is the second indexed arg
      }
    } catch {
      // not our event
    }
  }

  throw new Error("OrderPlaced event not found in placeOrder receipt");
}

/**
 * Cancel multiple orders in a single transaction. The contract silently skips
 * any orderId that is not owned by the caller (already filled or cancelled).
 * Safe to call with an empty array.
 */
export async function bulkCancelOrders(
  wallet: NonceManager,
  orderIds: bigint[]
): Promise<void> {
  if (orderIds.length === 0) return;
  logger.debug({ count: orderIds.length }, "bulkCancelOrders");
  // Max observed: 156k. Scale with order count; 500k covers ~25 orders safely.
  const gasLimit = BigInt(Math.max(200_000, orderIds.length * 20_000));
  const tx = await marketWrite(wallet).bulkCancelOrders(orderIds, { gasLimit });
  await tx.wait();
  logger.debug({ count: orderIds.length }, "Orders cancelled");
}

/**
 * Atomically mint `quantity` pairs and sell all YES tokens at market price (IOC).
 * Keeps the NO tokens. Used by the buyer bot.
 *
 * @param minYesSaleProceeds  Minimum USDC (raw 6-decimal) received from YES sell.
 *                            Pass 0n to accept any price.
 * @param maxFills            Maximum number of resting BID orders to cross.
 */
export async function buyNoMarket(
  wallet: NonceManager,
  marketId: string,
  quantity: bigint,
  minYesSaleProceeds: bigint,
  maxFills: number
): Promise<void> {
  logger.debug(
    { marketId, quantity: quantity.toString(), minYesSaleProceeds: minYesSaleProceeds.toString() },
    "buyNoMarket"
  );
  const tx = await marketWrite(wallet).buyNoMarket(
    marketId,
    quantity,
    minYesSaleProceeds,
    maxFills
  );
  await tx.wait();
}
