/**
 * Strike bin calculation — exact integer mirror of the Solidity logic in
 * contracts/script/CreateMarkets.s.sol: _computeStrikes() and _roundToTen().
 *
 * All values are in Pyth native units at expo -5:
 *   $1.00 = 100_000 units
 *   $10.00 = 1_000_000 units
 *
 * Strike offsets: −9%, −6%, −3%, ATM, +3%, +6%, +9% → up to 7 values.
 * Each is rounded to the nearest $10 (1_000_000 units).
 * Duplicate strikes (common for lower-priced stocks) are deduplicated.
 */

/** Pyth units per dollar (expo -5): $1 = 100_000 */
const PYTH_UNITS_PER_DOLLAR = 100_000n;

/** Rounding unit: $10 = 1_000_000 Pyth units */
const ROUND_UNIT = 1_000_000n;

/** Percentage multipliers × 1000 for each of the 7 strike offsets */
const OFFSETS = [910n, 940n, 970n, 1000n, 1030n, 1060n, 1090n] as const;

/**
 * Round to the nearest $10 using integer arithmetic.
 * Mirrors Solidity: ((price + unit / 2) / unit) * unit
 *
 * @param price  Pyth native int64 value (bigint)
 */
export function roundToTen(price: bigint): bigint {
  return ((price + ROUND_UNIT / 2n) / ROUND_UNIT) * ROUND_UNIT;
}

/**
 * Compute up to 7 deduplicated strike prices for a given reference price.
 *
 * @param refPrice  Reference price in Pyth units (e.g. 25_600_000n for $256)
 * @returns  Sorted, deduplicated array of strike prices in Pyth units
 */
export function computeStrikes(refPrice: bigint): bigint[] {
  const seen = new Set<bigint>();
  const strikes: bigint[] = [];

  for (const offset of OFFSETS) {
    const raw = (refPrice * offset) / 1000n;
    const rounded = roundToTen(raw);
    if (rounded > 0n && !seen.has(rounded)) {
      seen.add(rounded);
      strikes.push(rounded);
    }
  }

  return strikes;
}

/**
 * Convert a whole-dollar price to Pyth units (expo -5).
 * e.g. 256 → 25_600_000n
 */
export function dollarsToPythUnits(dollars: number): bigint {
  return BigInt(dollars) * PYTH_UNITS_PER_DOLLAR;
}

/**
 * Convert Pyth units to a human-readable dollar string.
 * e.g. 25_600_000n → "$256.00"
 */
export function pythUnitsToDollars(units: bigint): string {
  const dollars = units / PYTH_UNITS_PER_DOLLAR;
  const cents = (units % PYTH_UNITS_PER_DOLLAR) / 1000n;
  return `$${dollars}.${String(cents).padStart(2, "0")}`;
}
