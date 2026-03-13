/**
 * Validates all required environment variables on startup and exports a single
 * typed config object. The process exits immediately if any required variable
 * is missing so the rest of the codebase can assume everything is present.
 */

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

function optionalFloat(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = parseFloat(raw);
  if (isNaN(parsed)) throw new Error(`${name} must be a number, got: ${raw}`);
  return parsed;
}

function optionalInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) throw new Error(`${name} must be an integer, got: ${raw}`);
  return parsed;
}

const required = ["RPC_URL", "MARKET_ADDRESS", "USDC_ADDRESS", "MAKER_PK", "BUYER_PK"];
const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
}

export const config = {
  // ── Chain ──────────────────────────────────────────────────────────────────
  rpcUrl: requireEnv("RPC_URL"),
  chainId: optionalInt("CHAIN_ID", 84532),

  // ── Contracts ──────────────────────────────────────────────────────────────
  marketAddress: requireEnv("MARKET_ADDRESS"),
  usdcAddress: requireEnv("USDC_ADDRESS"),

  // ── External services ─────────────────────────────────────────────────────
  hermesUrl: optionalEnv("HERMES_URL", "https://hermes.pyth.network"),

  // ── Wallets ────────────────────────────────────────────────────────────────
  makerPk: requireEnv("MAKER_PK"),
  buyerPk: requireEnv("BUYER_PK"),

  // ── Maker bot parameters ───────────────────────────────────────────────────
  // How many pairs (and YES/NO tokens each) to mint and quote per market per cycle.
  makerQuantity: BigInt(optionalInt("MAKER_QUANTITY", 10)),
  // Cents on each side of the fair value — total spread = 2 × halfSpread.
  makerHalfSpread: optionalInt("MAKER_HALF_SPREAD", 5),
  // Sigmoid sensitivity: higher = fair value moves more aggressively with price distance.
  makerSensitivity: optionalFloat("MAKER_SENSITIVITY", 3.0),
  // Assumed total NYSE session length in hours (used for time-weight calculation).
  makerHoursTotal: optionalFloat("MAKER_HOURS_TOTAL", 8.0),
  // Skip quoting if fair value is below this (market nearly-certainly loses for YES).
  makerMinFairValue: optionalInt("MAKER_MIN_FAIR_VALUE", 5),
  // Skip quoting if fair value is above this (market nearly-certainly wins for YES).
  makerMaxFairValue: optionalInt("MAKER_MAX_FAIR_VALUE", 95),
  // Cron expression for the maker bot (default: every 5 minutes).
  makerCron: optionalEnv("MAKER_CRON", "*/5 * * * *"),

  // ── Buyer bot parameters ───────────────────────────────────────────────────
  // Maximum pairs to buy per in-the-money market per cycle.
  buyerQuantity: BigInt(optionalInt("BUYER_QUANTITY", 15)),
  // Minimum USDC proceeds (6-decimal raw units) from the YES market-sell to accept.
  // 0 = accept any price; raise this to avoid buying into illiquid books.
  buyerMinYesProceeds: BigInt(optionalInt("BUYER_MIN_YES_PROCEEDS", 0)),
  // Maximum number of resting orders to cross against in a single buyNoMarket call.
  buyerMaxFills: optionalInt("BUYER_MAX_FILLS", 15),
  // Only act if the BID side has at least this many units of depth at the best bid.
  buyerMinBidDepth: BigInt(optionalInt("BUYER_MIN_BID_DEPTH", 2)),
  // Always leave at least this many units on the BID side after buying.
  buyerReserveDepth: BigInt(optionalInt("BUYER_RESERVE_DEPTH", 2)),
  // Cron expression for the buyer bot (default: every 15 minutes).
  buyerCron: optionalEnv("BUYER_CRON", "*/15 * * * *"),
  // Maximum time to wait for a tx receipt before treating it as failed.
  txWaitTimeoutMs: optionalInt("TX_WAIT_TIMEOUT_MS", 180_000),

  // ── Feed IDs (MAG7, Base mainnet/testnet) ─────────────────────────────────
  feeds: {
    AAPL:  "0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
    MSFT:  "0xd0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1",
    NVDA:  "0x61c4ca5b9731a79e285a01e24432d57d89f0ecdd4cd7828196ca8992d5eafef6",
    GOOGL: "0xe65ff435be42630439c96396653a342829e877e2aafaeaf1a10d0ee5fd2cf3f2",
    AMZN:  "0x82c59e36a8e0247e15283748d6cd51f5fa1019d73fbf3ab6d927e17d9e357a7f",
    META:  "0x78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe",
    TSLA:  "0x42676a595d0099c381687124805c8bb22c75424dffcaa55e3dc6549854ebe20a",
  } as Record<string, string>,

  tickers: ["AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA"] as const,
} as const;

export type Ticker = (typeof config.tickers)[number];
