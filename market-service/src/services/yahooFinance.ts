/**
 * Yahoo Finance closing price fetcher.
 *
 * Used by the adminSettle job as a fallback when Pyth/Hermes does not have
 * settlement-window price data for a given feed. Returns the most recent
 * regular-market closing price for each MAG7 ticker.
 *
 * Uses the unofficial yahoo-finance2 npm package (no API key required).
 * The `regularMarketPrice` field reflects the official NYSE closing price
 * after 16:00 ET once the market has closed.
 */

import yahooFinance from "yahoo-finance2";
import { logger } from "../logger.js";
import { config } from "../config.js";

export type TickerPrices = Record<string, number>;

// Mimic a browser User-Agent so cloud datacenter IPs are not blocked by Yahoo.
// Passed per-request via moduleOptions (v3 doesn't allow options() on the singleton).
const YAHOO_MODULE_OPTIONS = {
  fetchOptions: {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    },
  },
} as const;

/**
 * Fetch the most recent closing prices for all configured MAG7 tickers.
 *
 * Returns a map of ticker → price in dollars (e.g. { AAPL: 227.35, ... }).
 * Tickers that fail are excluded from the result with a warning logged.
 */
export async function fetchYahooClosingPrices(): Promise<TickerPrices> {
  const prices: TickerPrices = {};

  await Promise.all(
    config.tickers.map(async (ticker) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const quote: any = await yahooFinance.quote(ticker, {}, YAHOO_MODULE_OPTIONS);
        const price: number | undefined = quote?.regularMarketPrice ?? quote?.regularMarketClose;
        if (price == null || price <= 0) {
          logger.warn({ ticker }, "Yahoo Finance returned null/zero price");
          return;
        }
        prices[ticker] = price;
        logger.debug({ ticker, price }, "Yahoo Finance price fetched");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ ticker, error: message }, "Yahoo Finance fetch failed for ticker");
      }
    })
  );

  return prices;
}

/**
 * Convert a dollar price (e.g. 227.35) to Pyth units at expo -5.
 * Rounds to the nearest integer unit (accuracy to $0.00001).
 */
export function dollarsToPythUnits(dollars: number): bigint {
  return BigInt(Math.round(dollars * 100_000));
}
