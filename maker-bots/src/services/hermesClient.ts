/**
 * Pyth Hermes API client — latest prices only.
 *
 * Fetches the most recent published price for each feed from the off-chain
 * Hermes service. Used by both bots to read current asset prices.
 *
 * Adapted from market-service/src/services/hermesClient.ts.
 */

import { config } from "../config.js";
import { logger } from "../logger.js";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

export interface ParsedPrice {
  feedId: string;  // hex without 0x prefix
  price: bigint;   // int64 as bigint (Pyth native units, expo -5 for equities)
  conf: bigint;    // uint64 confidence interval
  expo: number;    // int32, always -5 for equity feeds
  publishTime: number;
}

interface HermesResponse {
  binary: { encoding: string; data: string[] };
  parsed: Array<{
    id: string;
    price: { price: string; conf: string; expo: number; publish_time: number };
  }>;
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string): Promise<HermesResponse> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Hermes HTTP ${res.status}: ${body}`);
      }
      return (await res.json()) as HermesResponse;
    } catch (err) {
      lastErr = err;
      logger.warn({ err, attempt, url }, "Hermes request failed; retrying");
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  throw lastErr;
}

function buildIdsQuery(feedIds: string[]): string {
  return feedIds.map((id) => `ids[]=${id}`).join("&");
}

/**
 * Fetch the latest available prices for all MAG7 feed IDs.
 * Returns a map of feedId (lowercase hex, no 0x) → ParsedPrice.
 */
export async function fetchLatestPrices(): Promise<Map<string, ParsedPrice>> {
  const feedIds = Object.values(config.feeds);
  const query = buildIdsQuery(feedIds);
  const url = `${config.hermesUrl}/v2/updates/price/latest?${query}&encoding=base64&parsed=true`;

  logger.debug({ url }, "Hermes: fetchLatestPrices");
  const data = await fetchWithRetry(url);

  const result = new Map<string, ParsedPrice>();
  for (const p of data.parsed ?? []) {
    const feedId = p.id.replace(/^0x/, "").toLowerCase();
    result.set(feedId, {
      feedId,
      price: BigInt(p.price.price),
      conf: BigInt(p.price.conf),
      expo: p.price.expo,
      publishTime: p.price.publish_time,
    });
  }

  logger.debug({ count: result.size }, "Hermes: prices fetched");
  return result;
}

/**
 * Normalise a Pyth price to the same fixed-point scale as strikePrice (expo -5).
 * For equity feeds expo is always -5 so this is a no-op, but we handle other
 * exponents defensively.
 */
export function normalisePriceToExpo5(price: bigint, expo: number): bigint {
  const diff = expo - (-5); // how many powers of 10 to shift
  if (diff === 0) return price;
  if (diff > 0) return price * BigInt(10 ** diff);
  return price / BigInt(10 ** (-diff));
}
