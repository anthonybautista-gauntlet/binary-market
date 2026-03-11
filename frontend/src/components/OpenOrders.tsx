'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { getPublicClient, readContract } from '@wagmi/core';
import { useAccount, useConfig, useWriteContract } from 'wagmi';
import MeridianMarketABI from '@/lib/abi/MeridianMarket.json';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, X } from 'lucide-react';
import { useTradeHistory } from '@/hooks/useTradeHistory';

const MARKET_ADDRESS = process.env.NEXT_PUBLIC_MERIDIAN_MARKET_ADDRESS as `0x${string}`;

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
  const {
    data: tradeEvents = [],
    isLoading: isLoadingHistory,
    refetch: refetchHistory,
  } = useTradeHistory();
  const [cancellingId, setCancellingId] = useState<bigint | null>(null);
  const [optimisticallyHiddenOrderIds, setOptimisticallyHiddenOrderIds] = useState<Set<string>>(
    new Set()
  );
  const [inactiveOrderIds, setInactiveOrderIds] = useState<Set<string>>(new Set());

  const baseOrders = useMemo(() => {
    if (!address) return [];
    const wallet = address.toLowerCase();
    const targetMarket = marketId.toLowerCase();

    const ordered = [...tradeEvents].sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
      return a.logIndex - b.logIndex;
    });

    const openByOrderId = new Map<string, OpenOrder>();
    for (const ev of ordered) {
      const evMarket = String(ev.marketId ?? '').toLowerCase();
      const oid = String(ev.orderId ?? '').toLowerCase();
      if (!oid) continue;

      if (ev.eventType === 'OrderPlaced') {
        if (evMarket !== targetMarket) continue;
        if (ev.wallet?.toLowerCase() !== wallet) continue;
        openByOrderId.set(oid, {
          orderId: BigInt(oid),
          side: Number(ev.placedSide ?? 0),
          priceCents: Number(ev.placedPriceCents ?? 0),
          quantity: BigInt(ev.placedQty ?? 0),
        });
        continue;
      }

      // Cancel events are market-scoped and authoritative for open-order removal.
      if (ev.eventType === 'OrderCancelled') {
        if (evMarket !== targetMarket) continue;
        openByOrderId.delete(oid);
        continue;
      }

      if (ev.eventType === 'OrderFilled') {
        if (evMarket !== targetMarket) continue;
        if (ev.maker?.toLowerCase() !== wallet) continue;
        const curr = openByOrderId.get(oid);
        if (!curr) continue;
        const fillQty = BigInt(ev.qty ?? 0);
        const nextQty = curr.quantity > fillQty ? curr.quantity - fillQty : 0n;
        if (nextQty === 0n) openByOrderId.delete(oid);
        else openByOrderId.set(oid, { ...curr, quantity: nextQty });
      }
    }

    return [...openByOrderId.values()].filter((o) => o.quantity > 0n);
  }, [address, marketId, tradeEvents]);

  const baseOrderIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    baseOrderIdsRef.current = new Set(baseOrders.map((o) => String(o.orderId).toLowerCase()));
  }, [baseOrders]);

  const orders = useMemo(
    () =>
      baseOrders.filter(
        (o) =>
          !optimisticallyHiddenOrderIds.has(String(o.orderId).toLowerCase()) &&
          !inactiveOrderIds.has(String(o.orderId).toLowerCase())
      ),
    [baseOrders, optimisticallyHiddenOrderIds, inactiveOrderIds]
  );

  // Passive self-heal for stale rows: periodically verify displayed orders are
  // still active in contract metadata and hide definitely inactive ones.
  useEffect(() => {
    if (!address || orders.length === 0) return;
    let cancelled = false;

    const verify = async () => {
      const inactive: string[] = [];
      await Promise.all(
        orders.map(async (order) => {
          const owner = await readContract(config, {
            address: MARKET_ADDRESS,
            abi: MeridianMarketABI.abi as any,
            functionName: 'orderOwner',
            args: [order.orderId],
          }).catch(() => null);
          const ownerLower = String(owner ?? '').toLowerCase();
          if (ownerLower === '0x0000000000000000000000000000000000000000') {
            inactive.push(String(order.orderId).toLowerCase());
          }
        })
      );

      if (cancelled || inactive.length === 0) return;
      setInactiveOrderIds((prev) => {
        const next = new Set(prev);
        for (const id of inactive) next.add(id);
        return next;
      });
      // Pull latest events so history/open-order derivation catches up.
      await refetchHistory();
    };

    verify();
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      verify();
    }, 15_000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [address, config, orders, refetchHistory]);

  const handleCancel = async (orderId: bigint) => {
    setCancellingId(orderId);
    const oid = String(orderId).toLowerCase();
    try {
      // Optimistic UX: hide immediately after user confirms cancel.
      setOptimisticallyHiddenOrderIds((prev) => {
        const next = new Set(prev);
        next.add(oid);
        return next;
      });

      const txHash = await writeContractAsync({
        address: MARKET_ADDRESS,
        abi: MeridianMarketABI.abi as any,
        functionName: 'cancelOrder',
        args: [orderId],
      });
      // Ensure we refetch after the cancellation is actually mined.
      const publicClient = getPublicClient(config);
      if (publicClient && txHash) {
        await publicClient.waitForTransactionReceipt({ hash: txHash });
      }
      // Force an immediate history refetch so OpenOrders reconciles right away.
      await refetchHistory();
      // Re-check shortly after to avoid stale-hide if cancel did not actually
      // close the order on current market view (Option 2 behavior).
      setTimeout(async () => {
        await refetchHistory();
        const stillLive = baseOrderIdsRef.current.has(oid);
        setOptimisticallyHiddenOrderIds((prev) => {
          const next = new Set(prev);
          // Always release temporary hide after reconciliation.
          // If stillLive, order reappears; if not, it remains absent naturally.
          next.delete(oid);
          return next;
        });
        // keep variable read for clarity in debugging paths
        void stillLive;
      }, 2500);
    } catch {
      // Ignore — order may have filled between fetch and cancel
      // Revert optimistic hide on error.
      setOptimisticallyHiddenOrderIds((prev) => {
        const next = new Set(prev);
        next.delete(oid);
        return next;
      });
    } finally {
      setCancellingId(null);
    }
  };

  if (!address) return null;

  return (
    <div className="bg-[#0f1217] border border-slate-800 rounded-2xl overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-800/50 flex items-center justify-between">
        <span className="text-[10px] uppercase font-black text-slate-500 tracking-widest">Your Open Orders</span>
        {isLoadingHistory && <Loader2 className="w-3 h-3 animate-spin text-slate-500" />}
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
