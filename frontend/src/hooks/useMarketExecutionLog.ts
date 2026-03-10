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
      const fromBlock = lastCursor != null ? BigInt(lastCursor + 1) : DEPLOYMENT_BLOCK;

      if (fromBlock <= currentBlock) {
        const logs = await publicClient
          .getLogs({
            address: MARKET_ADDRESS,
            event: ORDER_FILLED_ABI,
            args: { marketId },
            fromBlock,
            toBlock: currentBlock,
          })
          .catch(() => []);

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
