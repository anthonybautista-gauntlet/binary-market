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
        const quote: any = await yahooFinance.quote(ticker);
        const price: number | undefined = quote?.regularMarketPrice ?? quote?.regularMarketClose;
        if (price == null || price <= 0) {
          logger.warn({ ticker }, "Yahoo Finance returned null/zero price");
          return;
        }
        prices[ticker] = price;
        logger.debug({ ticker, price }, "Yahoo Finance price fetched");
      } catch (err) {
        logger.warn({ ticker, err }, "Yahoo Finance fetch failed for ticker");
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
