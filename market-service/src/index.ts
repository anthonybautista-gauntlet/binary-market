/**
 * Meridian Market Service — entry point.
 *
 * Schedules four recurring jobs:
 *   createMarkets  — 08:00 ET Mon–Fri  (create today's strike markets)
 *   settleMarkets  — 16:05 ET Mon–Fri  (settle expired markets via Pyth/Hermes)
 *   adminSettle    — 16:15 ET Mon–Fri  (Yahoo Finance fallback for Pyth-failed markets)
 *   pricePusher    — every N minutes   (testnet-only: push live prices to Pyth oracle)
 *
 * Both settleMarkets and adminSettle run once on startup to recover any markets
 * that expired while the service was down.
 *
 * All cron expressions run in America/New_York timezone so DST is handled
 * automatically by node-cron.
 */

// Load .env before anything else (no-op if not present; Railway injects env vars)
import "dotenv/config";

import cron from "node-cron";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { runCreateMarkets } from "./jobs/createMarkets.js";
import { runSettleMarkets } from "./jobs/settleMarkets.js";
import { runAdminSettle } from "./jobs/adminSettle.js";
import { runPricePusher } from "./jobs/pricePusher.js";
import { getProvider } from "./contracts/marketContract.js";
import { isTradingDay, getMarketCloseTime } from "./services/calendarService.js";

const TIMEZONE = "America/New_York";

// ── Startup checks ────────────────────────────────────────────────────────────

async function startup(): Promise<void> {
  logger.info(
    {
      marketAddress: config.marketAddress,
      pythAddress: config.pythAddress,
      chainId: config.chainId,
      isTestnet: config.isTestnet,
      createMarketsCron: config.createMarketsCron,
      settleMarketsCron: config.settleMarketsCron,
      adminSettleCron: config.adminSettleCron,
    },
    "Market service starting"
  );

  // Verify RPC connectivity before scheduling anything
  try {
    const provider = getProvider();
    const network = await provider.getNetwork();
    logger.info({ chainId: network.chainId.toString() }, "RPC connection OK");

    if (network.chainId !== BigInt(config.chainId)) {
      logger.warn(
        { expected: config.chainId, actual: network.chainId.toString() },
        "Chain ID mismatch — check RPC_URL and CHAIN_ID env vars"
      );
    }
  } catch (err) {
    logger.error({ err }, "RPC connection failed — check RPC_URL");
    process.exit(1);
  }
}

// ── Job wrappers (catch all errors so uncaught exceptions don't kill the process) ──

function safeRun(name: string, fn: () => Promise<void>): () => void {
  return () => {
    fn().catch((err) => {
      logger.error({ err, job: name }, `Unhandled error in job "${name}"`);
    });
  };
}

// ── Scheduler ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await startup();

  // createMarkets: 08:00 ET Mon–Fri
  cron.schedule(config.createMarketsCron, safeRun("createMarkets", runCreateMarkets), {
    timezone: TIMEZONE,
  });
  logger.info({ cron: config.createMarketsCron, tz: TIMEZONE }, "createMarkets scheduled");

  // settleMarkets: 16:05 ET Mon–Fri
  cron.schedule(config.settleMarketsCron, safeRun("settleMarkets", runSettleMarkets), {
    timezone: TIMEZONE,
  });
  logger.info({ cron: config.settleMarketsCron, tz: TIMEZONE }, "settleMarkets scheduled");

  // adminSettle: 16:15 ET Mon–Fri (Yahoo Finance fallback for Pyth-failed markets)
  cron.schedule(config.adminSettleCron, safeRun("adminSettle", runAdminSettle), {
    timezone: TIMEZONE,
  });
  logger.info({ cron: config.adminSettleCron, tz: TIMEZONE }, "adminSettle scheduled");

  // pricePusher: every N minutes, testnet only
  if (config.isTestnet) {
    const pusherCron = `*/${config.pricePusherIntervalMin} * * * *`;
    cron.schedule(pusherCron, safeRun("pricePusher", runPricePusher));
    logger.info(
      { cron: pusherCron, intervalMin: config.pricePusherIntervalMin },
      "pricePusher scheduled (testnet)"
    );
    // Run immediately on startup so prices are live right away
    safeRun("pricePusher", runPricePusher)();
  }

  // Run both settlement jobs immediately on startup to recover any markets that
  // expired while the service was down. Both are fully idempotent — they skip
  // already-settled markets and markets not yet past their delay window.
  safeRun("settleMarkets", runSettleMarkets)();
  safeRun("adminSettle", runAdminSettle)();

  // Run createMarkets on startup if it's a trading day and the market hasn't
  // closed yet. The job is fully idempotent — it skips markets that already
  // exist — so restarting mid-day is safe and fills in any markets that were
  // missed (e.g. due to a Pyth outage at 08:00).
  const now = new Date();
  if (isTradingDay(now) && now < getMarketCloseTime(now)) {
    logger.info("Startup: running createMarkets catch-up check");
    safeRun("createMarkets", runCreateMarkets)();
  }

  logger.info("All jobs scheduled — service is running");
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown(signal: string): void {
  logger.info({ signal }, "Shutdown signal received — stopping");
  // node-cron tasks are cleaned up automatically when the process exits
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught exception");
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  logger.fatal({ reason }, "Unhandled promise rejection");
  process.exit(1);
});

main().catch((err) => {
  logger.fatal({ err }, "Fatal error during startup");
  process.exit(1);
});
