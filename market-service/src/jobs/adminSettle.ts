/**
 * adminSettle job — runs at 16:15 ET Mon–Fri (configurable via ADMIN_SETTLE_CRON).
 *
 * This is a fallback for markets that could not be settled via the normal Pyth/Hermes
 * path (e.g. publisher outages, stale data). It runs 15 minutes after NYSE close,
 * which is exactly when MeridianMarket.ADMIN_OVERRIDE_DELAY (900s) expires.
 *
 * Flow per unsettled market:
 *   1. Filter: not settled AND block.timestamp >= expiryTimestamp + 900
 *   2. Look up the closing price from Yahoo Finance for the market's ticker
 *   3. Convert dollars → Pyth units (expo -5, multiply by 100_000)
 *   4. Call adminSettleOverride(marketId, manualPrice) with DEFAULT_ADMIN_ROLE wallet
 *
 * The job also runs once on startup (catch-up for markets that expired while
 * the service was offline).
 */

import { jobLogger } from "../logger.js";
import { config } from "../config.js";
import { isTradingDay } from "../services/calendarService.js";
import { fetchYahooClosingPrices, dollarsToPythUnits } from "../services/yahooFinance.js";
import {
  getMarketCount,
  getRecentMarkets,
  adminSettleOverride,
  bytes32ToTicker,
  type MarketView,
} from "../contracts/marketContract.js";

const log = jobLogger("adminSettle");

// ADMIN_OVERRIDE_DELAY on-chain value (seconds) — must match MeridianMarket.sol
const ADMIN_OVERRIDE_DELAY_S = 900n;

export async function runAdminSettle(): Promise<void> {
  const now = new Date();
  log.info({ ts: now.toISOString() }, "=== adminSettle job started ===");

  if (!isTradingDay(now)) {
    log.info("Not a trading day — adminSettle is a no-op");
    return;
  }

  // ── Fetch all markets ────────────────────────────────────────────────────
  let total: bigint;
  try {
    total = await getMarketCount();
  } catch (err) {
    log.error({ err }, "Failed to fetch market count — aborting");
    return;
  }

  if (total === 0n) {
    log.info("No markets on contract — nothing to do");
    return;
  }

  let markets: MarketView[];
  try {
    markets = await getRecentMarkets(total);
  } catch (err) {
    log.error({ err }, "Failed to fetch markets — aborting");
    return;
  }

  // ── Filter to markets needing admin override ──────────────────────────────
  const nowSecs = BigInt(Math.floor(Date.now() / 1000));

  const candidates = markets.filter((m) => {
    if (m.settled) return false;
    // Not yet expired
    if (nowSecs < m.expiryTimestamp) return false;
    // Still within the mandatory delay window
    if (nowSecs < m.expiryTimestamp + ADMIN_OVERRIDE_DELAY_S) return false;
    return true;
  });

  if (candidates.length === 0) {
    log.info("No markets require admin override settlement");
    return;
  }

  log.info({ count: candidates.length }, "Markets requiring admin override");

  // ── Fetch Yahoo Finance closing prices ────────────────────────────────────
  let yahooPrice: Record<string, number>;
  try {
    yahooPrice = await fetchYahooClosingPrices();
  } catch (err) {
    log.error({ err }, "Yahoo Finance fetch failed — aborting adminSettle");
    return;
  }

  const fetchedTickers = Object.keys(yahooPrice);
  if (fetchedTickers.length === 0) {
    log.warn("Yahoo Finance returned no prices — aborting adminSettle");
    return;
  }

  log.info(
    { prices: Object.fromEntries(Object.entries(yahooPrice).map(([t, p]) => [t, p.toFixed(2)])) },
    "Yahoo Finance prices fetched"
  );

  // ── Settle each candidate ─────────────────────────────────────────────────
  let settled = 0;
  let skipped = 0;

  for (const market of candidates) {
    const ticker = bytes32ToTicker(market.ticker);
    const dollarPrice = yahooPrice[ticker];

    if (dollarPrice == null) {
      log.warn(
        { marketId: market.marketId, ticker },
        "No Yahoo Finance price for ticker — skipping market"
      );
      skipped++;
      continue;
    }

    const pythPrice = dollarsToPythUnits(dollarPrice);
    const strikeDollars = Number(market.strikePrice) / 100_000;
    const yesWins = pythPrice >= market.strikePrice;

    log.info(
      {
        marketId: market.marketId,
        ticker,
        strikeDollars: strikeDollars.toFixed(2),
        closeDollars: dollarPrice.toFixed(2),
        pythPrice: pythPrice.toString(),
        outcome: yesWins ? "YES wins" : "NO wins",
      },
      "Settling via adminSettleOverride"
    );

    try {
      await adminSettleOverride(market.marketId, pythPrice);
      log.info({ marketId: market.marketId, ticker }, "adminSettleOverride succeeded");
      settled++;
    } catch (err) {
      log.error({ err, marketId: market.marketId, ticker }, "adminSettleOverride tx failed");
      skipped++;
    }
  }

  log.info(
    { settled, skipped, total: candidates.length },
    "=== adminSettle job completed ==="
  );
}
