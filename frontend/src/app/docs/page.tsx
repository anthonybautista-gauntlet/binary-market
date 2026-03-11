'use client';

import { Navbar } from '@/components/Navbar';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, BookOpen, CandlestickChart, Clock3, Scale, ShieldCheck } from 'lucide-react';

export default function DocsPage() {
  const lifecycle = [
    {
      title: 'Morning Market Creation',
      desc: 'The automation service creates same-day strike markets for MAG7 names using prior close references and rounded strike ladders.',
    },
    {
      title: 'Intraday Trading',
      desc: 'Users trade YES exposure on one on-chain order book per market. Buy NO and Sell NO are mapped to that same YES book under the hood.',
    },
    {
      title: 'Settlement Window',
      desc: 'After close, markets settle from oracle price data. If oracle settlement cannot complete in-window, admin override is used with enforced delay.',
    },
    {
      title: 'Redemption',
      desc: 'Winning side redeems for USDC. Losing side redeems to zero. Unredeemed winning tokens remain redeemable.',
    },
  ];

  return (
    <div className="flex flex-col min-h-screen bg-[#0b0e11]">
      <Navbar />

      <main className="container mx-auto px-4 py-10 flex-grow max-w-5xl">
        <div className="mb-8">
          <h1 className="text-4xl font-outfit font-black tracking-tight">Docs</h1>
          <p className="text-slate-500 mt-2">
            How Meridian markets work, how prices are used, and what settles contracts on-chain.
          </p>
        </div>

        <Card className="bg-[#0f1217] border-slate-800 rounded-2xl mb-6">
          <CardHeader className="border-b border-slate-800/50">
            <CardTitle className="text-xs uppercase tracking-[0.25em] text-slate-500 font-black flex items-center gap-2">
              <BookOpen className="w-4 h-4" /> Meridian Overview
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-5 space-y-3 text-sm text-slate-300 leading-relaxed">
            <p>
              Meridian lists 0DTE binary markets on MAG7 stocks. Each market is a yes/no question:
              <span className="text-white font-semibold"> &quot;Will [ticker] close at or above [strike] today?&quot;</span>
            </p>
            <p>
              Each market has two complementary outcomes with a fixed payout invariant at settlement:
              <span className="text-white font-semibold"> YES pays $1 and NO pays $0, or YES pays $0 and NO pays $1.</span>
            </p>
            <p>
              At-strike resolves to YES (at-or-above rule).
            </p>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          {lifecycle.map((item) => (
            <Card key={item.title} className="bg-[#0f1217] border-slate-800 rounded-2xl">
              <CardContent className="pt-5">
                <p className="text-[10px] uppercase tracking-widest font-black text-slate-500 mb-2">
                  Lifecycle
                </p>
                <h3 className="text-base font-bold text-white mb-2">{item.title}</h3>
                <p className="text-sm text-slate-400 leading-relaxed">{item.desc}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card className="bg-[#0f1217] border-slate-800 rounded-2xl mb-6">
          <CardHeader className="border-b border-slate-800/50">
            <CardTitle className="text-xs uppercase tracking-[0.25em] text-slate-500 font-black flex items-center gap-2">
              <Scale className="w-4 h-4" /> One Order Book, Four Actions
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-5 space-y-2 text-sm text-slate-300">
            <p><Badge className="bg-blue-600 mr-2">Buy YES</Badge> buys YES from asks.</p>
            <p><Badge className="bg-slate-700 mr-2">Sell YES</Badge> sells YES into bids / posts asks.</p>
            <p><Badge className="bg-red-600 mr-2">Buy NO</Badge> mints pair, sells YES, keeps NO (effective NO cost = 1 - YES sale price).</p>
            <p><Badge className="bg-amber-600 text-black mr-2">Sell NO</Badge> buys YES to close NO exposure via YES+NO parity.</p>
            <p className="text-slate-500 pt-1">
              Buy YES and Sell NO are the same YES-buying side of the book. Buy NO and Sell YES are the YES-selling side.
            </p>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <Card className="bg-[#0f1217] border-slate-800 rounded-2xl">
            <CardHeader className="border-b border-slate-800/50">
              <CardTitle className="text-xs uppercase tracking-[0.25em] text-slate-500 font-black flex items-center gap-2">
                <CandlestickChart className="w-4 h-4" /> Chart Prices
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-5 text-sm text-slate-300 space-y-2">
              <p>
                Price charts are for trading context and visualization only.
              </p>
              <p>
                They can differ from settlement inputs due to feed timing, display intervals, and provider sourcing.
              </p>
            </CardContent>
          </Card>

          <Card className="bg-[#0f1217] border-slate-800 rounded-2xl">
            <CardHeader className="border-b border-slate-800/50">
              <CardTitle className="text-xs uppercase tracking-[0.25em] text-slate-500 font-black flex items-center gap-2">
                <Clock3 className="w-4 h-4" /> Oracle Prices (Resolution Source)
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-5 text-sm text-slate-300 space-y-2">
              <p>
                Contract resolution is based on on-chain oracle settlement logic, not chart pixels.
              </p>
              <p>
                Meridian settles from Pyth-compatible oracle data. If timely/confident oracle settlement cannot complete in-window, admin override fallback uses Yahoo Finance closing data after the configured delay.
              </p>
              <p className="text-slate-500">
                Resolution source priority: Oracle settlement first, admin override fallback second.
              </p>
            </CardContent>
          </Card>
        </div>

        <Card className="bg-[#0f1217] border-slate-800 rounded-2xl">
          <CardHeader className="border-b border-slate-800/50">
            <CardTitle className="text-xs uppercase tracking-[0.25em] text-slate-500 font-black flex items-center gap-2">
              <ShieldCheck className="w-4 h-4" /> Safety, Risks, and Limitations
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-5 text-sm text-slate-300 space-y-3">
            <p>
              Meridian is non-custodial software. You sign your own transactions and keep control of your wallet keys.
            </p>
            <p>
              Smart contract, oracle, RPC, and UI/infra risks can affect execution timing and data freshness. Use caution and verify market details before signing.
            </p>
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-200 text-xs leading-relaxed flex gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                Disclaimer: This documentation is technical information, not investment, legal, or regulatory advice. No compliance or jurisdictional claims are made here.
              </span>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
