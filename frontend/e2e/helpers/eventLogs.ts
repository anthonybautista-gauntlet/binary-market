import { encodeAbiParameters, encodeEventTopics, parseAbiItem, parseAbiParameters } from 'viem';

const MARKET_ADDRESS = '0x0793531B3CcE2B833298cFeCAEC63ad5c327302d';

const ORDER_FILLED_ABI = parseAbiItem(
  'event OrderFilled(bytes32 indexed marketId, uint256 indexed orderId, address indexed maker, address taker, uint8 side, uint8 priceCents, uint128 qty)',
);
const PAIR_MINTED_ABI = parseAbiItem(
  'event PairMinted(bytes32 indexed marketId, address indexed user, uint256 quantity)',
);
const REDEEMED_ABI = parseAbiItem(
  'event Redeemed(bytes32 indexed marketId, address indexed user, uint256 quantity, uint256 payout)',
);

function buildBaseLog(topics: `0x${string}`[], data: `0x${string}`, logIndex: number) {
  return {
    address: MARKET_ADDRESS,
    blockHash: `0x${'b'.repeat(64)}`,
    blockNumber: '0x1312d01',
    data,
    logIndex: `0x${logIndex.toString(16)}`,
    removed: false,
    topics,
    transactionHash: `0x${String(logIndex + 1).padStart(64, '0')}`,
    transactionIndex: '0x0',
  };
}

export function getEventTopic0(eventAbi: typeof ORDER_FILLED_ABI | typeof PAIR_MINTED_ABI | typeof REDEEMED_ABI) {
  return encodeEventTopics({ abi: [eventAbi], eventName: eventAbi.name as any })[0]!.toLowerCase();
}

export function buildOrderFilledLog(args: {
  marketId: `0x${string}`;
  orderId: bigint;
  maker: `0x${string}`;
  taker: `0x${string}`;
  side: number;
  priceCents: number;
  qty: bigint;
  logIndex?: number;
}) {
  const topics = encodeEventTopics({
    abi: [ORDER_FILLED_ABI],
    eventName: 'OrderFilled',
    args: {
      marketId: args.marketId,
      orderId: args.orderId,
      maker: args.maker,
    },
  }) as `0x${string}`[];

  const data = encodeAbiParameters(
    parseAbiParameters('address, uint8, uint8, uint128'),
    [args.taker, args.side, args.priceCents, args.qty],
  );

  return buildBaseLog(topics, data, args.logIndex ?? 0);
}

export function buildPairMintedLog(args: {
  marketId: `0x${string}`;
  user: `0x${string}`;
  quantity: bigint;
  logIndex?: number;
}) {
  const topics = encodeEventTopics({
    abi: [PAIR_MINTED_ABI],
    eventName: 'PairMinted',
    args: {
      marketId: args.marketId,
      user: args.user,
    },
  }) as `0x${string}`[];

  const data = encodeAbiParameters(
    parseAbiParameters('uint256'),
    [args.quantity],
  );

  return buildBaseLog(topics, data, args.logIndex ?? 0);
}

export function buildRedeemedLog(args: {
  marketId: `0x${string}`;
  user: `0x${string}`;
  quantity: bigint;
  payout: bigint;
  logIndex?: number;
}) {
  const topics = encodeEventTopics({
    abi: [REDEEMED_ABI],
    eventName: 'Redeemed',
    args: {
      marketId: args.marketId,
      user: args.user,
    },
  }) as `0x${string}`[];

  const data = encodeAbiParameters(
    parseAbiParameters('uint256, uint256'),
    [args.quantity, args.payout],
  );

  return buildBaseLog(topics, data, args.logIndex ?? 0);
}

export const EVENT_TOPIC0 = {
  orderFilled: getEventTopic0(ORDER_FILLED_ABI),
  pairMinted: getEventTopic0(PAIR_MINTED_ABI),
  redeemed: getEventTopic0(REDEEMED_ABI),
};
