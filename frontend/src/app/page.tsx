'use client';

import { Navbar } from '@/components/Navbar';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { usePythPrices } from '@/hooks/usePythPrices';
import { ASSETS, PYTH_FEED_IDS } from '@/constants/assets';
import { Skeleton } from '@/components/ui/skeleton';
import { TickerLogo } from '@/components/TickerLogo';

export default function Home() {
  const { data: prices, isLoading } = usePythPrices();

  return (
    <div className="flex flex-col min-h-screen">
      <Navbar />
      
      <main className="flex-grow">
        {/* Hero Section */}
        <section className="relative py-24 md:py-32 overflow-hidden">
          <div className="container mx-auto px-4 relative z-10 text-center">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs font-semibold mb-6">
              <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse"></span>
              Live on Base Sepolia
            </div>
            <h1 className="text-5xl md:text-7xl font-outfit font-extrabold tracking-tight mb-6 bg-clip-text text-transparent bg-gradient-to-b from-white to-slate-500">
              Binary Options for <br /> MAG7 Equities
            </h1>
            <p className="max-w-2xl mx-auto text-lg text-slate-400 mb-10 leading-relaxed font-inter">
              Trade prediction markets on the world's leading technology stocks. 
              Non-custodial, on-chain order books, and Pyth network settlement.
            </p>
            <div className="flex flex-wrap justify-center gap-4">
              <Button asChild size="lg" className="bg-blue-600 hover:bg-blue-700 text-white px-8 h-14 rounded-full font-bold shadow-lg shadow-blue-600/20">
                <Link href="/markets">Launch App</Link>
              </Button>
              <Button variant="outline" size="lg" asChild className="border-slate-800 hover:bg-slate-900 px-8 h-14 rounded-full font-bold bg-slate-950/50 backdrop-blur-sm text-white">
                <Link href="/docs">View Documentation</Link>
              </Button>
            </div>
          </div>
        </section>

        {/* Assets Grid */}
        <section className="py-20 bg-slate-900/30">
          <div className="container mx-auto px-4">
            <h2 className="text-2xl font-outfit font-bold mb-12 text-center">Supported Markets</h2>
            <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 gap-4">
              {ASSETS.map((asset) => {
                const feedId = PYTH_FEED_IDS[asset.ticker];
                const price = prices ? prices[feedId] : null;

                return (
                  <Link 
                    key={asset.ticker} 
                    href={`/ticker/${asset.ticker}`}
                    className="p-6 rounded-2xl bg-slate-900/50 border border-slate-800 flex flex-col items-center hover:border-blue-500/50 transition-all cursor-pointer group"
                  >
                    <div className="mb-4">
                      <TickerLogo ticker={asset.ticker} size={48} />
                    </div>
                    <div className="font-bold text-lg font-outfit">{asset.ticker}</div>
                    <div className="text-xs text-slate-500 truncate w-full text-center mb-2">{asset.name}</div>
                    
                    {isLoading ? (
                      <Skeleton className="h-4 w-16 bg-slate-800" />
                    ) : (
                      <div className="font-mono text-sm font-bold text-blue-400">
                        {price ? `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'N/A'}
                      </div>
                    )}
                  </Link>
                );
              })}
            </div>
          </div>
        </section>
      </main>

      <footer className="py-10 border-t border-slate-900 bg-slate-950">
        <div className="container mx-auto px-4 flex flex-col md:flex-row justify-between items-center gap-6">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 bg-slate-800 rounded flex items-center justify-center text-xs font-bold">M</div>
            <span className="font-outfit font-bold text-sm tracking-tight">MERIDIAN MARKET</span>
          </div>
          <div className="text-slate-500 text-sm">
            © 2024 Meridian Market. Built on Base.
          </div>
          <div className="flex gap-6 text-sm text-slate-400">
            <a href="#" className="hover:text-white underline-offset-4 hover:underline">Terms</a>
            <a href="#" className="hover:text-white underline-offset-4 hover:underline">Privacy</a>
            <a href="#" className="hover:text-white underline-offset-4 hover:underline">Twitter</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
