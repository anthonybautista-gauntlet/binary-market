/**
 * pricePusher job — testnet only (IS_TESTNET=true).
 *
 * Runs on a configurable interval (default: every 60 minutes).
 * Fetches current MAG7 prices from Pyth Hermes and pushes them to the
 * real Pyth oracle on Base Sepolia so on-chain price reads stay current.
 *
 * On mainnet this job is disabled — the real Pyth is a pull oracle and
 * prices are submitted on-demand at settlement time only.
 */

import { jobLogger } from "../logger.js";
import { config } from "../config.js";
import { fetchLatestPrices } from "../services/hermesClient.js";
import { buildUpdateData } from "../contracts/pythAdapter.js";
import { pushPythPriceUpdates } from "../contracts/marketContract.js";

const log = jobLogger("pricePusher");

/** Main entry point called by the scheduler. */
export async function runPricePusher(): Promise<void> {
  if (!config.isTestnet) {
    log.debug("Not testnet — pricePusher is a no-op");
    return;
  }

  const now = new Date();
  log.info({ ts: now.toISOString() }, "=== pricePusher job started ===");

  const allFeedIds = Object.values(config.feeds);

  let hermesPrices;
  try {
    hermesPrices = await fetchLatestPrices(allFeedIds);
  } catch (err) {
    log.error({ err }, "Hermes fetch failed — skipping price push");
    return;
  }

  if (hermesPrices.parsed.length === 0) {
    log.warn("No prices returned from Hermes — skipping");
    return;
  }

  // Staleness check: Pyth equity feeds publish every few seconds during NYSE hours.
  // A price older than pricePusherMaxAgeSecs means the publisher has gone quiet
  // (market closed, holiday, or publisher issue). We log a warning per stale feed.
  //
  // We cannot surgically remove individual feeds from a batch VAA, so the rule is:
  //   - Warn for each stale feed (the on-chain Pyth contract ignores prices where
  //     the incoming publishTime is not newer than the stored one, so no harm done).
  //   - Skip the entire push only if ALL feeds are stale — there is nothing to gain
  //     from a round-trip when every price is outdated.
  const nowSecs = Math.floor(Date.now() / 1000);
  let freshCount = 0;

  for (const p of hermesPrices.parsed) {
    const ageSecs = nowSecs - p.publishTime;
    if (ageSecs > config.pricePusherMaxAgeSecs) {
      log.warn(
        {
          feedId: p.feedId.slice(0, 10) + "…",
          publishTime: p.publishTime,
          ageSecs,
          maxAgeSecs: config.pricePusherMaxAgeSecs,
        },
        "Stale feed — publishTime exceeds max age (oracle will ignore if not newer)"
      );
    } else {
      freshCount++;
    }
  }

  if (freshCount === 0) {
    log.warn("All feeds are stale — skipping price push (market likely closed)");
    return;
  }

  log.info(
    {
      feeds: hermesPrices.parsed.map((p) => ({
        feedId: p.feedId.slice(0, 10) + "…",
        price: p.price.toString(),
        publishTime: p.publishTime,
        ageSecs: nowSecs - p.publishTime,
      })),
      freshCount,
      totalCount: hermesPrices.parsed.length,
    },
    `Pushing ${freshCount} fresh price(s) to Pyth oracle (${hermesPrices.parsed.length - freshCount} stale, skipped by oracle)`
  );

  const updateData = buildUpdateData(hermesPrices.parsed, hermesPrices.binaryData);

  try {
    await pushPythPriceUpdates(updateData);
    log.info({ count: updateData.length }, "=== pricePusher job completed ===");
  } catch (err) {
    log.error({ err }, "Pyth updatePriceFeeds tx failed");
  }
}
