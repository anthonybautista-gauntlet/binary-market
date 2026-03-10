/**
 * Fair value pricing model for binary yes/no markets.
 *
 * Uses a sigmoid (tanh) function to map the normalised price distance from
 * strike to a fair probability for the YES outcome, adjusted for time
 * remaining. No volatility data or Black-Scholes is required — the model
 * is intentionally simple and tunable via env vars.
 *
 * Fair value ranges from 0 to 100 (representing cents):
 *   100 = certain YES win  (price infinitely above strike)
 *     0 = certain YES loss (price infinitely below strike)
 *    50 = at-the-money (current price == strike)
 *
 * The time weight increases conviction as expiry approaches: with 0 hours
 * remaining, the sigmoid is effectively twice as steep, meaning the fair
 * value snaps to 0 or 100 even for small price displacements.
 */

import { config } from "../config.js";

export interface QuoteResult {
  fairValue: number;   // 0–100 cents
  bidPrice: number;    // 1–98 cents (always < askPrice)
  askPrice: number;    // 2–99 cents (always > bidPrice)
  shouldQuote: boolean; // false if fair value is too extreme to quote safely
}

/**
 * Compute the fair value of the YES outcome in cents (0–100).
 *
 * @param currentPrice    Current asset price in Pyth units (expo -5)
 * @param strikePrice     Market strike price in Pyth units (expo -5)
 * @param expiryTimestamp Market expiry as Unix seconds
 */
export function computeFairValue(
  currentPrice: bigint,
  strikePrice: bigint,
  expiryTimestamp: bigint
): number {
  if (strikePrice === 0n) return 50;

  // Normalised distance from strike: positive = in-the-money for YES.
  // Using floating-point here is safe; we only need ~2 sig figs of precision.
  const x =
    Number(currentPrice - strikePrice) / Number(strikePrice < 0n ? -strikePrice : strikePrice);

  // Time remaining in hours, clamped to [0, MAKER_HOURS_TOTAL].
  const nowSec = Date.now() / 1000;
  const secsLeft = Math.max(0, Number(expiryTimestamp) - nowSec);
  const hoursLeft = Math.min(secsLeft / 3600, config.makerHoursTotal);

  // Time weight in [1, 2]: 1 at session open, 2 at expiry.
  // As expiry approaches, conviction about the outcome increases — the sigmoid
  // becomes steeper and the fair value moves further from 50.
  const timeWeight = 1 + Math.max(0, 1 - hoursLeft / config.makerHoursTotal);

  // Sigmoid scaled to [0, 100].
  const z = Math.tanh(x * timeWeight * config.makerSensitivity);
  return Math.round(50 + z * 50);
}

/**
 * Given a fair value, compute the BID and ASK prices the maker should post.
 *
 * @param fairValue    Fair value in cents (0–100), from computeFairValue
 * @returns            QuoteResult with bid/ask prices and a shouldQuote flag
 */
export function computeQuotes(fairValue: number): QuoteResult {
  const shouldQuote =
    fairValue >= config.makerMinFairValue && fairValue <= config.makerMaxFairValue;

  const rawAsk = fairValue + config.makerHalfSpread;
  const rawBid = fairValue - config.makerHalfSpread;

  // Clamp to valid priceCents range [1, 99] and ensure bid < ask.
  const askPrice = Math.min(99, Math.max(2, Math.ceil(rawAsk)));
  const bidPrice = Math.max(1, Math.min(98, Math.floor(rawBid)));

  return { fairValue, bidPrice, askPrice, shouldQuote };
}
