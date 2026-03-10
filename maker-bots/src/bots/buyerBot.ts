/**
 * Buyer Bot — directional NO buyer.
 *
 * Buys NO tokens in markets where the current asset price is above the
 * strike price (i.e. YES is the likely winner at expiry, making NO cheap).
 *
 * The bot does NOT drain the order book. Before buying it checks:
 *  - That there is a best bid on the book (the maker has posted BIDs).
 *  - That the total BID depth exceeds BUYER_MIN_BID_DEPTH.
 *  - The actual quantity purchased leaves at least BUYER_RESERVE_DEPTH units
 *    of depth on the book for other participants.
 *
 * Flow per in-the-money market:
 *   1. currentPrice > strikePrice?           (only act when YES is ITM)
 *   2. bestBid > 0 && depth > minBidDepth?   (book has enough liquidity)
 *   3. buyQty = min(buyerQuantity, depth - reserveDepth)
 *   4. ensureUsdcBalance + ensureUsdcAllowance
 *   5. buyNoMarket(marketId, buyQty, minYesProceeds, maxFills)
 *        → mints buyQty pairs, sells all YES at market (fills BIDs), keeps NO
 */

import { botLogger } from "../logger.js";
import { config } from "../config.js";
import {
  getBuyerWallet,
  getMarkets,
  getMarketCount,
  bestBid,
  depthAt,
  buyNoMarket,
  ensureUsdcBalance,
  ensureUsdcAllowance,
  bytes32ToTicker,
  Side,
} from "../contracts/client.js";
import { fetchLatestPrices, normalisePriceToExpo5 } from "../services/hermesClient.js";

const log = botLogger("buyerBot");

export async function runBuyerBot(): Promise<void> {
  log.info("=== buyerBot cycle started ===");

  const wallet = getBuyerWallet();
  const buyerAddress = await wallet.getAddress();

  // ── 1. Fetch all live markets ─────────────────────────────────────────────
  const count = await getMarketCount();
  if (count === 0n) {
    log.info("No markets found — nothing to buy");
    return;
  }

  const markets = await getMarkets(count);
  const nowSec = Math.floor(Date.now() / 1000);
  const liveMarkets = markets.filter(
    (m) => !m.settled && Number(m.expiryTimestamp) > nowSec
  );

  if (liveMarkets.length === 0) {
    log.info("No live markets — nothing to buy");
    return;
  }

  log.info({ total: markets.length, live: liveMarkets.length }, "Markets loaded");

  // ── 2. Fetch current prices ───────────────────────────────────────────────
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

  // ── 3. Filter and process in-the-money markets ────────────────────────────
  let bought = 0;
  let skipped = 0;
  let errors = 0;

  for (const market of liveMarkets) {
    const ticker = bytes32ToTicker(market.ticker);
    const feedId = config.feeds[ticker]?.replace(/^0x/, "").toLowerCase();

    if (!feedId) {
      log.debug({ ticker, marketId: market.marketId }, "No feed ID for ticker — skipping");
      skipped++;
      continue;
    }

    const priceEntry = priceMap.get(feedId);
    if (!priceEntry) {
      log.warn({ ticker, marketId: market.marketId }, "No Hermes price — skipping");
      skipped++;
      continue;
    }

    // Normalise to same expo -5 as strikePrice for direct comparison
    const currentPrice = normalisePriceToExpo5(priceEntry.price, priceEntry.expo);

    // Only act when current price is strictly above the strike (YES is ITM)
    if (currentPrice <= market.strikePrice) {
      log.debug(
        {
          ticker,
          marketId: market.marketId,
          currentPrice: currentPrice.toString(),
          strikePrice: market.strikePrice.toString(),
        },
        "Price at or below strike — skipping"
      );
      skipped++;
      continue;
    }

    // ── 4. Depth guard: only buy if the book has enough BID liquidity ─────
    let bid: number;
    let depth: bigint;
    try {
      bid = await bestBid(market.marketId);
      if (bid === 0) {
        log.debug({ ticker, marketId: market.marketId }, "No BID depth — skipping");
        skipped++;
        continue;
      }
      depth = await depthAt(market.marketId, Side.BID, bid);
    } catch (err) {
      log.warn({ err, ticker, marketId: market.marketId }, "Failed to read book depth — skipping");
      skipped++;
      continue;
    }

    if (depth < config.buyerMinBidDepth) {
      log.debug(
        { ticker, marketId: market.marketId, depth: depth.toString(), minDepth: config.buyerMinBidDepth.toString() },
        "BID depth below minimum threshold — skipping"
      );
      skipped++;
      continue;
    }

    // Quantity = requested quantity, but capped so BUYER_RESERVE_DEPTH units remain
    const available = depth - config.buyerReserveDepth;
    if (available <= 0n) {
      log.debug({ ticker, marketId: market.marketId }, "Would exhaust reserved depth — skipping");
      skipped++;
      continue;
    }

    const buyQty =
      config.buyerQuantity < available ? config.buyerQuantity : available;

    log.info(
      {
        ticker,
        marketId: market.marketId,
        currentPrice: currentPrice.toString(),
        strikePrice: market.strikePrice.toString(),
        bestBid: bid,
        bookDepth: depth.toString(),
        buyQty: buyQty.toString(),
      },
      "Buying NO — price above strike"
    );

    // ── 5. Ensure USDC balance and allowance ──────────────────────────────
    // buyNoMarket mints pairs first: costs buyQty × 1 USDC (6 decimals)
    const usdcNeeded = buyQty * 1_000_000n;
    try {
      await ensureUsdcBalance(wallet, usdcNeeded);
      await ensureUsdcAllowance(wallet, usdcNeeded);
    } catch (err) {
      log.error({ err, ticker }, "Failed to prepare USDC — skipping market");
      errors++;
      continue;
    }

    // ── 6. Execute the buy ────────────────────────────────────────────────
    try {
      await buyNoMarket(
        wallet,
        market.marketId,
        buyQty,
        config.buyerMinYesProceeds,
        config.buyerMaxFills
      );

      log.info(
        {
          ticker,
          marketId: market.marketId,
          buyQty: buyQty.toString(),
          buyerAddress,
        },
        "NO tokens acquired"
      );
      bought++;
    } catch (err) {
      log.error(
        { err, ticker, marketId: market.marketId },
        "buyNoMarket failed — continuing"
      );
      errors++;
    }
  }

  log.info(
    { bought, skipped, errors, buyerAddress },
    "=== buyerBot cycle completed ==="
  );
}
