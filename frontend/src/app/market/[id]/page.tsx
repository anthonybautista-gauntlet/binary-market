'use client';

import { use } from 'react';
import { Navbar } from '@/components/Navbar';
import { useMarket } from '@/hooks/useContracts';
import { usePythPrices } from '@/hooks/usePythPrices';
import { PYTH_FEED_IDS } from '@/constants/assets';
import { OrderBook } from '@/components/OrderBook';
import { TradePanel } from '@/components/TradePanel';
import { OpenOrders } from '@/components/OpenOrders';
import { MarketActivity } from '@/components/MarketActivity';
import { SettlementCountdown } from '@/components/SettlementCountdown';
import { Skeleton } from '@/components/ui/skeleton';
import { Card } from '@/components/ui/card';
import { TickerLogo } from '@/components/TickerLogo';

export default function MarketDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const marketId = id as `0x${string}`;
  const { market, isLoading: isLoadingMarket } = useMarket(marketId);
  const { data: prices } = usePythPrices();

  if (isLoadingMarket || !market) {
    return (
      <div className="flex flex-col min-h-screen">
        <Navbar />
        <main className="container mx-auto px-4 py-12">
          <Skeleton className="h-12 w-1/3 mb-4 bg-slate-900" />
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <Skeleton className="h-[600px] lg:col-span-1 bg-slate-900" />
            <Skeleton className="h-[600px] lg:col-span-2 bg-slate-900" />
          </div>
        </main>
      </div>
    );
  }

  const ticker = market.ticker;
  const feedId = PYTH_FEED_IDS[ticker as keyof typeof PYTH_FEED_IDS];
  const currentPrice = prices ? prices[feedId] : null;
  const strikePrice = Number(market.strikePrice) / 1e5;

  // Implied probability: how likely YES is based on current price vs strike
  const impliedProb = currentPrice != null
    ? Math.min(99, Math.max(1, Math.round((currentPrice / strikePrice) * 50)))
    : null;

  return (
    <div className="flex flex-col min-h-screen">
      <Navbar />

      <main className="container mx-auto px-4 py-8 lg:py-12 flex-grow">
        <div className="mb-8 flex flex-col md:flex-row md:items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <TickerLogo ticker={ticker} size={36} />
              <h1 className="text-3xl font-outfit font-bold">{ticker} Binary Option</h1>
            </div>
            <p className="text-slate-400 font-inter">
              Will {ticker} close above{' '}
              <span className="text-white font-bold">${strikePrice.toLocaleString()}</span> at 4:00 PM ET?
            </p>
          </div>

          <div className="bg-slate-900/50 border border-slate-800 rounded-2xl p-4 flex flex-col gap-4 backdrop-blur-md min-w-[280px]">
            <div className="flex gap-6 flex-wrap">
              <div>
                <div className="text-[10px] uppercase font-black text-blue-500 mb-1 tracking-widest">Oracle Price</div>
                <div className="text-xl font-mono font-bold text-blue-400">
                  {currentPrice
                    ? `$${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}`
                    : '...'}
                </div>
              </div>
              <div className="border-l border-slate-800 pl-6">
                <div className="text-[10px] uppercase font-black text-slate-500 mb-1 tracking-widest">Strike</div>
                <div className="text-xl font-mono font-bold text-slate-300">
                  ${strikePrice.toLocaleString()}
                </div>
              </div>
              {impliedProb != null && (
                <div className="border-l border-slate-800 pl-6">
                  <div className="text-[10px] uppercase font-black text-slate-500 mb-1 tracking-widest">Implied Prob.</div>
                  <div className="text-xl font-mono font-bold text-slate-200">
                    ~{impliedProb}%
                  </div>
                </div>
              )}
            </div>
            <div className="pt-2 border-t border-slate-800/50">
              <SettlementCountdown
                expiryTimestamp={market.expiryTimestamp}
                settled={market.settled}
                yesWins={market.yesWins}
              />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-1 order-2 lg:order-1 space-y-4">
            <OrderBook marketId={marketId} />
            <OpenOrders marketId={marketId} />
            <MarketActivity marketId={marketId} />
          </div>

          <div className="lg:col-span-2 order-1 lg:order-2 space-y-8">
            <Card className="bg-slate-900/40 border-slate-800 h-[500px] relative overflow-hidden">
              <iframe
                src={`https://s.tradingview.com/widgetembed/?frameElementId=tradingview_76d73&symbol=NASDAQ%3A${ticker}&interval=D&hidesidetoolbar=1&hidetoptoolbar=1&symboledit=1&saveimage=1&toolbarbg=f1f3f6&studies=%5B%5D&theme=dark&style=1&timezone=Etc%2FUTC&studies_overrides=%7B%7D&overrides=%7B%7D&enabled_features=%5B%5D&disabled_features=%5B%5D&locale=en&utm_source=localhost&utm_medium=widget&utm_campaign=chart&utm_term=NASDAQ%3A${ticker}`}
                style={{ width: '100%', height: '100%', border: 'none' }}
              />
            </Card>

            <TradePanel
              marketId={marketId}
              ticker={ticker}
              strikePrice={strikePrice}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
