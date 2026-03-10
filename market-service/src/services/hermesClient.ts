/**
 * Pyth Hermes API client.
 *
 * Hermes is the off-chain price service for Pyth Network.
 * Docs: https://hermes.pyth.network/docs/
 *
 * Two fetch modes:
 *  - fetchLatestPrices:    GET /v2/updates/price/latest  (current prices)
 *  - fetchPricesAtTime:    GET /v2/updates/price/{timestamp} (historical, for settlement)
 *
 * Both return a HermesPriceResult containing:
 *  - parsed: decoded price data per feed (price, conf, expo, publishTime)
 *  - binaryData: raw VAA bytes per feed (hex-encoded, used as-is on mainnet)
 */

import { config } from "../config.js";
import { logger } from "../logger.js";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

export interface ParsedPrice {
  feedId: string;     // hex without 0x prefix
  price: bigint;      // int64 as bigint (Pyth native units, expo -5)
  conf: bigint;       // uint64 confidence interval
  expo: number;       // int32, always -5 for equity feeds
  publishTime: number; // unix timestamp
}

export interface HermesPriceResult {
  /** Decoded per-feed price data */
  parsed: ParsedPrice[];
  /**
   * Raw binary update data array — one entry per feed ID requested.
   * On mainnet: pass directly to settleMarket as priceUpdate[].
   * On testnet: the pythAdapter encodes these differently for MockPyth.
   * Each entry is a hex string without '0x'.
   */
  binaryData: string[];
}

interface HermesResponse {
  binary: {
    encoding: string;
    data: string[]; // base64 or hex encoded VAA per feed
  };
  parsed: Array<{
    id: string;
    price: {
      price: string;
      conf: string;
      expo: number;
      publish_time: number;
    };
    ema_price: {
      price: string;
      conf: string;
      expo: number;
      publish_time: number;
    };
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

/**
 * Fetch a single timestamp. Returns null on 404 (no data at that second).
 * Retries on transient network/server errors but not on 404.
 */
async function fetchAtTimestamp(url: string): Promise<HermesResponse | null> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 404) return null;
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

function parseResponse(data: HermesResponse): HermesPriceResult {
  const parsed: ParsedPrice[] = (data.parsed ?? []).map((p) => ({
    feedId: p.id,
    price: BigInt(p.price.price),
    conf: BigInt(p.price.conf),
    expo: p.price.expo,
    publishTime: p.price.publish_time,
  }));

  // Binary data: Hermes returns base64 by default; decode to hex
  const binaryData = (data.binary?.data ?? []).map((b64) => {
    const buf = Buffer.from(b64, "base64");
    return buf.toString("hex");
  });

  return { parsed, binaryData };
}

function buildIdsQuery(feedIds: string[]): string {
  return feedIds.map((id) => `ids[]=${id}`).join("&");
}

/**
 * Fetch the latest available prices for the given feed IDs.
 * Used by the pricePusher job.
 */
export async function fetchLatestPrices(feedIds: string[]): Promise<HermesPriceResult> {
  const query = buildIdsQuery(feedIds);
  const url = `${config.hermesUrl}/v2/updates/price/latest?${query}&encoding=base64&parsed=true`;
  logger.debug({ url }, "Hermes: fetchLatestPrices");
  const data = await fetchWithRetry(url);
  return parseResponse(data);
}

/**
 * Fetch prices at (or just before) a specific Unix timestamp.
 * Used by settleMarkets to get the closing price at market expiry.
 *
 * Equity feeds do not always publish at every second. If Hermes returns 404
 * for the exact timestamp, this function walks backwards in 60-second steps
 * up to `maxLookbackSeconds` (default: 300, matching the settlement window
 * minPublishTime = expiryTimestamp − 300s).
 *
 * @param feedIds            Array of Pyth feed IDs (with or without 0x prefix)
 * @param publishTime        Unix timestamp (seconds) — settlement expiry
 * @param maxLookbackSeconds How far back to search on 404 (default: 300s)
 */
export async function fetchPricesAtTime(
  feedIds: string[],
  publishTime: number,
  maxLookbackSeconds = 300
): Promise<HermesPriceResult> {
  const query = buildIdsQuery(feedIds);
  const minTime = publishTime - maxLookbackSeconds;

  for (let t = publishTime; t >= minTime; t -= 60) {
    const url = `${config.hermesUrl}/v2/updates/price/${t}?${query}&encoding=base64&parsed=true`;
    logger.debug({ url, publishTime: t }, "Hermes: fetchPricesAtTime");
    const data = await fetchAtTimestamp(url);
    if (data !== null) return parseResponse(data);
    if (t - 60 >= minTime) {
      logger.debug({ t, nextT: t - 60 }, "Hermes 404 at timestamp; trying 60s earlier");
    }
  }

  throw new Error(
    `Hermes: no price data found within ${maxLookbackSeconds}s window ending at ${publishTime}`
  );
}
