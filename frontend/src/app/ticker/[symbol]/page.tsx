'use client';

import { use } from 'react';
import { Navbar } from '@/components/Navbar';
import { useMeridianMarket } from '@/hooks/useContracts';
import { usePythPrices } from '@/hooks/usePythPrices';
import { PYTH_FEED_IDS, ASSETS } from '@/constants/assets';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import { TickerLogo } from '@/components/TickerLogo';
import { PolymarketCard } from '@/components/PolymarketCard';

export default function TickerPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = use(params);
  const { markets, isLoadingMarkets } = useMeridianMarket();
  const { data: prices } = usePythPrices();

  const asset = ASSETS.find(a => a.ticker === symbol);
  const feedId = PYTH_FEED_IDS[symbol as keyof typeof PYTH_FEED_IDS];
  const currentPrice = prices ? prices[feedId] : null;

  // Filter markets for this ticker
  const tickerMarkets = markets
    .map((m, i) => ({ ...m, id: i }))
    .filter(m => m.ticker === symbol);

  const activeTickerMarkets = tickerMarkets.filter(m => !m.settled);

  return (
    <div className="flex flex-col min-h-screen">
      <Navbar />
      
      <main className="container mx-auto px-4 py-12 flex-grow">
        <div className="mb-12 flex flex-col md:flex-row md:items-end justify-between gap-6">
          <div>
            <div className="flex items-center gap-4 mb-2">
              <TickerLogo ticker={symbol} size={48} />
              <div>
                <h1 className="text-4xl font-outfit font-bold">{symbol}</h1>
                <p className="text-slate-400">{asset?.name}</p>
              </div>
            </div>
          </div>

          <div className="bg-slate-900/50 border border-slate-800 rounded-2xl p-6 flex gap-12 backdrop-blur-md">
            <div>
              <div className="text-[10px] uppercase font-bold text-slate-500 mb-1 tracking-widest">Last Oracle Price</div>
              <div className="text-3xl font-mono font-bold text-blue-400">
                {currentPrice ? `$${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}` : '...'}
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-8">
            <Card className="bg-slate-900/40 border-slate-800 h-[500px] relative overflow-hidden">
                <iframe
                    src={`https://s.tradingview.com/widgetembed/?frameElementId=tradingview_76d73&symbol=NASDAQ%3A${symbol}&interval=D&hidesidetoolbar=1&hidetoptoolbar=1&symboledit=1&saveimage=1&toolbarbg=f1f3f6&studies=%5B%5D&theme=dark&style=1&timezone=Etc%2FUTC&studies_overrides=%7B%7D&overrides=%7B%7D&enabled_features=%5B%5D&disabled_features=%5B%5D&locale=en&utm_source=localhost&utm_medium=widget&utm_campaign=chart&utm_term=NASDAQ%3A${symbol}`}
                    style={{ width: '100%', height: '100%', border: 'none' }}
                />
            </Card>

            <div className="space-y-4">
                <h2 className="text-2xl font-outfit font-bold">Active {symbol} Markets</h2>
                {isLoadingMarkets ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <Skeleton className="h-48 bg-slate-900/50 rounded-2xl" />
                        <Skeleton className="h-48 bg-slate-900/50 rounded-2xl" />
                    </div>
                ) : activeTickerMarkets.length === 0 ? (
                    <div className="py-12 text-center border-2 border-dashed border-slate-800 rounded-3xl text-slate-500">
                        No active markets for {symbol} at this time.
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {activeTickerMarkets.map((market) => {
                            const strikePrice = Number(market.strikePrice) / 1e5;
                            const settlementTime = new Date(Number(market.expiryTimestamp) * 1000);
                            const isSettled = market.settled;

                            return (
                                <Card key={market.marketId} className="bg-slate-900/40 border-slate-800 hover:border-blue-500/50 transition-all group">
                                    <CardHeader className="pb-2">
                                        <div className="flex justify-between items-center mb-2">
                                            <Badge variant={isSettled ? "secondary" : "outline"} className={isSettled ? "" : "border-blue-500/30 text-blue-400"}>
                                                {isSettled ? "Settled" : "Live"}
                                            </Badge>
                                            <span className="text-[10px] text-slate-500 font-mono">ID: {market.marketId.slice(0, 8)}...</span>
                                        </div>
                                        <CardTitle className="text-lg font-outfit">Above ${strikePrice.toLocaleString()}</CardTitle>
                                        <CardDescription className="text-xs">
                                            {formatDistanceToNow(settlementTime, { addSuffix: true })}
                                        </CardDescription>
                                    </CardHeader>
                                    <CardContent>
                                        <Button asChild className="w-full bg-slate-800 hover:bg-blue-600 text-white font-bold transition-all">
                                            <Link href={`/market/${market.marketId}`}>Trade Market</Link>
                                        </Button>
                                    </CardContent>
                                </Card>
                            );
                        })}
                    </div>
                )}
            </div>
          </div>

          <div className="space-y-6">
            <Card className="bg-slate-900/40 border-slate-800">
                <CardHeader>
                    <CardTitle className="text-lg font-outfit">Asset Stats</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="flex justify-between text-sm py-2 border-b border-slate-800/50">
                        <span className="text-slate-500">Market Cap</span>
                        <span className="text-slate-300">$3.2T</span>
                    </div>
                    <div className="flex justify-between text-sm py-2 border-b border-slate-800/50">
                        <span className="text-slate-500">Oracle Confidence</span>
                        <span className="text-blue-400 font-bold">99.9%</span>
                    </div>
                </CardContent>
            </Card>

            <Card className="bg-blue-600/10 border-blue-500/20">
                <CardContent className="pt-6">
                    <p className="text-xs text-blue-400 leading-relaxed italic">
                        "Trading binary options on {symbol} allows you to profit from price movements with strictly capped risk. Your maximum loss is the amount paid for the option."
                    </p>
                </CardContent>
            </Card>

            {activeTickerMarkets.length > 0 && (
              <PolymarketCard
                ticker={symbol}
                expiryTimestamp={activeTickerMarkets[0].expiryTimestamp}
              />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
