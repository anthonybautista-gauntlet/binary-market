/**
 * Shared fixture data for all Playwright tests.
 *
 * Prices use Pyth's native representation: expo -5, so $195.00 = 19_500_000.
 * Strike prices follow the same convention.
 * Market IDs are deterministic hashes but are hard-coded here for stability.
 */

export const MOCK_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
export const MOCK_ADDRESS_SHORT = '0xf39F...2266';

/** Base Sepolia chain id as decimal string */
export const CHAIN_ID = '84532';

/** Pyth expo -5 prices for all 7 MAG7 tickers */
export const MOCK_PRICES: Record<string, { price: string; conf: string; expo: number; publish_time: number }> = {
  '49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688': {
    price: '21500000', conf: '80000', expo: -5, publish_time: 1741910400, // AAPL $215.00
  },
  'd0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1': {
    price: '39500000', conf: '120000', expo: -5, publish_time: 1741910400, // MSFT $395.00
  },
  '61c4ca5b9731a79e285a01e24432d57d89f0ecdd4cd7828196ca8992d5eafef6': {
    price: '87500000', conf: '200000', expo: -5, publish_time: 1741910400, // NVDA $875.00
  },
  'e65ff435be42630439c96396653a342829e877e2aafaeaf1a10d0ee5fd2cf3f2': {
    price: '17500000', conf: '60000', expo: -5, publish_time: 1741910400, // GOOGL $175.00
  },
  '82c59e36a8e0247e15283748d6cd51f5fa1019d73fbf3ab6d927e17d9e357a7f': {
    price: '20200000', conf: '75000', expo: -5, publish_time: 1741910400, // AMZN $202.00
  },
  '78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe': {
    price: '57000000', conf: '150000', expo: -5, publish_time: 1741910400, // META $570.00
  },
  '42676a595d0099c381687124805c8bb22c75424dffcaa55e3dc6549854ebe20a': {
    price: '28000000', conf: '90000', expo: -5, publish_time: 1741910400, // TSLA $280.00
  },
};

/** A future expiry timestamp (year 2027) so markets show as LIVE */
export const LIVE_EXPIRY = 1798761600n; // 2027-01-01 00:00:00 UTC

/** A past expiry timestamp so markets show as SETTLED */
export const SETTLED_EXPIRY = 1700000000n; // 2023-11-14

export const MOCK_MARKETS = [
  {
    marketId: '0xabc1230000000000000000000000000000000000000000000000000000000001' as `0x${string}`,
    ticker: 'AAPL',
    strikePrice: 21000000n,        // $210.00
    expiryTimestamp: LIVE_EXPIRY,
    settled: false,
    yesWins: false,
    vaultBalance: 50_000_000n,     // 50 USDC
  },
  {
    marketId: '0xabc1230000000000000000000000000000000000000000000000000000000002' as `0x${string}`,
    ticker: 'MSFT',
    strikePrice: 40000000n,        // $400.00
    expiryTimestamp: SETTLED_EXPIRY,
    settled: true,
    yesWins: false,
    vaultBalance: 0n,
  },
];

/** ABI-encoded `uint256(2)` — used as `marketCount()` return value */
export const ENCODED_MARKET_COUNT =
  '0x0000000000000000000000000000000000000000000000000000000000000002';

/** ABI-encoded `uint256(500_000_000)` — 500 USDC (6 decimals) */
export const ENCODED_USDC_BALANCE =
  '0x000000000000000000000000000000000000000000000000000000001dcd6500';

/** ABI-encoded `uint256(100_000_000)` — 100 USDC allowance */
export const ENCODED_USDC_ALLOWANCE =
  '0x0000000000000000000000000000000000000000000000000000000005f5e100';

/** ABI-encoded `uint256(3)` — 3 YES tokens */
export const ENCODED_YES_BALANCE =
  '0x0000000000000000000000000000000000000000000000000000000000000003';

/** ABI-encoded `uint256(0)` — zero / false / empty */
export const ENCODED_ZERO =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

/** ABI-encoded `uint256(0)` — 0 NO tokens */
export const ENCODED_NO_BALANCE = ENCODED_ZERO;

/** ABI-encoded `bool(false)` */
export const ENCODED_FALSE = ENCODED_ZERO;

/**
 * Minimal Pyth Hermes v2 response for /v2/updates/price/latest.
 * The `binary.data` value is ignored — only `parsed` is consumed by the frontend.
 */
export function buildHermesResponse(feedIds: string[]) {
  return {
    parsed: feedIds.map(id => ({
      id,
      price: MOCK_PRICES[id] ?? { price: '10000000', conf: '50000', expo: -5, publish_time: 1741910400 },
      ema_price: MOCK_PRICES[id] ?? { price: '10000000', conf: '50000', expo: -5, publish_time: 1741910400 },
      metadata: { slot: 123456, proof_available_time: 1741910400, prev_publish_time: 1741910399 },
    })),
    binary: {
      encoding: 'hex',
      data: feedIds.map(() => '0x0000'),
    },
  };
}
