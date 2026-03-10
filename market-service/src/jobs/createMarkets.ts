/**
 * createMarkets job — runs at 08:00 ET Mon–Fri.
 *
 * For each MAG7 ticker:
 *   1. Fetch previous trading day's closing price from Pyth Hermes
 *   2. Compute up to 7 strike bins (±9%, ±6%, ±3%, ATM, rounded to $10)
 *   3. For each strike, check if the market already exists on-chain
 *   4. Create any missing markets with OPERATOR_ROLE wallet
 *
 * Guardrail: markets are only created if they don't already exist
 * (idempotent — safe to re-run).
 */

import { jobLogger } from "../logger.js";
import { config } from "../config.js";
import {
  isTradingDay,
  isEarlyClose,
  getMarketCloseTime,
  getPrevTradingDay,
} from "../services/calendarService.js";
import { fetchPricesAtTime } from "../services/hermesClient.js";
import { computeStrikes, pythUnitsToDollars } from "../services/strikeCalc.js";
import {
  computeMarketId,
  getMarketExpiry,
  createStrikeMarket,
  bytes32ToTicker,
} from "../contracts/marketContract.js";

const log = jobLogger("createMarkets");

/** Main entry point called by the scheduler. */
export async function runCreateMarkets(): Promise<void> {
  const now = new Date();
  log.info({ ts: now.toISOString() }, "=== createMarkets job started ===");

  // ── 1. Trading day check ──────────────────────────────────────────────────
  if (!isTradingDay(now)) {
    log.info("Not a trading day — skipping market creation");
    return;
  }

  // ── 2. Determine expiry (today's market close in ET) ─────────────────────
  const closeTime = getMarketCloseTime(now);
  const expiryTimestamp = BigInt(Math.floor(closeTime.getTime() / 1000));
  const isEarly = isEarlyClose(now);
  log.info(
    {
      expiryTimestamp: expiryTimestamp.toString(),
      closeTimeUTC: closeTime.toISOString(),
      earlyClose: isEarly,
    },
    "Market expiry set"
  );

  // ── 3. Fetch previous trading day's closing price from Hermes ─────────────
  const prevDay = getPrevTradingDay(now);
  const prevClose = getMarketCloseTime(prevDay);
  // Request a price at the exact prior close timestamp
  const prevCloseUnix = Math.floor(prevClose.getTime() / 1000);

  const allFeedIds = Object.values(config.feeds);
  log.info(
    { prevCloseUnix, prevCloseISO: prevClose.toISOString() },
    "Fetching previous-day closing prices from Hermes"
  );

  let hermesPrices;
  try {
    hermesPrices = await fetchPricesAtTime(allFeedIds, prevCloseUnix);
  } catch (err) {
    log.error({ err }, "Failed to fetch prices from Hermes — aborting market creation");
    return;
  }

  if (hermesPrices.parsed.length === 0) {
    log.error("Hermes returned no parsed prices — aborting");
    return;
  }

  // Build feedId → ParsedPrice map
  const priceByFeed = new Map(
    hermesPrices.parsed.map((p) => [p.feedId.replace(/^0x/, "").toLowerCase(), p])
  );

  // ── 4. Process each ticker ────────────────────────────────────────────────
  let totalCreated = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const ticker of config.tickers) {
    const feedId = config.feeds[ticker].replace(/^0x/, "").toLowerCase();
    const parsedPrice = priceByFeed.get(feedId);

    if (!parsedPrice) {
      log.warn({ ticker, feedId }, "No Hermes price returned for ticker — skipping");
      continue;
    }

    const refPrice = parsedPrice.price;
    log.info(
      { ticker, refPrice: refPrice.toString(), display: pythUnitsToDollars(refPrice) },
      "Computing strikes"
    );

    const strikes = computeStrikes(refPrice);
    log.info({ ticker, strikeCount: strikes.length, strikes: strikes.map(String) }, "Strikes computed");

    for (const strike of strikes) {
      const marketId = computeMarketId(ticker, strike, expiryTimestamp);
      try {
        // Check on-chain existence before attempting creation
        const existingExpiry = await getMarketExpiry(marketId);
        if (existingExpiry !== null) {
          log.debug(
            { ticker, strike: strike.toString(), display: pythUnitsToDollars(strike), marketId },
            "Market already exists — skipping"
          );
          totalSkipped++;
          continue;
        }

        // Create the market
        const newId = await createStrikeMarket(ticker, strike, expiryTimestamp);
        log.info(
          {
            ticker,
            strike: strike.toString(),
            display: pythUnitsToDollars(strike),
            marketId: newId,
            expiryTimestamp: expiryTimestamp.toString(),
          },
          "Market created"
        );
        totalCreated++;
      } catch (err) {
        log.error(
          { err, ticker, strike: strike.toString(), marketId },
          "Failed to create market — continuing with next strike"
        );
        totalErrors++;
      }
    }
  }

  log.info(
    { totalCreated, totalSkipped, totalErrors },
    "=== createMarkets job completed ==="
  );
}
