'use client';

import { useEffect, useState } from 'react';
import { useAccount, useWriteContract, useConfig, useWatchContractEvent } from 'wagmi';
import { getPublicClient, readContract } from '@wagmi/core';
import { parseAbiItem } from 'viem';
import MeridianMarketABI from '@/lib/abi/MeridianMarket.json';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, X } from 'lucide-react';

const MARKET_ADDRESS = process.env.NEXT_PUBLIC_MERIDIAN_MARKET_ADDRESS as `0x${string}`;
const DEPLOYMENT_BLOCK = BigInt(process.env.NEXT_PUBLIC_DEPLOYMENT_BLOCK ?? '0');

const ORDER_PLACED_ABI = parseAbiItem(
  'event OrderPlaced(bytes32 indexed marketId, uint256 indexed orderId, address indexed owner, uint8 side, uint8 priceCents, uint128 quantity)'
);
const ORDER_CANCELLED_ABI = parseAbiItem(
  'event OrderCancelled(uint256 indexed orderId, address indexed owner, uint128 remainingQty)'
);
const ORDER_FILLED_ABI = parseAbiItem(
  'event OrderFilled(bytes32 indexed marketId, uint256 indexed orderId, address indexed maker, address taker, uint8 side, uint8 priceCents, uint128 qty)'
);

interface OpenOrder {
  orderId: bigint;
  side: number;
  priceCents: number;
  quantity: bigint; // remaining quantity
}

export function OpenOrders({ marketId }: { marketId: `0x${string}` }) {
  const { address, isConnected } = useAccount();
  const config = useConfig();
  const { writeContractAsync } = useWriteContract();
  const [orders, setOrders] = useState<OpenOrder[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [cancellingId, setCancellingId] = useState<bigint | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (!address || !isConnected || !marketId) return;

    const load = async () => {
      setIsLoading(true);
      try {
        const publicClient = getPublicClient(config);
        if (!publicClient) { setIsLoading(false); return; }

        const [placed, cancelled] = await Promise.all([
          publicClient.getLogs({
            address: MARKET_ADDRESS,
            event: ORDER_PLACED_ABI,
            // Filter by owner only. Some public RPCs can under-return when
            // multiple indexed args are combined in a single log query.
            // We then filter marketId client-side for correctness.
            args: { owner: address },
            fromBlock: DEPLOYMENT_BLOCK,
          }).catch(() => []),
          publicClient.getLogs({
            address: MARKET_ADDRESS,
            event: ORDER_CANCELLED_ABI,
            args: { owner: address },
            fromBlock: DEPLOYMENT_BLOCK,
          }).catch(() => []),
        ]);

        const cancelledIds = new Set(cancelled.map((l) => String(((l as any).args as any)?.orderId)));

        const expectedOwner = address.toLowerCase();
        const open = (
          await Promise.all(
            placed.map(async (log) => {
              const { orderId, side, priceCents, quantity } = log.args as any;
              const logMarketId = String(log.args?.marketId ?? '').toLowerCase();
              if (logMarketId !== marketId.toLowerCase()) return null;
              if (cancelledIds.has(String(orderId))) return null;

              const oid = BigInt(orderId);

              // Verify order is still live on-chain.
              const currentOwner = await readContract(config, {
                address: MARKET_ADDRESS,
                abi: MeridianMarketABI.abi as any,
                functionName: 'orderOwner',
                args: [oid],
              }).catch(() => null);

              // If owner lookup succeeds and is not the wallet, this order is not open for user.
              // If lookup fails (transient RPC issue), we still keep the event-derived candidate
              // and let subsequent polling/events reconcile.
              if (currentOwner && String(currentOwner).toLowerCase() !== expectedOwner) return null;

              // Derive remaining qty by subtracting fills for this order.
              const fills = await publicClient.getLogs({
                address: MARKET_ADDRESS,
                event: ORDER_FILLED_ABI,
                args: { orderId: oid },
                fromBlock: DEPLOYMENT_BLOCK,
              }).catch(() => []);
              const filledQty = fills.reduce(
                (sum, fillLog) => sum + BigInt((fillLog.args as any)?.qty ?? 0),
                0n
              );
              const placedQty = BigInt(quantity);
              const remainingQty = placedQty > filledQty ? placedQty - filledQty : 0n;
              if (remainingQty === 0n) return null;

              return {
                orderId: oid,
                side: Number(side),
                priceCents: Number(priceCents),
                quantity: remainingQty,
              } satisfies OpenOrder;
            })
          )
        ).filter(Boolean) as OpenOrder[];

        setOrders(open);
      } finally {
        setIsLoading(false);
      }
    };

    load();
  }, [address, isConnected, marketId, config, refreshTick]);

  // Fallback polling for environments where event subscriptions are delayed.
  useEffect(() => {
    if (!address || !isConnected || !marketId) return;
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      setRefreshTick((v) => v + 1);
    }, 30_000);
    return () => clearInterval(interval);
  }, [address, isConnected, marketId]);

  useWatchContractEvent({
    address: MARKET_ADDRESS,
    abi: MeridianMarketABI.abi,
    eventName: 'OrderPlaced',
    onLogs(logs) {
      const hasRelevant = logs.some((log: any) => {
        const logMarketId = String(log.args?.marketId ?? '').toLowerCase();
        const owner = String(log.args?.owner ?? '').toLowerCase();
        return logMarketId === marketId.toLowerCase() && owner === address?.toLowerCase();
      });
      if (hasRelevant) setRefreshTick((v) => v + 1);
    },
  });

  useWatchContractEvent({
    address: MARKET_ADDRESS,
    abi: MeridianMarketABI.abi,
    eventName: 'OrderCancelled',
    onLogs(logs) {
      const hasRelevant = logs.some(
        (log: any) => String(log.args?.owner ?? '').toLowerCase() === address?.toLowerCase()
      );
      if (hasRelevant) setRefreshTick((v) => v + 1);
    },
  });

  // If user's resting order is filled as maker, open orders list should update.
  useWatchContractEvent({
    address: MARKET_ADDRESS,
    abi: MeridianMarketABI.abi,
    eventName: 'OrderFilled',
    onLogs(logs) {
      const hasRelevant = logs.some((log: any) => {
        const logMarketId = String(log.args?.marketId ?? '').toLowerCase();
        const maker = String(log.args?.maker ?? '').toLowerCase();
        return logMarketId === marketId.toLowerCase() && maker === address?.toLowerCase();
      });
      if (hasRelevant) setRefreshTick((v) => v + 1);
    },
  });

  const handleCancel = async (orderId: bigint) => {
    setCancellingId(orderId);
    try {
      await writeContractAsync({
        address: MARKET_ADDRESS,
        abi: MeridianMarketABI.abi as any,
        functionName: 'cancelOrder',
        args: [orderId],
      });
      setOrders((prev) => prev.filter((o) => o.orderId !== orderId));
    } catch {
      // Ignore — order may have filled between fetch and cancel
    } finally {
      setCancellingId(null);
    }
  };

  if (!address) return null;

  return (
    <div className="bg-[#0f1217] border border-slate-800 rounded-2xl overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-800/50 flex items-center justify-between">
        <span className="text-[10px] uppercase font-black text-slate-500 tracking-widest">Your Open Orders</span>
        {isLoading && <Loader2 className="w-3 h-3 animate-spin text-slate-500" />}
      </div>
      {orders.length === 0 ? (
        <div className="px-5 py-6 text-center">
          <p className="text-[11px] text-slate-600 font-bold uppercase tracking-widest">No open orders</p>
        </div>
      ) : (
        <div className="divide-y divide-slate-800/40">
          {orders.map((order) => (
            <div key={String(order.orderId)} className="flex items-center justify-between px-5 py-3">
              <div className="flex items-center gap-3">
                <Badge
                  className={
                    order.side === 0
                      ? 'bg-blue-500/10 text-blue-400 border-blue-500/20 text-[9px] font-black uppercase'
                      : 'bg-slate-500/10 text-slate-400 border-slate-500/20 text-[9px] font-black uppercase'
                  }
                >
                  {order.side === 0 ? 'BID' : 'ASK'}
                </Badge>
                <span className="font-mono text-sm text-white font-bold">{order.priceCents}¢</span>
                <span className="text-[10px] text-slate-500 font-bold">×{order.quantity.toString()}</span>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => handleCancel(order.orderId)}
                disabled={cancellingId === order.orderId}
                className="h-7 w-7 p-0 text-slate-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg"
              >
                {cancellingId === order.orderId ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <X className="w-3 h-3" />
                )}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
