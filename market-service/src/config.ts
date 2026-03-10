/**
 * Validates all required environment variables on startup and exports a
 * single typed config object. The process exits immediately if any required
 * variable is missing, so the rest of the codebase can assume everything
 * is present.
 */

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

function validateConfig() {
  const required = ["RPC_URL", "MARKET_ADDRESS", "PYTH_ADDRESS", "OPERATOR_PK", "SETTLER_PK", "ADMIN_PK"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

validateConfig();

export const config = {
  // Chain
  rpcUrl: requireEnv("RPC_URL"),
  chainId: parseInt(optionalEnv("CHAIN_ID", "84532"), 10),

  // Contracts
  marketAddress: requireEnv("MARKET_ADDRESS"),
  pythAddress: requireEnv("PYTH_ADDRESS"),

  // Wallets (private keys)
  operatorPk: requireEnv("OPERATOR_PK"),
  settlerPk: requireEnv("SETTLER_PK"),
  adminPk: requireEnv("ADMIN_PK"),

  // Mode
  isTestnet: optionalEnv("IS_TESTNET", "false").toLowerCase() === "true",

  // Hermes
  hermesUrl: optionalEnv("HERMES_URL", "https://hermes.pyth.network"),

  // Scheduling (cron in America/New_York)
  createMarketsCron: optionalEnv("CREATE_MARKETS_CRON", "0 8 * * 1-5"),
  settleMarketsCron: optionalEnv("SETTLE_MARKETS_CRON", "5 16 * * 1-5"),
  // Admin settlement fallback: 15 min after close = exactly when ADMIN_OVERRIDE_DELAY expires
  adminSettleCron: optionalEnv("ADMIN_SETTLE_CRON", "15 16 * * 1-5"),
  pricePusherIntervalMin: parseInt(optionalEnv("PRICE_PUSHER_INTERVAL_MIN", "60"), 10),
  // Maximum age (seconds) for a price to be considered fresh enough to push.
  // Feeds with publishTime older than this threshold are skipped with a warning.
  // Default: 600s (10 minutes). During NYSE hours, Pyth publishes every few seconds,
  // so a price older than 10 minutes means the publisher has gone stale.
  pricePusherMaxAgeSecs: parseInt(optionalEnv("PRICE_PUSHER_MAX_AGE_SECONDS", "600"), 10),

  // MAG7 Pyth feed IDs (Base mainnet, expo -5)
  feeds: {
    AAPL: "0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
    MSFT: "0xd0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1",
    NVDA: "0x61c4ca5b9731a79e285a01e24432d57d89f0ecdd4cd7828196ca8992d5eafef6",
    GOOGL: "0xe65ff435be42630439c96396653a342829e877e2aafaeaf1a10d0ee5fd2cf3f2",
    AMZN: "0x82c59e36a8e0247e15283748d6cd51f5fa1019d73fbf3ab6d927e17d9e357a7f",
    META: "0x78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe",
    TSLA: "0x42676a595d0099c381687124805c8bb22c75424dffcaa55e3dc6549854ebe20a",
  } as Record<string, string>,

  // Ticker bytes32 values (right-padded, matching Solidity bytes32("AAPL"))
  tickers: ["AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA"] as const,

  // NYSE 2026 holidays (YYYY-MM-DD, ET timezone)
  // Used as fallback if date-holidays returns unexpected results
  nyseHolidays2026: [
    "2026-01-01", // New Year's Day
    "2026-01-19", // Martin Luther King Jr. Day
    "2026-02-16", // Presidents' Day
    "2026-04-03", // Good Friday
    "2026-05-25", // Memorial Day
    "2026-07-03", // Independence Day (observed, July 4 is Saturday)
    "2026-09-07", // Labor Day
    "2026-11-26", // Thanksgiving Day
    "2026-12-25", // Christmas Day
  ],

  // NYSE 2026 early-close days (1:00 PM ET)
  nyseEarlyClose2026: [
    "2026-07-02", // Day before observed Independence Day
    "2026-11-27", // Day after Thanksgiving
    "2026-12-24", // Christmas Eve
  ],
} as const;

export type Ticker = (typeof config.tickers)[number];
