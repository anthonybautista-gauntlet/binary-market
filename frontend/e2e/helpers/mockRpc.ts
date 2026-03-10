import { Page, Route } from '@playwright/test';
import {
  ENCODED_MARKET_COUNT,
  ENCODED_USDC_BALANCE,
  ENCODED_USDC_ALLOWANCE,
  ENCODED_YES_BALANCE,
  ENCODED_NO_BALANCE,
  ENCODED_FALSE,
  MOCK_MARKETS,
} from '../fixtures';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  parseAbiParameters,
  stringToHex,
} from 'viem';

/**
 * Known 4-byte function selectors (keccak256 of the canonical signature,
 * first 4 bytes). Verified with: cast sig "<signature>"
 */
const SELECTORS = {
  marketCount:        '0xec979082', // marketCount()
  getMarkets:         '0x333c8403', // getMarkets(uint256)
  markets:            '0x7564912b', // markets(bytes32)
  depthAt:            '0xba95b018', // depthAt(bytes32,uint8,uint8)
  balanceOf_erc20:    '0x70a08231', // balanceOf(address)
  allowance:          '0xdd62ed3e', // allowance(address,address)
  balanceOf_erc1155:  '0x00fdd58e', // balanceOf(address,uint256)
  isApprovedForAll:   '0xe985e9c5', // isApprovedForAll(address,address)
  totalSupply:        '0x18160ddd',
  decimals:           '0x313ce567',
  symbol:             '0x95d89b41',
  name:               '0x06fdde03',
  aggregate3:         '0x82ad56cb', // aggregate3((address,bool,bytes)[])
};

const MULTICALL3_ABI = [
  {
    type: 'function',
    name: 'aggregate3',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'allowFailure', type: 'bool' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      {
        name: 'returnData',
        type: 'tuple[]',
        components: [
          { name: 'success', type: 'bool' },
          { name: 'returnData', type: 'bytes' },
        ],
      },
    ],
  },
] as const;

/**
 * ABI-encoded string "USDC" padded to 32 bytes (dynamic string encoding).
 * offset=0x20, length=4, data="USDC" right-padded.
 */
const ENCODED_SYMBOL_USDC =
  '0x0000000000000000000000000000000000000000000000000000000000000020' +
  '0000000000000000000000000000000000000000000000000000000000000004' +
  '5553444300000000000000000000000000000000000000000000000000000000';

/** ABI-encoded uint8(6) — USDC decimals */
const ENCODED_DECIMALS_6 =
  '0x0000000000000000000000000000000000000000000000000000000000000006';

/** ABI-encoded uint256(0) */
const ENCODED_ZERO =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

type BalanceOptions = {
  /** Return this balance for ERC1155 YES token calls (default: 0) */
  yesBalance?: string;
  /** Return this balance for ERC1155 NO token calls (default: 0) */
  noBalance?: string;
  /** Return this balance for ERC20 USDC balanceOf (default: 500 USDC) */
  usdcBalance?: string;
  /** Return this allowance for ERC20 USDC allowance (default: 100 USDC) */
  usdcAllowance?: string;
  /** Return isApprovedForAll as true (default: false) */
  erc1155Approved?: boolean;
  /** Optional raw eth_getLogs responses keyed by topic0 */
  rpcLogResponses?: Record<string, any[]>;
};

/**
 * Intercept all JSON-RPC HTTP requests and return fixture responses.
 *
 * The interception is keyed on the 4-byte selector in the `data` field of
 * eth_call requests. Unrecognised selectors fall through to a default
 * zero response so the app doesn't hang.
 *
 * Uses route.fallback() (not route.continue()) for non-RPC requests so that
 * subsequently registered handlers (e.g. mockPythHermes) still fire.
 *
 * Call this before navigating to any page that reads contract state.
 */
export async function mockBlockchainRpc(page: Page, opts: BalanceOptions = {}) {
  const {
    yesBalance = ENCODED_YES_BALANCE,
    noBalance = ENCODED_NO_BALANCE,
    usdcBalance = ENCODED_USDC_BALANCE,
    usdcAllowance = ENCODED_USDC_ALLOWANCE,
    erc1155Approved = false,
    rpcLogResponses = {},
  } = opts;

  await page.route('**', async (route: Route) => {
    const request = route.request();

    // For GET requests: only fall through to mockPythHermes for Hermes URLs.
    // All other GET requests (Next.js static assets, WalletConnect, etc.) go
    // directly to the network to avoid hanging WebSocket or SSE connections.
    if (request.method() !== 'POST') {
      if (request.url().includes('hermes.pyth.network')) {
        await route.fallback();
      } else {
        await route.continue();
      }
      return;
    }

    let body: any;
    try {
      body = JSON.parse(request.postData() || '{}');
    } catch {
      await route.continue();
      return;
    }

    // Handle batch requests (array of calls)
    const calls = Array.isArray(body) ? body : [body];
    const isRpc = calls.some(c => c.jsonrpc === '2.0');
    if (!isRpc) {
      await route.continue();
      return;
    }

    const getNextErc1155Balance = () => yesBalance;

    const responses = calls.map(call => {
      const result = handleRpcCall(call, {
        yesBalance,
        noBalance,
        usdcBalance,
        usdcAllowance,
        erc1155Approved,
        rpcLogResponses,
        getNextErc1155Balance,
      });
      return { jsonrpc: '2.0', id: call.id, result };
    });

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(Array.isArray(body) ? responses : responses[0]),
    });
  });
}

function handleRpcCall(
  call: any,
  opts: Required<BalanceOptions> & { getNextErc1155Balance: () => string },
): string | object | null {
  const { method, params } = call;

  switch (method) {
    case 'eth_chainId':
      return '0x14a34'; // 84532 = Base Sepolia

    case 'net_version':
      return '84532';

    case 'eth_blockNumber':
      return '0x1312d00'; // block ~20M

    case 'eth_getBlockByNumber':
      return {
        number: '0x1312d00',
        hash: '0x' + 'a'.repeat(64),
        timestamp: '0x67a9c980',
        transactions: [],
        parentHash: '0x' + '0'.repeat(64),
        nonce: '0x0000000000000000',
        sha3Uncles: '0x' + '1'.repeat(64),
        logsBloom: '0x' + '0'.repeat(512),
        transactionsRoot: '0x' + '5'.repeat(64),
        stateRoot: '0x' + '6'.repeat(64),
        receiptsRoot: '0x' + '7'.repeat(64),
        miner: '0x' + '0'.repeat(40),
        difficulty: '0x0',
        totalDifficulty: '0x0',
        size: '0x1000',
        gasLimit: '0x3b9aca00',
        gasUsed: '0x0',
        extraData: '0x',
        mixHash: '0x' + '0'.repeat(64),
        baseFeePerGas: '0x5f5e100',
        uncles: [],
      };

    case 'eth_gasPrice':
      return '0x5f5e100'; // 100 Gwei

    case 'eth_estimateGas':
      return '0x30d40'; // 200k gas

    case 'eth_getTransactionCount':
      return '0x1';

    case 'eth_getTransactionByHash':
      return {
        hash: params?.[0] ?? '0x' + 'a'.repeat(64),
        nonce: '0x1',
        blockHash: '0x' + 'b'.repeat(64),
        blockNumber: '0x1312d01',
        transactionIndex: '0x0',
        from: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
        to: '0x0793531b3cce2b833298cfecaec63ad5c327302d',
        value: '0x0',
        gas: '0x30d40',
        gasPrice: '0x5f5e100',
        input: '0x',
      };

    case 'eth_getTransactionReceipt':
      return {
        transactionHash: params?.[0] ?? '0x' + 'a'.repeat(64),
        transactionIndex: '0x0',
        blockHash: '0x' + 'b'.repeat(64),
        blockNumber: '0x1312d01',
        from: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
        to: '0x0793531b3cce2b833298cfecaec63ad5c327302d',
        cumulativeGasUsed: '0x5208',
        gasUsed: '0x5208',
        contractAddress: null,
        logs: [],
        logsBloom: '0x' + '0'.repeat(512),
        status: '0x1',
        effectiveGasPrice: '0x5f5e100',
        type: '0x2',
      };

    case 'eth_getLogs':
      return opts.rpcLogResponses?.[String(params?.[0]?.topics?.[0] ?? '').toLowerCase()] ?? [];

    case 'eth_call': {
      const data: string = params?.[0]?.data ?? '';
      const selector = data.slice(0, 10).toLowerCase();

      if (selector === SELECTORS.aggregate3) {
        return handleAggregate3Call(data, opts);
      }

      switch (selector) {
        case SELECTORS.marketCount:
          return ENCODED_MARKET_COUNT;

        case SELECTORS.getMarkets:
          return encodeMarketsViewArray();

        case SELECTORS.markets:
          // Return a valid AAPL market with future expiry so the trade panel renders
          return encodeTestMarket();

        case SELECTORS.depthAt:
          return encodeDepthAt(data);

        case SELECTORS.balanceOf_erc20:
          return opts.usdcBalance;

        case SELECTORS.allowance:
          return opts.usdcAllowance;

        case SELECTORS.balanceOf_erc1155:
          return resolveErc1155Balance(data, opts);

        case SELECTORS.isApprovedForAll:
          return opts.erc1155Approved
            ? '0x0000000000000000000000000000000000000000000000000000000000000001'
            : ENCODED_FALSE;

        case SELECTORS.decimals:
          return ENCODED_DECIMALS_6;

        case SELECTORS.symbol:
          return ENCODED_SYMBOL_USDC;

        case SELECTORS.totalSupply:
          return ENCODED_ZERO;

        default:
          // Unknown call — return zero bytes32 (safe default)
          return ENCODED_ZERO;
      }
    }

    default:
      return null;
  }
}

/** ABI encoding for an empty dynamic array: offset=0x20, length=0 */
function encodeEmptyArray(): string {
  return (
    '0x' +
    '0000000000000000000000000000000000000000000000000000000000000020' +
    '0000000000000000000000000000000000000000000000000000000000000000'
  );
}

function encodeMarketsViewArray(): string {
  const encodedMarkets = MOCK_MARKETS.map((market) => ({
    marketId: market.marketId,
    ticker: stringToHex(market.ticker, { size: 32 }),
    strikePrice: market.strikePrice,
    expiryTimestamp: market.expiryTimestamp,
    settled: market.settled,
    yesWins: market.yesWins,
    vaultBalance: market.vaultBalance,
    feeBpsSnapshot: 50,
  }));

  return encodeAbiParameters(
    parseAbiParameters(
      '(bytes32 marketId, bytes32 ticker, int64 strikePrice, uint64 expiryTimestamp, bool settled, bool yesWins, uint256 vaultBalance, uint16 feeBpsSnapshot)[]',
    ),
    [encodedMarkets],
  );
}

function encodeDepthAt(data: string): string {
  const sideHex = data.slice(74, 138);
  const priceHex = data.slice(138, 202);
  const side = Number(BigInt(`0x${sideHex || '0'}`));
  const price = Number(BigInt(`0x${priceHex || '0'}`));

  let quantity = 0n;
  if (side === 0 && (price === 48 || price === 47)) quantity = price === 48 ? 7n : 4n;
  if (side === 1 && (price === 52 || price === 53)) quantity = price === 52 ? 5n : 3n;

  return `0x${quantity.toString(16).padStart(64, '0')}`;
}

function resolveErc1155Balance(
  data: string,
  opts: Required<BalanceOptions> & { getNextErc1155Balance: () => string },
): string {
  const tokenId = `0x${data.slice(74, 138)}`.toLowerCase();
  const yesTokenIds = new Set(MOCK_MARKETS.map((market) => market.marketId.toLowerCase()));
  return yesTokenIds.has(tokenId) ? opts.yesBalance : opts.noBalance;
}

function handleAggregate3Call(
  calldata: string,
  opts: Required<BalanceOptions> & { getNextErc1155Balance: () => string },
): string {
  try {
    const decoded = decodeFunctionData({
      abi: MULTICALL3_ABI,
      data: calldata as `0x${string}`,
    });

    const calls = (decoded.args?.[0] ?? []) as Array<{
      target: `0x${string}`;
      allowFailure: boolean;
      callData: `0x${string}`;
    }>;

    const results = calls.map((c) => {
      const selector = c.callData.slice(0, 10).toLowerCase();
      let returnData: `0x${string}` = ENCODED_ZERO as `0x${string}`;

      switch (selector) {
        case SELECTORS.marketCount:
          returnData = ENCODED_MARKET_COUNT as `0x${string}`;
          break;
        case SELECTORS.getMarkets:
          returnData = encodeMarketsViewArray() as `0x${string}`;
          break;
        case SELECTORS.markets:
          returnData = encodeTestMarket() as `0x${string}`;
          break;
        case SELECTORS.depthAt:
          returnData = encodeDepthAt(c.callData) as `0x${string}`;
          break;
        case SELECTORS.balanceOf_erc20:
          returnData = opts.usdcBalance as `0x${string}`;
          break;
        case SELECTORS.allowance:
          returnData = opts.usdcAllowance as `0x${string}`;
          break;
        case SELECTORS.balanceOf_erc1155:
          returnData = resolveErc1155Balance(c.callData, opts) as `0x${string}`;
          break;
        case SELECTORS.isApprovedForAll:
          returnData = (
            opts.erc1155Approved
              ? '0x0000000000000000000000000000000000000000000000000000000000000001'
              : ENCODED_FALSE
          ) as `0x${string}`;
          break;
        case SELECTORS.decimals:
          returnData = ENCODED_DECIMALS_6 as `0x${string}`;
          break;
        case SELECTORS.symbol:
          returnData = ENCODED_SYMBOL_USDC as `0x${string}`;
          break;
        case SELECTORS.totalSupply:
          returnData = ENCODED_ZERO as `0x${string}`;
          break;
        default:
          returnData = ENCODED_ZERO as `0x${string}`;
      }

      return {
        success: true,
        returnData,
      };
    });

    return encodeFunctionResult({
      abi: MULTICALL3_ABI,
      functionName: 'aggregate3',
      result: results,
    }) as `0x${string}`;
  } catch {
    // Safe fallback for a single dynamic tuple[] return value with zero entries.
    return encodeEmptyArray() as `0x${string}`;
  }
}

/**
 * ABI-encoded Market struct for a live AAPL market with a future expiry.
 *
 * Fields (all static — 9 × 32 bytes = 288 bytes total):
 *   bytes32 ticker           = "AAPL"  (left-aligned)
 *   int64   strikePrice      = 21000000  ($210.00 at 5 decimal places)
 *   bytes32 pythFeedId       = 0x0000... (placeholder — app uses PYTH_FEED_IDS[ticker])
 *   uint64  expiryTimestamp  = 1798761600  (2027-01-01, far future → LIVE)
 *   uint256 totalPairsMinted = 0
 *   uint256 vaultBalance     = 50000000  (50 USDC)
 *   uint16  feeBpsSnapshot   = 50
 *   bool    settled          = false
 *   bool    yesWins          = false
 */
function encodeTestMarket(): string {
  return (
    '0x' +
    // bytes32 ticker = "AAPL" (0x41 0x41 0x50 0x4c, left-aligned, zero-padded)
    '4141504c00000000000000000000000000000000000000000000000000000000' +
    // int64 strikePrice = 21000000 (positive, zero-padded to 32 bytes)
    '0000000000000000000000000000000000000000000000000000000001406f40' +
    // bytes32 pythFeedId = 0x0 (placeholder)
    '0000000000000000000000000000000000000000000000000000000000000000' +
    // uint64 expiryTimestamp = 1798761600 = 0x6b49d200 (year 2027)
    '000000000000000000000000000000000000000000000000000000006b49d200' +
    // uint256 totalPairsMinted = 0
    '0000000000000000000000000000000000000000000000000000000000000000' +
    // uint256 vaultBalance = 50000000 (50 USDC = 50e6)
    '0000000000000000000000000000000000000000000000000000000002faf080' +
    // uint16 feeBpsSnapshot = 50 = 0x32
    '0000000000000000000000000000000000000000000000000000000000000032' +
    // bool settled = false
    '0000000000000000000000000000000000000000000000000000000000000000' +
    // bool yesWins = false
    '0000000000000000000000000000000000000000000000000000000000000000'
  );
}
