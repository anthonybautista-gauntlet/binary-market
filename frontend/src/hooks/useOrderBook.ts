'use client';

import { useCallback, useEffect } from 'react';
import { useConfig, useWatchContractEvent } from 'wagmi';
import { readContract } from '@wagmi/core';
import MeridianMarketABI from '@/lib/abi/MeridianMarket.json';
import { useOrderBookStore } from '@/store/useOrderBookStore';
import { useShallow } from 'zustand/react/shallow';

const MARKET_ADDRESS = process.env.NEXT_PUBLIC_MERIDIAN_MARKET_ADDRESS as `0x${string}`;

export function useOrderBook(marketId: `0x${string}`) {
  const config = useConfig();
  
  // Use specific selectors for actions to prevent unnecessary re-renders
  const setBids = useOrderBookStore((state) => state.setBids);
  const setAsks = useOrderBookStore((state) => state.setAsks);
  const updateLevel = useOrderBookStore((state) => state.updateLevel);

  const fetchOrderBook = useCallback(async () => {
    const bidPromises = [];
    const askPromises = [];
    
    // Fetch all 1-99 cent levels
    for (let price = 1; price < 100; price++) {
      bidPromises.push(
        readContract(config, {
          address: MARKET_ADDRESS,
          abi: MeridianMarketABI.abi,
          functionName: 'depthAt',
          args: [marketId, 0, price], // 0 = BID
        })
      );
      askPromises.push(
        readContract(config, {
          address: MARKET_ADDRESS,
          abi: MeridianMarketABI.abi,
          functionName: 'depthAt',
          args: [marketId, 1, price], // 1 = ASK
        })
      );
    }

    const bidDepths = await Promise.all(bidPromises);
    const askDepths = await Promise.all(askPromises);

    const bids = bidDepths
      .map((depth, i) => ({ price: i + 1, quantity: depth as bigint }))
      .filter((l) => l.quantity > 0n)
      .sort((a, b) => b.price - a.price); // Highest bid first
    
    const asks = askDepths
      .map((depth, i) => ({ price: i + 1, quantity: depth as bigint }))
      .filter((l) => l.quantity > 0n)
      .sort((a, b) => a.price - b.price); // Lowest ask first

    setBids(bids);
    setAsks(asks);
  }, [config, marketId, setAsks, setBids]);

  useEffect(() => {
    if (marketId) {
      fetchOrderBook().catch(() => {
        // Best-effort refresh; keep existing book if fetch fails.
      });
    }
  }, [marketId, fetchOrderBook]);

  // Fallback polling: event streams can occasionally lag/drop on public RPCs.
  // Keep this interval conservative to avoid excessive read load.
  useEffect(() => {
    if (!marketId) return;
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      fetchOrderBook().catch(() => {
        // Best-effort only.
      });
    }, 30_000);
    return () => clearInterval(interval);
  }, [marketId, fetchOrderBook]);

  // Watch for events
  useWatchContractEvent({
    address: MARKET_ADDRESS,
    abi: MeridianMarketABI.abi,
    eventName: 'OrderPlaced',
    onLogs(logs) {
      logs.forEach((log: any) => {
        const { marketId: logMarketId, side, priceCents } = log.args;
        if (logMarketId.toLowerCase() === marketId.toLowerCase()) {
          readContract(config, {
            address: MARKET_ADDRESS,
            abi: MeridianMarketABI.abi,
            functionName: 'depthAt',
            args: [marketId, side, priceCents],
          }).then((depth) => {
            updateLevel(side === 0 ? 'bid' : 'ask', Number(priceCents), depth as bigint);
          });
        }
      });
    },
  });

  // Fills can change both sides of the book (crossing + resting updates).
  useWatchContractEvent({
    address: MARKET_ADDRESS,
    abi: MeridianMarketABI.abi,
    eventName: 'OrderFilled',
    onLogs(logs) {
      const hasRelevantFill = logs.some((log: any) => {
        const logMarketId = String(log.args?.marketId ?? '').toLowerCase();
        return logMarketId === marketId.toLowerCase();
      });
      if (hasRelevantFill) {
        fetchOrderBook().catch(() => {
          // Ignore transient read errors; next event/poll will recover.
        });
      }
    },
  });

  // Order cancellations also change depth.
  useWatchContractEvent({
    address: MARKET_ADDRESS,
    abi: MeridianMarketABI.abi,
    eventName: 'OrderCancelled',
    onLogs(logs) {
      const hasRelevantCancel = logs.some((log: any) => {
        const logMarketId = String(log.args?.marketId ?? '').toLowerCase();
        return logMarketId === marketId.toLowerCase();
      });
      if (hasRelevantCancel) {
        fetchOrderBook().catch(() => {
          // Ignore transient read errors; next event/poll will recover.
        });
      }
    },
  });

  // Use useShallow to prevent infinite loop when returning a new object literal
  return useOrderBookStore(
    useShallow((state) => ({ bids: state.bids, asks: state.asks }))
  );
}
