'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAccount, useConfig } from 'wagmi';
import { Loader2, ExternalLink } from 'lucide-react';
import { Navbar } from '@/components/Navbar';
import { MarketActivity } from '@/components/MarketActivity';
import { useTradeHistory } from '@/hooks/useTradeHistory';
import { useMeridianMarket } from '@/hooks/useContracts';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type HistoryTab = 'my' | 'market';

function txExplorerUrl(chainId: number, txHash: string): string {
  return chainId === 8453
    ? `https://basescan.org/tx/${txHash}`
    : `https://sepolia.basescan.org/tx/${txHash}`;
}

function toDisplayAction(eventType: string, side?: number): string {
  if (eventType === 'OrderFilled') return side === 0 ? 'Buy YES Fill' : 'Sell YES Fill';
  if (eventType === 'PairMinted') return 'Mint Pair';
  if (eventType === 'Redeemed') return 'Redeem';
  return eventType;
}

function toDetails(event: any): string {
  if (event.eventType === 'OrderFilled') {
    return `${event.priceCents ?? 0}¢ x${event.qty?.toString?.() ?? '0'}`;
  }
  if (event.eventType === 'PairMinted') {
    return `Qty ${event.mintQty?.toString?.() ?? '0'}`;
  }
  if (event.eventType === 'Redeemed') {
    const payout = event.payout != null ? Number(event.payout) / 1e6 : 0;
    return `Qty ${event.redeemQty?.toString?.() ?? '0'} • $${payout.toFixed(2)}`;
  }
  return '—';
}

export default function HistoryPage() {
  const searchParams = useSearchParams();
  const { isConnected } = useAccount();
  const config = useConfig();
  const chainId = config.state.chainId;

  const initialTabParam = searchParams.get('tab');
  const initialTab: HistoryTab =
    initialTabParam === 'market' ? 'market' : isConnected ? 'my' : 'market';
  const initialMarketId = searchParams.get('marketId') ?? '';

  const [activeTab, setActiveTab] = useState<HistoryTab>(initialTab);
  const [selectedMarketId, setSelectedMarketId] = useState(initialMarketId);

  const { data: tradeEvents = [], isLoading: isLoadingHistory, refetch } = useTradeHistory();
  const { markets, isLoadingMarkets } = useMeridianMarket();

  const marketOptions = useMemo(
    () =>
      markets
        .map((m) => ({
          marketId: String(m.marketId).toLowerCase(),
          ticker: String(m.ticker),
          strike: Number(m.strikePrice) / 1e5,
          expiry: Number(m.expiryTimestamp),
        }))
        .sort((a, b) => b.expiry - a.expiry),
    [markets]
  );

  useEffect(() => {
    if (marketOptions.length === 0) return;
    if (selectedMarketId) return;
    setSelectedMarketId(marketOptions[0].marketId);
  }, [marketOptions, selectedMarketId]);

  const sortedTradeEvents = useMemo(
    () =>
      [...tradeEvents].sort((a, b) => {
        if (a.blockNumber !== b.blockNumber) return b.blockNumber - a.blockNumber;
        return b.logIndex - a.logIndex;
      }),
    [tradeEvents]
  );

  return (
    <div className="flex flex-col min-h-screen bg-[#0b0e11]">
      <Navbar />
      <main className="container mx-auto px-4 py-10 flex-grow">
        <div className="mb-8">
          <h1 className="text-4xl font-outfit font-black tracking-tight">History</h1>
          <p className="text-slate-500 mt-2">
            Trade execution log for your wallet and market-wide activity.
          </p>
        </div>

        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as HistoryTab)}>
          <TabsList className="grid grid-cols-2 w-full max-w-md bg-[#1a1c23] p-1 rounded-2xl border border-slate-800/50 h-10 mb-6">
            <TabsTrigger
              value="my"
              className="data-[state=active]:bg-blue-600 data-[state=active]:text-white rounded-xl transition-all font-black text-[10px] tracking-widest uppercase h-full"
            >
              My History
            </TabsTrigger>
            <TabsTrigger
              value="market"
              className="data-[state=active]:bg-slate-600 data-[state=active]:text-white rounded-xl transition-all font-black text-[10px] tracking-widest uppercase h-full"
            >
              Market Activity
            </TabsTrigger>
          </TabsList>

          <TabsContent value="my" className="outline-none">
            <Card className="bg-[#0f1217] border-slate-800 rounded-2xl overflow-hidden">
              <CardHeader className="border-b border-slate-800/50">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-xs uppercase tracking-[0.25em] text-slate-500 font-black">
                    My Execution Log
                  </CardTitle>
                  <button
                    onClick={() => refetch()}
                    className="text-[10px] uppercase tracking-widest font-black text-slate-500 hover:text-white"
                  >
                    Refresh
                  </button>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                {!isConnected ? (
                  <div className="py-20 text-center text-slate-500 text-sm">
                    Connect your wallet to view your history.
                  </div>
                ) : isLoadingHistory ? (
                  <div className="py-20 text-center flex items-center justify-center gap-2 text-slate-500 text-sm">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Syncing history...
                  </div>
                ) : sortedTradeEvents.length === 0 ? (
                  <div className="py-20 text-center text-slate-500 text-sm">
                    No wallet executions found yet.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-slate-800/50 bg-slate-900/20">
                          <th className="text-left px-5 py-3 text-[10px] uppercase tracking-widest text-slate-500">Block</th>
                          <th className="text-left px-5 py-3 text-[10px] uppercase tracking-widest text-slate-500">Action</th>
                          <th className="text-left px-5 py-3 text-[10px] uppercase tracking-widest text-slate-500">Market</th>
                          <th className="text-left px-5 py-3 text-[10px] uppercase tracking-widest text-slate-500">Details</th>
                          <th className="text-right px-5 py-3 text-[10px] uppercase tracking-widest text-slate-500">Tx</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedTradeEvents.map((event) => (
                          <tr key={event.id} className="border-b border-slate-800/30">
                            <td className="px-5 py-3 text-xs font-mono text-slate-400">
                              #{event.blockNumber}
                            </td>
                            <td className="px-5 py-3 text-sm text-slate-200">
                              {toDisplayAction(event.eventType, event.side)}
                            </td>
                            <td className="px-5 py-3">
                              <Link
                                href={`/market/${event.marketId}`}
                                className="text-xs font-mono text-blue-400 hover:text-blue-300"
                              >
                                {event.marketId.slice(0, 10)}...
                              </Link>
                            </td>
                            <td className="px-5 py-3 text-xs text-slate-400">
                              {toDetails(event)}
                            </td>
                            <td className="px-5 py-3 text-right">
                              <a
                                href={txExplorerUrl(chainId, event.txHash)}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center text-slate-500 hover:text-blue-400"
                              >
                                <ExternalLink className="w-3.5 h-3.5" />
                              </a>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="market" className="outline-none">
            <Card className="bg-[#0f1217] border-slate-800 rounded-2xl mb-4">
              <CardHeader className="border-b border-slate-800/50">
                <CardTitle className="text-xs uppercase tracking-[0.25em] text-slate-500 font-black">
                  Select Market
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-5">
                <div className="flex flex-col gap-3">
                  <label className="text-[10px] uppercase tracking-widest font-black text-slate-500">
                    Market
                  </label>
                  <select
                    value={selectedMarketId}
                    onChange={(e) => setSelectedMarketId(e.target.value)}
                    disabled={isLoadingMarkets || marketOptions.length === 0}
                    className="bg-[#15181e] border border-slate-800 rounded-xl h-10 px-3 text-sm text-slate-200"
                  >
                    {marketOptions.length === 0 && (
                      <option value="">No markets available</option>
                    )}
                    {marketOptions.map((market) => (
                      <option key={market.marketId} value={market.marketId}>
                        {market.ticker} • Above ${market.strike.toLocaleString()}
                      </option>
                    ))}
                  </select>
                </div>
              </CardContent>
            </Card>

            {selectedMarketId ? (
              <MarketActivity
                marketId={selectedMarketId as `0x${string}`}
                showHistoryLink={false}
                initialMode="all"
              />
            ) : (
              <div className="text-slate-500 text-sm py-8">
                Select a market to view public execution activity.
              </div>
            )}
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
