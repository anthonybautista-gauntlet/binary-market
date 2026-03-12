/**
 * settleMarkets job — runs at 16:05 ET Mon–Fri (13:05 ET on early-close days).
 *
 * For every unsettled, expired market on-chain:
 *   1. Determine the market's target close time (from its expiryTimestamp)
 *   2. Fetch the settlement price from Pyth Hermes at that timestamp
 *   3. Build priceUpdate bytes (mainnet VAA or testnet MockPyth encoding)
 *   4. Call settleMarket() with the SETTLER wallet
 *
 * Settlement window: [expiry - 5min, expiry + 10min] ≤ MAX_PARSE_WINDOW (900s).
 */

import { jobLogger } from "../logger.js";
import { config } from "../config.js";
import { isTradingDay } from "../services/calendarService.js";
import { fetchPricesAtTime } from "../services/hermesClient.js";
import { buildUpdateData } from "../contracts/pythAdapter.js";
import {
  getMarketCount,
  getRecentMarkets,
  settleMarket,
  getPythUpdateFee,
  bytes32ToTicker,
  type MarketView,
} from "../contracts/marketContract.js";
import { pythUnitsToDollars } from "../services/strikeCalc.js";

const log = jobLogger("settleMarkets");

/** Settlement window half-widths in seconds. Total must be ≤ MAX_PARSE_WINDOW (900s). */
const WINDOW_BEFORE_S = 300; // 5 min before expiry
const WINDOW_AFTER_S  = 600; // 10 min after expiry
const FINAL_RETRY_LIMIT = 25;

async function settleOneMarket(
  market: MarketView,
  feedId: string
): Promise<"settled" | "skipped" | "error"> {
  const expiryUnix = Number(market.expiryTimestamp);
  const minPublishTime = expiryUnix - WINDOW_BEFORE_S;
  const maxPublishTime = expiryUnix + WINDOW_AFTER_S;
  const ticker = bytes32ToTicker(market.ticker);

  log.info(
    {
      marketId: market.marketId,
      ticker,
      strike: pythUnitsToDollars(market.strikePrice),
      expiryUnix,
      minPublishTime,
      maxPublishTime,
    },
    "Fetching settlement price from Hermes"
  );

  let hermesPrices;
  try {
    hermesPrices = await fetchPricesAtTime([feedId], expiryUnix);
  } catch (err) {
    log.error({ err, marketId: market.marketId, ticker }, "Hermes fetch failed — skipping market");
    return "error";
  }

  if (hermesPrices.parsed.length === 0) {
    log.error({ marketId: market.marketId, ticker }, "No Hermes data returned — skipping");
    return "error";
  }

  const parsedPrice = hermesPrices.parsed[0];
  log.info(
    {
      feedId,
      publishTime: parsedPrice.publishTime,
      price: parsedPrice.price.toString(),
      display: pythUnitsToDollars(parsedPrice.price),
    },
    "Settlement price received"
  );

  if (
    parsedPrice.publishTime < minPublishTime ||
    parsedPrice.publishTime > maxPublishTime
  ) {
    log.error(
      {
        publishTime: parsedPrice.publishTime,
        minPublishTime,
        maxPublishTime,
        marketId: market.marketId,
      },
      "Hermes publishTime outside settlement window — cannot settle"
    );
    return "error";
  }

  const priceUpdate = buildUpdateData(hermesPrices.parsed, hermesPrices.binaryData);

  let pythFee: bigint;
  try {
    pythFee = await getPythUpdateFee(priceUpdate);
  } catch {
    pythFee = 1n;
  }

  try {
    await settleMarket(
      market.marketId,
      priceUpdate,
      minPublishTime,
      maxPublishTime,
      pythFee
    );
    log.info(
      {
        marketId: market.marketId,
        ticker,
        strike: pythUnitsToDollars(market.strikePrice),
        settlePrice: pythUnitsToDollars(parsedPrice.price),
      },
      "Market settled successfully"
    );
    return "settled";
  } catch (err) {
    log.error(
      { err, marketId: market.marketId, ticker },
      "settleMarket tx failed — manual review required"
    );
    return "error";
  }
}

/** Main entry point called by the scheduler. */
export async function runSettleMarkets(): Promise<void> {
  const now = new Date();
  const nowUnix = Math.floor(now.getTime() / 1000);
  log.info({ ts: now.toISOString() }, "=== settleMarkets job started ===");

  // ── 1. Find all unsettled, expired markets ────────────────────────────────
  let allMarkets: MarketView[];
  try {
    const count = await getMarketCount();
    if (count === 0n) {
      log.info("No markets on-chain — nothing to settle");
      return;
    }
    // Fetch all markets (count is typically small, e.g. <1000)
    allMarkets = await getRecentMarkets(count);
  } catch (err) {
    log.error({ err }, "Failed to fetch markets from chain — aborting settlement");
    return;
  }

  const toSettle = allMarkets.filter(
    (m) => !m.settled && m.expiryTimestamp <= BigInt(nowUnix)
  );

  if (toSettle.length === 0) {
    log.info("No unsettled, expired markets found — nothing to do");
    return;
  }

  log.info({ count: toSettle.length }, `Found ${toSettle.length} market(s) to settle`);

  // ── 2. Group markets by ticker + feedId to batch Hermes requests ──────────
  // Map: feedId → list of markets that need it
  const byFeed = new Map<string, MarketView[]>();
  for (const market of toSettle) {
    const ticker = bytes32ToTicker(market.ticker);
    const feedId = config.feeds[ticker];
    if (!feedId) {
      log.warn({ marketId: market.marketId, ticker }, "Unknown ticker — cannot settle");
      continue;
    }
    const list = byFeed.get(feedId) ?? [];
    list.push(market);
    byFeed.set(feedId, list);
  }

  // ── 3. Settle each market ─────────────────────────────────────────────────
  let totalSettled = 0;
  let totalErrors  = 0;

  for (const [feedId, markets] of byFeed.entries()) {
    for (const market of markets) {
      const result = await settleOneMarket(market, feedId);
      if (result === "settled") totalSettled++;
      if (result === "error") totalErrors++;
    }
  }

  // ── 4. Final failsafe sweep: retry a bounded set of still-unsettled markets ─
  try {
    const latest = await getRecentMarkets(await getMarketCount());
    const initialIds = new Set(toSettle.map((m) => m.marketId.toLowerCase()));
    const remaining = latest.filter(
      (m) =>
        !m.settled &&
        m.expiryTimestamp <= BigInt(nowUnix) &&
        initialIds.has(m.marketId.toLowerCase())
    );

    if (remaining.length > 0) {
      const retryBatch = remaining.slice(0, FINAL_RETRY_LIMIT);
      log.warn(
        {
          remaining: remaining.length,
          retryingNow: retryBatch.length,
          limit: FINAL_RETRY_LIMIT,
        },
        "Final unsettled sweep detected remaining markets; retrying before exit"
      );

      for (const market of retryBatch) {
        const ticker = bytes32ToTicker(market.ticker);
        const feedId = config.feeds[ticker];
        if (!feedId) {
          totalErrors++;
          continue;
        }
        const result = await settleOneMarket(market, feedId);
        if (result === "settled") totalSettled++;
        if (result === "error") totalErrors++;
      }
    }
  } catch (err) {
    log.error({ err }, "Final unsettled sweep failed");
  }

  log.info(
    { totalSettled, totalErrors },
    "=== settleMarkets job completed ==="
  );
}
