const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
] as const;

export interface PolymarketSubMarket {
  id: string;
  question: string;
  slug: string;
  groupItemTitle: string;
  outcomePrices: string;
  volume?: string | number;
  volumeNum?: number;
  liquidity?: string | number;
  liquidityNum?: number;
  bestBid?: number;
  bestAsk?: number;
  lastTradePrice?: number;
  active: boolean;
  closed: boolean;
}

export interface PolymarketEvent {
  id: string;
  slug: string;
  title: string;
  volume?: number;
  volume24hr?: number;
  liquidity?: number;
  active: boolean;
  closed: boolean;
  endDate: string;
  markets: PolymarketSubMarket[];
}

/** Safely coerce a value that might be number, string, null, or undefined to a finite number. */
export function safeNum(val: unknown): number {
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
}

/** Extract the best available volume from a Polymarket sub-market. */
export function marketVolume(m: PolymarketSubMarket): number {
  return safeNum(m.volumeNum ?? m.volume);
}

/** Extract the best available volume from a Polymarket event. */
export function eventVolume24h(e: PolymarketEvent): number {
  return safeNum(e.volume24hr ?? e.volume);
}

/** Extract the best available liquidity from a Polymarket event. */
export function eventLiquidity(e: PolymarketEvent): number {
  return safeNum(e.liquidity);
}

/**
 * Builds the Polymarket event slug for a "closes above" market from a
 * Meridian ticker and the on-chain expiry timestamp (Unix seconds).
 *
 * The date is interpreted in America/New_York because Meridian and
 * Polymarket both settle on NYSE close (4 PM ET).
 */
export function buildPolymarketSlug(ticker: string, expiryTimestamp: bigint): string {
  const date = new Date(Number(expiryTimestamp) * 1000);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(date);

  const monthNum = Number(parts.find(p => p.type === 'month')!.value);
  const day = parts.find(p => p.type === 'day')!.value;
  const year = parts.find(p => p.type === 'year')!.value;
  const month = MONTHS[monthNum - 1];

  return `${ticker.toLowerCase()}-close-above-on-${month}-${day}-${year}`;
}

export function buildPolymarketEventUrl(slug: string): string {
  return `https://polymarket.com/event/${slug}`;
}

export function buildPolymarketStrikeUrl(eventSlug: string, marketSlug: string): string {
  return `https://polymarket.com/event/${eventSlug}?marketSlug=${marketSlug}`;
}

/**
 * Parses the YES probability from a Polymarket sub-market's
 * `outcomePrices` JSON string (e.g. `'["0.9995","0.0005"]'`).
 */
export function parseYesProbability(outcomePrices: string): number {
  try {
    const parsed = JSON.parse(outcomePrices) as string[];
    return Number(parsed[0]);
  } catch {
    return 0;
  }
}

/**
 * Finds the Polymarket sub-market whose strike matches the given dollar
 * amount. Returns `undefined` when there is no exact match.
 */
export function findMatchingMarket(
  polymarkets: PolymarketSubMarket[],
  strikeDollars: number,
): PolymarketSubMarket | undefined {
  return polymarkets.find(m => {
    const pmStrike = parseInt(m.groupItemTitle.replace('$', ''), 10);
    return pmStrike === strikeDollars;
  });
}

/**
 * Returns the two nearest Polymarket sub-markets that bracket the given
 * strike (one below, one above). Either or both can be `undefined`.
 */
export function findBracketingMarkets(
  polymarkets: PolymarketSubMarket[],
  strikeDollars: number,
): { below?: PolymarketSubMarket; above?: PolymarketSubMarket } {
  const sorted = [...polymarkets]
    .map(m => ({ market: m, strike: parseInt(m.groupItemTitle.replace('$', ''), 10) }))
    .sort((a, b) => a.strike - b.strike);

  let below: typeof sorted[number] | undefined;
  let above: typeof sorted[number] | undefined;

  for (const entry of sorted) {
    if (entry.strike < strikeDollars) below = entry;
    if (entry.strike > strikeDollars && !above) above = entry;
  }

  return { below: below?.market, above: above?.market };
}

/**
 * Returns the Polymarket sub-market closest to the given strike.
 * Used as a fallback when no exact match exists.
 */
export function findNearestMarket(
  polymarkets: PolymarketSubMarket[],
  strikeDollars: number,
): PolymarketSubMarket | undefined {
  let nearest: PolymarketSubMarket | undefined;
  let minDist = Infinity;

  for (const m of polymarkets) {
    const pmStrike = parseInt(m.groupItemTitle.replace('$', ''), 10);
    const dist = Math.abs(pmStrike - strikeDollars);
    if (dist < minDist) {
      minDist = dist;
      nearest = m;
    }
  }

  return nearest;
}
