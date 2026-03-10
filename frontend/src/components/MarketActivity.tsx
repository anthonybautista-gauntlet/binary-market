'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useAccount, useConfig, useWatchContractEvent } from 'wagmi';
import { Loader2, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useMarketExecutionLog, MarketExecutionMode } from '@/hooks/useMarketExecutionLog';
import MeridianMarketABI from '@/lib/abi/MeridianMarket.json';

const MARKET_ADDRESS = process.env.NEXT_PUBLIC_MERIDIAN_MARKET_ADDRESS as `0x${string}`;

function shortAddress(addr: string): string {
  if (!addr) return '—';
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function formatTime(timestamp?: number): string {
  if (!timestamp) return 'Pending';
  return new Date(timestamp * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function sideLabel(side: number): string {
  return side === 0 ? 'Buy YES' : 'Sell YES';
}

function sideClass(side: number): string {
  return side === 0
    ? 'bg-blue-500/10 text-blue-400 border-blue-500/20'
    : 'bg-slate-500/10 text-slate-300 border-slate-500/20';
}

function txExplorerUrl(chainId: number, txHash: string): string {
  return chainId === 8453
    ? `https://basescan.org/tx/${txHash}`
    : `https://sepolia.basescan.org/tx/${txHash}`;
}

interface MarketActivityProps {
  marketId: `0x${string}`;
  showHistoryLink?: boolean;
  initialMode?: MarketExecutionMode;
}

export function MarketActivity({
  marketId,
  showHistoryLink = true,
  initialMode = 'all',
}: MarketActivityProps) {
  const { address } = useAccount();
  const config = useConfig();
  const chainId = config.state.chainId;

  const [mode, setMode] = useState<MarketExecutionMode>(initialMode);
  const [visibleCount, setVisibleCount] = useState(20);
  const { data: events = [], isLoading, refetch } = useMarketExecutionLog(marketId, mode);

  useWatchContractEvent({
    address: MARKET_ADDRESS,
    abi: MeridianMarketABI.abi as any,
    eventName: 'OrderFilled',
    onLogs(logs) {
      const hasRelevantFill = logs.some((log: any) => {
        const logMarketId = String(log.args?.marketId ?? '').toLowerCase();
        return logMarketId === marketId.toLowerCase();
      });
      if (hasRelevantFill) {
        refetch();
      }
    },
  });

  const visibleEvents = useMemo(
    () => events.slice(0, visibleCount),
    [events, visibleCount]
  );

  const emptyMessage =
    mode === 'myWallet'
      ? 'No executions for your wallet on this market.'
      : 'No executions yet for this market.';

  return (
    <div className="bg-[#0f1217] border border-slate-800 rounded-2xl overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-800/50 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase font-black text-slate-500 tracking-widest">
            Market Activity
          </span>
          {isLoading && <Loader2 className="w-3 h-3 animate-spin text-slate-500" />}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 bg-slate-900 border border-slate-800 rounded-lg p-1">
            <Button
              size="sm"
                variant="ghost"
                className={`h-6 px-2 text-[10px] font-black uppercase tracking-widest transition-all ${
                  mode === 'all'
                    ? 'bg-blue-600 text-white shadow-[0_0_0_1px_rgba(59,130,246,0.45)]'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800'
                }`}
              onClick={() => setMode('all')}
            >
              All
            </Button>
            <Button
              size="sm"
                variant="ghost"
                className={`h-6 px-2 text-[10px] font-black uppercase tracking-widest transition-all ${
                  mode === 'myWallet'
                    ? 'bg-blue-600 text-white shadow-[0_0_0_1px_rgba(59,130,246,0.45)]'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800'
                }`}
              disabled={!address}
              onClick={() => setMode('myWallet')}
            >
              My Wallet
            </Button>
          </div>
          {showHistoryLink && (
            <Button
              asChild
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-white"
            >
              <Link href={`/history?tab=market&marketId=${marketId}`}>
                Full Log
              </Link>
            </Button>
          )}
        </div>
      </div>

      {visibleEvents.length === 0 && !isLoading ? (
        <div className="px-5 py-6 text-center">
          <p className="text-[11px] text-slate-600 font-bold uppercase tracking-widest">
            {emptyMessage}
          </p>
          {mode === 'myWallet' && !address && (
            <p className="text-[10px] text-slate-600 mt-2 uppercase tracking-widest">
              Connect wallet to view your fills.
            </p>
          )}
        </div>
      ) : (
        <div className="divide-y divide-slate-800/40">
          {visibleEvents.map((event) => (
            <div key={event.id} className="px-5 py-3 flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className={`text-[9px] font-black uppercase px-2 py-0.5 rounded border ${sideClass(event.side)}`}
                  >
                    {sideLabel(event.side)}
                  </span>
                  <span className="text-sm font-mono font-bold text-white">
                    {event.priceCents}¢
                  </span>
                  <span className="text-[11px] text-slate-400 font-bold">
                    x{event.qty.toString()}
                  </span>
                  <span className="text-[10px] text-slate-600 font-mono">
                    maker {shortAddress(event.maker)}
                  </span>
                  <span className="text-[10px] text-slate-600 font-mono">
                    taker {shortAddress(event.taker)}
                  </span>
                </div>
                <div className="text-[10px] text-slate-600 mt-1">
                  {formatTime(event.timestamp)}
                </div>
              </div>
              <a
                href={txExplorerUrl(chainId, event.txHash)}
                target="_blank"
                rel="noreferrer"
                className="text-slate-500 hover:text-blue-400 transition-colors"
                aria-label="Open transaction in block explorer"
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          ))}
        </div>
      )}

      <div className="px-5 py-3 border-t border-slate-800/50 flex items-center justify-between">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => refetch()}
          className="h-7 px-2 text-[10px] font-black uppercase tracking-widest text-slate-500 hover:text-white"
        >
          Refresh
        </Button>
        {events.length > visibleCount && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setVisibleCount((v) => v + 20)}
            className="h-7 px-2 text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-white"
          >
            Load More
          </Button>
        )}
      </div>
    </div>
  );
}
