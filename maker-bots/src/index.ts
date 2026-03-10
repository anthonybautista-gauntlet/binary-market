/**
 * Meridian Maker Bots — entry point.
 *
 * Runs two independent bots on separate cron schedules:
 *
 *   makerBot  — posts two-sided YES BID/ASK quotes around a dynamic fair value.
 *               Cancels and refreshes orders on every cycle.
 *               Default: every 5 minutes (MAKER_CRON).
 *
 *   buyerBot  — buys NO tokens in in-the-money markets (price > strike).
 *               Depth-guarded: never consumes all of the maker's BID liquidity.
 *               Default: every 30 minutes (BUYER_CRON).
 *
 * Both bots run immediately on startup so the book is populated right away.
 * Each bot is wrapped in safeRun() with an in-flight lock, so one bot's error
 * never kills the other and overlapping cycles are skipped.
 */

// Load .env before anything else (no-op if not present; Railway injects env vars)
import "dotenv/config";

import cron from "node-cron";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { runMakerBot } from "./bots/makerBot.js";
import { runBuyerBot } from "./bots/buyerBot.js";
import { getProvider } from "./contracts/client.js";

// ── Startup ───────────────────────────────────────────────────────────────────

async function startup(): Promise<void> {
  logger.info(
    {
      marketAddress: config.marketAddress,
      usdcAddress: config.usdcAddress,
      chainId: config.chainId,
      makerCron: config.makerCron,
      buyerCron: config.buyerCron,
      makerQuantity: config.makerQuantity.toString(),
      buyerQuantity: config.buyerQuantity.toString(),
      makerHalfSpread: config.makerHalfSpread,
      makerSensitivity: config.makerSensitivity,
    },
    "Maker bots starting"
  );

  // Verify RPC connectivity before scheduling
  try {
    const provider = getProvider();
    const network = await provider.getNetwork();
    logger.info({ chainId: network.chainId.toString() }, "RPC connection OK");

    if (network.chainId !== BigInt(config.chainId)) {
      logger.warn(
        { expected: config.chainId, actual: network.chainId.toString() },
        "Chain ID mismatch — check RPC_URL and CHAIN_ID"
      );
    }
  } catch (err) {
    logger.error({ err }, "RPC connection failed — check RPC_URL");
    process.exit(1);
  }
}

// ── Safe wrapper ──────────────────────────────────────────────────────────────

function safeRun(name: string, fn: () => Promise<void>): () => void {
  let inFlight = false;
  return () => {
    if (inFlight) {
      logger.warn({ bot: name }, `Skipping "${name}" run because previous cycle is still in-flight`);
      return;
    }
    inFlight = true;
    fn().catch((err) => {
      logger.error({ err, bot: name }, `Unhandled error in bot "${name}"`);
    }).finally(() => {
      inFlight = false;
    });
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await startup();

  const makerRunner = safeRun("makerBot", runMakerBot);
  const buyerRunner = safeRun("buyerBot", runBuyerBot);

  // Schedule maker (frequent — keeps quotes tight and fresh)
  cron.schedule(config.makerCron, makerRunner);
  logger.info({ cron: config.makerCron }, "makerBot scheduled");

  // Schedule buyer (less frequent — directional bets on ITM markets)
  cron.schedule(config.buyerCron, buyerRunner);
  logger.info({ cron: config.buyerCron }, "buyerBot scheduled");

  // Run both immediately so the book is populated on startup
  logger.info("Running initial bot cycles on startup...");
  makerRunner();

  // Stagger the buyer 15 seconds after the maker so the book has quotes to fill
  setTimeout(() => buyerRunner(), 15_000);

  logger.info("All bots scheduled — service is running");
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown(signal: string): void {
  logger.info({ signal }, "Shutdown signal received — stopping");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
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
