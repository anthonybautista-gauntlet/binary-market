'use client';

import { useQuery } from '@tanstack/react-query';
import { useAccount, useConfig } from 'wagmi';
import { getPublicClient, getBlockNumber } from '@wagmi/core';
import { parseAbiItem } from 'viem';
import {
  TradeEvent,
  getCursor,
  setCursor,
  saveEvents,
  getEventsForWallet,
} from '@/lib/tradeCache';

const MARKET_ADDRESS = process.env.NEXT_PUBLIC_MERIDIAN_MARKET_ADDRESS as `0x${string}`;

// Block at which the contract was deployed — used as the starting point on first load.
// Update this to the actual deployment block to avoid scanning from genesis.
const DEPLOYMENT_BLOCK = BigInt(
  process.env.NEXT_PUBLIC_DEPLOYMENT_BLOCK ?? '0'
);

const ORDER_FILLED_ABI = parseAbiItem(
  'event OrderFilled(bytes32 indexed marketId, uint256 indexed orderId, address indexed maker, address taker, uint8 side, uint8 priceCents, uint128 qty)'
);
const PAIR_MINTED_ABI = parseAbiItem(
  'event PairMinted(bytes32 indexed marketId, address indexed user, uint256 quantity)'
);
const REDEEMED_ABI = parseAbiItem(
  'event Redeemed(bytes32 indexed marketId, address indexed user, uint256 quantity, uint256 payout)'
);

function toHex(v: string | bigint): string {
  return typeof v === 'bigint' ? `0x${v.toString(16)}` : v;
}

export function useTradeHistory() {
  const { address, isConnected } = useAccount();
  const config = useConfig();
  const chainId = config.state.chainId;

  return useQuery({
    queryKey: ['trade-history', address, chainId],
    enabled: isConnected && !!address && typeof window !== 'undefined',
    staleTime: 30_000,
    queryFn: async (): Promise<TradeEvent[]> => {
      if (!address) return [];

      const wallet = address.toLowerCase();
      const publicClient = getPublicClient(config);
      if (!publicClient) return getEventsForWallet(wallet, chainId);

      const currentBlock = await getBlockNumber(config);
      const cachedLastBlock = await getCursor(wallet, chainId);
      const fromBlock = cachedLastBlock != null
        ? BigInt(cachedLastBlock + 1)
        : DEPLOYMENT_BLOCK;

      if (fromBlock > currentBlock) {
        return getEventsForWallet(wallet, chainId);
      }

      const newEvents: TradeEvent[] = [];

      // ── OrderFilled (maker OR taker is the wallet) ──
      const [filledAsMaker, filledAsTaker] = await Promise.all([
        publicClient.getLogs({
          address: MARKET_ADDRESS,
          event: ORDER_FILLED_ABI,
          args: { maker: address },
          fromBlock,
          toBlock: currentBlock,
        }).catch(() => []),
        publicClient.getLogs({
          address: MARKET_ADDRESS,
          event: ORDER_FILLED_ABI,
          fromBlock,
          toBlock: currentBlock,
        }).catch(() => []),
      ]);

      const seenFillIds = new Set<string>();
      const allFills = [...filledAsMaker, ...filledAsTaker];
      for (const log of allFills) {
        if (!log.args) continue;
        const { marketId, orderId, maker, taker, side, priceCents, qty } = log.args as any;
        const walletLower = wallet;
        if (
          maker?.toLowerCase() !== walletLower &&
          taker?.toLowerCase() !== walletLower
        ) continue;

        const id = `${log.transactionHash}-${log.logIndex}`;
        if (seenFillIds.has(id)) continue;
        seenFillIds.add(id);

        newEvents.push({
          id,
          wallet: walletLower,
          chainId,
          blockNumber: Number(log.blockNumber ?? 0n),
          txHash: log.transactionHash ?? '',
          logIndex: log.logIndex ?? 0,
          eventType: 'OrderFilled',
          marketId: toHex(marketId),
          orderId: toHex(orderId),
          maker: maker?.toLowerCase(),
          taker: taker?.toLowerCase(),
          side: Number(side ?? 0),
          priceCents: Number(priceCents ?? 0),
          qty: BigInt(qty ?? 0),
        });
      }

      // ── PairMinted ──
      const mintedLogs = await publicClient.getLogs({
        address: MARKET_ADDRESS,
        event: PAIR_MINTED_ABI,
        args: { user: address },
        fromBlock,
        toBlock: currentBlock,
      }).catch(() => []);

      for (const log of mintedLogs) {
        if (!log.args) continue;
        const { marketId, quantity } = log.args as any;
        newEvents.push({
          id: `${log.transactionHash}-${log.logIndex}`,
          wallet,
          chainId,
          blockNumber: Number(log.blockNumber ?? 0n),
          txHash: log.transactionHash ?? '',
          logIndex: log.logIndex ?? 0,
          eventType: 'PairMinted',
          marketId: toHex(marketId),
          mintQty: BigInt(quantity ?? 0),
        });
      }

      // ── Redeemed ──
      const redeemedLogs = await publicClient.getLogs({
        address: MARKET_ADDRESS,
        event: REDEEMED_ABI,
        args: { user: address },
        fromBlock,
        toBlock: currentBlock,
      }).catch(() => []);

      for (const log of redeemedLogs) {
        if (!log.args) continue;
        const { marketId, quantity, payout } = log.args as any;
        newEvents.push({
          id: `${log.transactionHash}-${log.logIndex}`,
          wallet,
          chainId,
          blockNumber: Number(log.blockNumber ?? 0n),
          txHash: log.transactionHash ?? '',
          logIndex: log.logIndex ?? 0,
          eventType: 'Redeemed',
          marketId: toHex(marketId),
          redeemQty: BigInt(quantity ?? 0),
          payout: BigInt(payout ?? 0),
        });
      }

      // Persist new events and update cursor
      await saveEvents(newEvents);
      await setCursor(wallet, chainId, Number(currentBlock));

      // Return merged full history from IndexedDB
      return getEventsForWallet(wallet, chainId);
    },
  });
}

// Derive per-market PnL from trade history
export interface MarketPnL {
  marketId: string;
  avgEntryPriceCents: number | null; // weighted average fill price in cents
  totalCostUsdc: number; // USDC spent acquiring tokens (fills + mints)
  realizedPnlUsdc: number | null; // from Redeemed events, null if not settled/redeemed
  fillCount: number;
}

export function computeMarketPnL(events: TradeEvent[], wallet: string): Map<string, MarketPnL> {
  const result = new Map<string, MarketPnL>();

  const ensure = (marketId: string) => {
    if (!result.has(marketId)) {
      result.set(marketId, {
        marketId,
        avgEntryPriceCents: null,
        totalCostUsdc: 0,
        realizedPnlUsdc: null,
        fillCount: 0,
      });
    }
    return result.get(marketId)!;
  };

  const walletLower = wallet.toLowerCase();

  for (const ev of events) {
    const entry = ensure(ev.marketId);

    if (ev.eventType === 'OrderFilled' && ev.priceCents != null && ev.qty != null) {
      const qty = Number(ev.qty);
      const price = ev.priceCents;
      const costUsdc = (qty * price * 10000) / 1e6;

      if (ev.taker?.toLowerCase() === walletLower) {
        // Wallet was the BID taker — bought YES tokens
        if (ev.side === 0) {
          entry.totalCostUsdc += costUsdc;
          entry.fillCount++;
          // Update weighted avg
          const prevTotal = (entry.avgEntryPriceCents ?? 0) * (entry.fillCount - 1);
          entry.avgEntryPriceCents = (prevTotal + price) / entry.fillCount;
        }
      }
      if (ev.maker?.toLowerCase() === walletLower) {
        // Wallet was ASK maker — sold YES tokens, received USDC
        entry.totalCostUsdc -= costUsdc;
        entry.fillCount++;
      }
    }

    if (ev.eventType === 'PairMinted' && ev.mintQty != null) {
      // Minting costs $1 per pair
      entry.totalCostUsdc += Number(ev.mintQty);
    }

    if (ev.eventType === 'Redeemed' && ev.payout != null) {
      const payoutUsdc = Number(ev.payout) / 1e6;
      entry.realizedPnlUsdc = (entry.realizedPnlUsdc ?? 0) + payoutUsdc - entry.totalCostUsdc;
    }
  }

  return result;
}
