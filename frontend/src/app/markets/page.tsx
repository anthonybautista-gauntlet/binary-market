'use client';

import { useState, useMemo } from 'react';
import { Navbar } from '@/components/Navbar';
import { useMeridianMarket } from '@/hooks/useContracts';
import { usePythPrices } from '@/hooks/usePythPrices';
import { PYTH_FEED_IDS } from '@/constants/assets';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import { TickerLogo } from '@/components/TickerLogo';
import { MarketStatusBadge } from '@/components/SettlementCountdown';
import { PolymarketBadge } from '@/components/PolymarketCard';

type StatusFilter = 'all' | 'live' | 'settled';
type SortOption = 'newest' | 'oldest' | 'strike-asc' | 'strike-desc';

const SORT_LABELS: Record<SortOption, string> = {
  newest: 'Newest',
  oldest: 'Oldest',
  'strike-asc': 'Strike ↑',
  'strike-desc': 'Strike ↓',
};

function FilterPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-xl text-[11px] font-black uppercase tracking-widest transition-all ${
        active
          ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/20'
          : 'bg-slate-900/50 text-slate-500 hover:text-slate-300 border border-slate-800 hover:border-slate-700'
      }`}
    >
      {label}
    </button>
  );
}

export default function MarketsPage() {
  const { markets, isLoadingMarkets } = useMeridianMarket();
  const { data: prices } = usePythPrices();

  const [tickerFilter, setTickerFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('live');
  const [sortBy, setSortBy] = useState<SortOption>('newest');

  // Derive the unique tickers that actually have markets on-chain
  const availableTickers = useMemo(
    () => ['ALL', ...Array.from(new Set(markets.map(m => m.ticker))).sort()],
    [markets],
  );

  const filtered = useMemo(() => {
    const result = markets.filter(market => {
      if (tickerFilter !== 'ALL' && market.ticker !== tickerFilter) return false;
      if (statusFilter === 'live' && market.settled) return false;
      if (statusFilter === 'settled' && !market.settled) return false;
      return true;
    });

    result.sort((a, b) => {
      switch (sortBy) {
        case 'newest':
          return Number(b.expiryTimestamp) - Number(a.expiryTimestamp);
        case 'oldest':
          return Number(a.expiryTimestamp) - Number(b.expiryTimestamp);
        case 'strike-asc':
          return Number(a.strikePrice) - Number(b.strikePrice);
        case 'strike-desc':
          return Number(b.strikePrice) - Number(a.strikePrice);
        default:
          return 0;
      }
    });

    return result;
  }, [markets, tickerFilter, statusFilter, sortBy]);

  return (
    <div className="flex flex-col min-h-screen">
      <Navbar />

      <main className="container mx-auto px-4 py-12 flex-grow">
        {/* ── Header ─────────────────────────────────────────────────── */}
        <div className="flex justify-between items-end mb-8">
          <div>
            <h1 className="text-4xl font-outfit font-bold mb-2">Active Markets</h1>
            <p className="text-slate-400">Trade binary options on top tech equities.</p>
          </div>

          {!isLoadingMarkets && markets.length > 0 && (
            <p className="text-[11px] text-slate-600 font-mono">
              {filtered.length} / {markets.length} markets
            </p>
          )}
        </div>

        {/* ── Filters ────────────────────────────────────────────────── */}
        {!isLoadingMarkets && markets.length > 0 && (
          <div className="flex flex-wrap gap-6 mb-8">
            {/* Ticker filter */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] text-slate-600 uppercase font-black tracking-widest mr-1">
                Ticker
              </span>
              {availableTickers.map(ticker => (
                <FilterPill
                  key={ticker}
                  label={ticker}
                  active={tickerFilter === ticker}
                  onClick={() => setTickerFilter(ticker)}
                />
              ))}
            </div>

            {/* Status filter */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] text-slate-600 uppercase font-black tracking-widest mr-1">
                Status
              </span>
              {(['all', 'live', 'settled'] as StatusFilter[]).map(s => (
                <FilterPill
                  key={s}
                  label={s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
                  active={statusFilter === s}
                  onClick={() => setStatusFilter(s)}
                />
              ))}
            </div>

            {/* Sort */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] text-slate-600 uppercase font-black tracking-widest mr-1">
                Sort
              </span>
              {(Object.keys(SORT_LABELS) as SortOption[]).map(opt => (
                <FilterPill
                  key={opt}
                  label={SORT_LABELS[opt]}
                  active={sortBy === opt}
                  onClick={() => setSortBy(opt)}
                />
              ))}
            </div>
          </div>
        )}

        {/* ── Market grid ────────────────────────────────────────────── */}
        {isLoadingMarkets ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[1, 2, 3].map(i => (
              <Skeleton key={i} className="h-64 rounded-2xl bg-slate-900/50" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filtered.map((market, index) => {
              const ticker = market.ticker;
              const feedId = PYTH_FEED_IDS[ticker as keyof typeof PYTH_FEED_IDS];
              const currentPrice = prices ? prices[feedId] : null;
              const strikePrice = Number(market.strikePrice) / 1e5;
              const settlementTime = new Date(Number(market.expiryTimestamp) * 1000);

              return (
                <Card
                  key={index}
                  className="bg-slate-900/40 border-slate-800 hover:border-blue-500/50 transition-all overflow-hidden group"
                >
                  <CardHeader className="pb-4">
                    <div className="flex justify-between items-start mb-2">
                      <TickerLogo ticker={ticker} size={40} />
                      <MarketStatusBadge
                        expiryTimestamp={market.expiryTimestamp}
                        settled={market.settled}
                        yesWins={market.yesWins}
                      />
                    </div>
                    <CardTitle className="text-xl font-outfit">
                      {ticker} Above ${strikePrice.toLocaleString()}
                    </CardTitle>
                    <CardDescription className="text-xs text-slate-500 uppercase tracking-wider font-semibold">
                      Settles {formatDistanceToNow(settlementTime, { addSuffix: true })}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-4">
                      <div className="flex justify-between text-sm py-2 border-y border-slate-800/50">
                        <span className="text-slate-400">Current Price</span>
                        <span className="font-mono font-bold text-white">
                          {currentPrice
                            ? `$${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}`
                            : 'Loading...'}
                        </span>
                      </div>
                      <div className="flex justify-between text-sm py-2 border-b border-slate-800/50">
                        <span className="text-slate-400">Strike Price</span>
                        <span className="font-mono font-bold text-slate-300">
                          ${strikePrice.toLocaleString()}
                        </span>
                      </div>

                      <div className="flex justify-between items-center py-1">
                        <PolymarketBadge
                          ticker={ticker}
                          expiryTimestamp={market.expiryTimestamp}
                        />
                      </div>

                      <Button
                        asChild
                        className="w-full bg-slate-800 hover:bg-blue-600 text-white transition-all font-bold group-hover:animate-glow"
                      >
                        <Link href={`/market/${market.marketId}`}>Trade Now</Link>
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}

            {filtered.length === 0 && markets.length > 0 && (
              <div className="col-span-full py-16 text-center border-2 border-dashed border-slate-800 rounded-3xl">
                <p className="text-slate-500 font-outfit text-lg mb-2">No markets match your filters.</p>
                <button
                  onClick={() => { setTickerFilter('ALL'); setStatusFilter('all'); setSortBy('newest'); }}
                  className="text-sm text-blue-400 hover:text-blue-300 underline"
                >
                  Clear filters
                </button>
              </div>
            )}

            {markets.length === 0 && (
              <div className="col-span-full py-20 text-center border-2 border-dashed border-slate-800 rounded-3xl">
                <p className="text-slate-500 font-outfit text-lg">No active markets found.</p>
                <p className="text-sm text-slate-600">
                  Check back later or ensure the contract is correctly configured.
                </p>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
