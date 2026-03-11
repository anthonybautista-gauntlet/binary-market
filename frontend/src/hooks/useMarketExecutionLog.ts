'use client';

import { useQuery } from '@tanstack/react-query';
import { useAccount, useConfig } from 'wagmi';
import { getPublicClient, getBlockNumber } from '@wagmi/core';
import { parseAbiItem } from 'viem';
import {
  MarketExecutionEvent,
  getMarketExecutionCursor,
  getMarketExecutionEvents,
  saveMarketExecutionEvents,
  setMarketExecutionCursor,
} from '@/lib/tradeCache';

const MARKET_ADDRESS = process.env.NEXT_PUBLIC_MERIDIAN_MARKET_ADDRESS as `0x${string}`;
const DEPLOYMENT_BLOCK = BigInt(process.env.NEXT_PUBLIC_DEPLOYMENT_BLOCK ?? '0');
const MARKET_ACTIVITY_BACKFILL_BLOCKS = 120n;
const LOG_CHUNK_BLOCKS = 2_000n;
const MIN_LOG_CHUNK_BLOCKS = 100n;

const ORDER_FILLED_ABI = parseAbiItem(
  'event OrderFilled(bytes32 indexed marketId, uint256 indexed orderId, address indexed maker, address taker, uint8 side, uint8 priceCents, uint128 qty)'
);

export type MarketExecutionMode = 'all' | 'myWallet';

function sortEvents(events: MarketExecutionEvent[]): MarketExecutionEvent[] {
  return [...events].sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return b.blockNumber - a.blockNumber;
    return b.logIndex - a.logIndex;
  });
}

function computeFromBlock(lastCursor: number | null): bigint {
  if (lastCursor == null) return DEPLOYMENT_BLOCK;
  const cursor = BigInt(lastCursor);
  const rewinded = cursor >= MARKET_ACTIVITY_BACKFILL_BLOCKS
    ? cursor - MARKET_ACTIVITY_BACKFILL_BLOCKS + 1n
    : 0n;
  return rewinded > DEPLOYMENT_BLOCK ? rewinded : DEPLOYMENT_BLOCK;
}

async function getLogsChunked(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publicClient: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  baseParams: any,
  fromBlock: bigint,
  toBlock: bigint
) {
  if (fromBlock > toBlock) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allLogs: any[] = [];
  let cursor = fromBlock;
  let chunkSize = LOG_CHUNK_BLOCKS;

  while (cursor <= toBlock) {
    const end =
      cursor + chunkSize - 1n <= toBlock
        ? cursor + chunkSize - 1n
        : toBlock;
    try {
      // eslint-disable-next-line no-await-in-loop
      const logs = await publicClient.getLogs({
        ...baseParams,
        fromBlock: cursor,
        toBlock: end,
      });
      allLogs.push(...logs);
      cursor = end + 1n;
      if (chunkSize < LOG_CHUNK_BLOCKS) {
        chunkSize = chunkSize * 2n <= LOG_CHUNK_BLOCKS ? chunkSize * 2n : LOG_CHUNK_BLOCKS;
      }
    } catch (err) {
      if (chunkSize <= MIN_LOG_CHUNK_BLOCKS) throw err;
      chunkSize = chunkSize / 2n;
    }
  }

  return allLogs;
}

export function useMarketExecutionLog(
  marketId?: `0x${string}`,
  mode: MarketExecutionMode = 'all'
) {
  const { address } = useAccount();
  const config = useConfig();
  const chainId = config.state.chainId;

  return useQuery({
    queryKey: ['market-execution-log', chainId, marketId, mode, address],
    enabled: !!marketId && typeof window !== 'undefined',
    staleTime: 15_000,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    queryFn: async (): Promise<MarketExecutionEvent[]> => {
      if (!marketId) return [];

      const publicClient = getPublicClient(config);
      const normalizedMarketId = marketId.toLowerCase();
      const wallet = address?.toLowerCase();

      // No client available: return only cached results.
      if (!publicClient) {
        const cached = await getMarketExecutionEvents(chainId, normalizedMarketId);
        if (mode !== 'myWallet' || !wallet) return cached;
        return cached.filter(
          (e) => e.maker.toLowerCase() === wallet || e.taker.toLowerCase() === wallet
        );
      }

      const currentBlock = await getBlockNumber(config);
      const lastCursor = await getMarketExecutionCursor(chainId, normalizedMarketId);
      const fromBlock = computeFromBlock(lastCursor);

      if (fromBlock <= currentBlock) {
        const logs = await getLogsChunked(
          publicClient,
          {
            address: MARKET_ADDRESS,
            event: ORDER_FILLED_ABI,
            args: { marketId },
          },
          fromBlock,
          currentBlock
        );

        if (logs.length > 0) {
          const uniqueBlockNumbers = Array.from(
            new Set(logs.map((log) => Number(log.blockNumber ?? 0n)))
          );
          const blockMap = new Map<number, number>();
          await Promise.all(
            uniqueBlockNumbers.map(async (bn) => {
              if (!bn) return;
              try {
                const block = await publicClient.getBlock({ blockNumber: BigInt(bn) });
                blockMap.set(bn, Number(block.timestamp));
              } catch {
                // Leave timestamp undefined if block lookup fails.
              }
            })
          );

          const newEvents: MarketExecutionEvent[] = logs
            .filter((log) => !!log.args)
            .map((log) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const { maker, taker, side, priceCents, qty, marketId: logMarketId } = log.args as any;
              const blockNumber = Number(log.blockNumber ?? 0n);
              const marketHex = String(logMarketId).toLowerCase();
              return {
                id: `${log.transactionHash}-${log.logIndex}`,
                chainId,
                marketId: marketHex,
                blockNumber,
                txHash: log.transactionHash ?? '',
                logIndex: log.logIndex ?? 0,
                timestamp: blockMap.get(blockNumber),
                maker: String(maker ?? '').toLowerCase(),
                taker: String(taker ?? '').toLowerCase(),
                side: Number(side ?? 0),
                priceCents: Number(priceCents ?? 0),
                qty: BigInt(qty ?? 0),
              };
            });

          await saveMarketExecutionEvents(newEvents);
        }

        await setMarketExecutionCursor(chainId, normalizedMarketId, Number(currentBlock));
      }

      const allEvents = sortEvents(
        await getMarketExecutionEvents(chainId, normalizedMarketId)
      );

      if (mode === 'myWallet' && wallet) {
        return allEvents.filter(
          (e) => e.maker.toLowerCase() === wallet || e.taker.toLowerCase() === wallet
        );
      }

      return mode === 'myWallet' ? [] : allEvents;
    },
  });
}
