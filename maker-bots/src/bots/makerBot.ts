/**
 * Maker Bot — two-sided liquidity provider.
 *
 * On each run, for every live (unsettled, not-yet-expired) market:
 *
 *   1. Cancel any resting orders from the previous cycle (stale quotes).
 *   2. Fetch the current asset price from Pyth Hermes.
 *   3. Compute a fair value using the sigmoid pricing model.
 *   4. Post a fresh YES ASK (above fair value) and YES BID (below fair value).
 *
 * The bot always re-quotes from scratch so prices stay current as the
 * underlying asset moves. Order IDs are stored in memory and cancelled at the
 * start of the next cycle via bulkCancelOrders (which silently ignores
 * already-filled IDs).
 *
 * Flow per market:
 *   mintPair(quantity)          → creates YES + NO tokens in maker wallet
 *   placeOrder(ASK, askPrice)   → resting YES sell order, returns askOrderId
 *   placeOrder(BID, bidPrice)   → resting USDC buy order, returns bidOrderId
 *
 * The maker keeps the NO tokens from each mintPair as a permanent inventory
 * position that pays out $1 if YES loses at settlement.
 */

import { botLogger } from "../logger.js";
import { config } from "../config.js";
import {
  getMakerWallet,
  getMarkets,
  getMarketCount,
  bulkCancelOrders,
  mintPair,
  placeOrder,
  ensureUsdcBalance,
  ensureUsdcAllowance,
  ensureErc1155Approval,
  bytes32ToTicker,
  Side,
} from "../contracts/client.js";
import { fetchLatestPrices, normalisePriceToExpo5 } from "../services/hermesClient.js";
import { computeFairValue, computeQuotes } from "../services/pricing.js";

const log = botLogger("makerBot");

// ── Persistent order state ────────────────────────────────────────────────────

interface MarketOrders {
  askOrderId: bigint;
  bidOrderId: bigint;
}

/**
 * In-memory store keyed by marketId hex.
 * Persists for the lifetime of the process; reset on restart (acceptable
 * because bulkCancelOrders handles unknown/stale IDs gracefully).
 */
const orderState = new Map<string, MarketOrders>();

// ── Main entry point ──────────────────────────────────────────────────────────

export async function runMakerBot(): Promise<void> {
  log.info("=== makerBot cycle started ===");

  const wallet = getMakerWallet();
  const makerAddress = await wallet.getAddress();

  // ── 1. Fetch all live markets ─────────────────────────────────────────────
  const count = await getMarketCount();
  if (count === 0n) {
    log.info("No markets found — nothing to quote");
    return;
  }

  const markets = await getMarkets(count);
  const nowSec = Math.floor(Date.now() / 1000);
  const liveMarkets = markets.filter(
    (m) => !m.settled && Number(m.expiryTimestamp) > nowSec
  );

  if (liveMarkets.length === 0) {
    log.info("No live markets — nothing to quote");
    return;
  }

  log.info({ total: markets.length, live: liveMarkets.length }, "Markets loaded");

  // ── 2. Fetch current prices from Hermes ───────────────────────────────────
  let priceMap: Map<string, { price: bigint; expo: number }>;
  try {
    const hermesResult = await fetchLatestPrices();
    priceMap = new Map(
      Array.from(hermesResult.entries()).map(([feedId, p]) => [
        feedId,
        { price: p.price, expo: p.expo },
      ])
    );
  } catch (err) {
    log.error({ err }, "Failed to fetch prices from Hermes — skipping cycle");
    return;
  }

  // ── 3. Build feedId → ticker map for quick lookup ─────────────────────────
  const tickerByFeed = new Map<string, string>();
  for (const [ticker, feedId] of Object.entries(config.feeds)) {
    tickerByFeed.set(feedId.replace(/^0x/, "").toLowerCase(), ticker);
  }

  // ── 4. Cancel all stale orders in a single bulk call ──────────────────────
  const allStaleIds: bigint[] = [];
  for (const orders of orderState.values()) {
    allStaleIds.push(orders.askOrderId, orders.bidOrderId);
  }
  if (allStaleIds.length > 0) {
    try {
      await bulkCancelOrders(wallet, allStaleIds);
      log.info({ count: allStaleIds.length }, "Stale orders cancelled");
    } catch (err) {
      // Non-fatal: some may have already been filled. We proceed with fresh quotes.
      log.warn({ err }, "bulkCancelOrders failed — proceeding with fresh quotes anyway");
    }
  }
  orderState.clear();

  // ── 5. Compute total USDC needed across all markets and ensure balance ──────
  // ASK side: mintPair costs quantity × 1 USDC each
  // BID side: placeOrder(BID) locks quantity × bidPrice × 1e4 USDC each
  // We calculate a safe upper bound assuming bidPrice ≤ 99¢ = 99e4 raw units per token
  const maxBidUsdcPerMarket =
    config.makerQuantity * BigInt(99) * 10_000n; // 99 cents × 1e4 raw units
  const mintUsdcPerMarket = config.makerQuantity * 1_000_000n; // 1 USDC per pair
  const totalUsdcNeeded =
    BigInt(liveMarkets.length) * (mintUsdcPerMarket + maxBidUsdcPerMarket);

  await ensureUsdcBalance(wallet, totalUsdcNeeded);
  await ensureUsdcAllowance(wallet, totalUsdcNeeded);
  await ensureErc1155Approval(wallet);

  // ── 6. Quote each live market ─────────────────────────────────────────────
  let quoted = 0;
  let skipped = 0;
  let errors = 0;

  for (const market of liveMarkets) {
    const ticker = bytes32ToTicker(market.ticker);

    // Find the feed ID for this ticker
    const feedId = config.feeds[ticker]?.replace(/^0x/, "").toLowerCase();
    if (!feedId) {
      log.debug({ ticker, marketId: market.marketId }, "No feed ID for ticker — skipping");
      skipped++;
      continue;
    }

    const priceEntry = priceMap.get(feedId);
    if (!priceEntry) {
      log.warn({ ticker, marketId: market.marketId }, "No Hermes price for ticker — skipping");
      skipped++;
      continue;
    }

    // Normalise current price to expo -5 (same as strikePrice)
    const currentPrice = normalisePriceToExpo5(priceEntry.price, priceEntry.expo);

    // Compute fair value and quotes
    const fairValue = computeFairValue(
      currentPrice,
      market.strikePrice,
      market.expiryTimestamp
    );
    const quotes = computeQuotes(fairValue);

    if (!quotes.shouldQuote) {
      log.info(
        { ticker, marketId: market.marketId, fairValue },
        "Fair value too extreme — skipping market"
      );
      skipped++;
      continue;
    }

    log.info(
      {
        ticker,
        marketId: market.marketId,
        currentPrice: currentPrice.toString(),
        strikePrice: market.strikePrice.toString(),
        fairValue,
        bidPrice: quotes.bidPrice,
        askPrice: quotes.askPrice,
        quantity: config.makerQuantity.toString(),
      },
      "Quoting market"
    );

    try {
      // Mint YES + NO pairs so the maker holds YES tokens to back the ASK order
      await mintPair(wallet, market.marketId, config.makerQuantity);

      // Post YES ASK (sell YES at askPrice, lock YES tokens as collateral)
      const askOrderId = await placeOrder(
        wallet,
        market.marketId,
        Side.ASK,
        quotes.askPrice,
        config.makerQuantity,
        false
      );

      // Post YES BID (buy YES at bidPrice, lock USDC as collateral)
      const bidOrderId = await placeOrder(
        wallet,
        market.marketId,
        Side.BID,
        quotes.bidPrice,
        config.makerQuantity,
        false
      );

      orderState.set(market.marketId, { askOrderId, bidOrderId });

      log.info(
        {
          ticker,
          marketId: market.marketId,
          askOrderId: askOrderId.toString(),
          bidOrderId: bidOrderId.toString(),
          fairValue,
          bidPrice: quotes.bidPrice,
          askPrice: quotes.askPrice,
        },
        "Market quoted successfully"
      );
      quoted++;
    } catch (err) {
      log.error(
        { err, ticker, marketId: market.marketId },
        "Failed to quote market — continuing"
      );
      errors++;
    }
  }

  log.info(
    { quoted, skipped, errors, makerAddress },
    "=== makerBot cycle completed ==="
  );
}
