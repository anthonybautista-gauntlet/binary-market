'use client';

import { Navbar } from '@/components/Navbar';
import { useAccount, useReadContracts } from 'wagmi';
import MeridianMarketABI from '@/lib/abi/MeridianMarket.json';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { keccak256, encodeAbiParameters, parseAbiParameters } from 'viem';
import { useMeridianMarket } from '@/hooks/useContracts';
import { useUSDCData } from '@/hooks/useUSDCData';
import { usePythPrices } from '@/hooks/usePythPrices';
import { useTradeHistory, computeMarketPnL } from '@/hooks/useTradeHistory';
import { ASSET_META, PYTH_FEED_IDS, Ticker } from '@/constants/assets';
import { TickerLogo } from '@/components/TickerLogo';
import { Loader2, Briefcase, ExternalLink, RefreshCw } from 'lucide-react';
import { RedeemButton } from '@/components/RedeemButton';
import Link from 'next/link';

const MARKET_ADDRESS = process.env.NEXT_PUBLIC_MERIDIAN_MARKET_ADDRESS as `0x${string}`;

function pnlColor(v: number | null) {
  if (v == null) return 'text-slate-500';
  if (v > 0) return 'text-green-400';
  if (v < 0) return 'text-red-400';
  return 'text-slate-400';
}

function formatPnl(v: number | null): string {
  if (v == null) return 'N/A';
  const sign = v >= 0 ? '+' : '';
  return `${sign}$${v.toFixed(2)}`;
}

export default function PortfolioPage() {
  const { address, isConnected } = useAccount();
  const { markets, isLoadingMarkets } = useMeridianMarket();
  const { formattedBalance } = useUSDCData();
  const { data: prices } = usePythPrices();
  const { data: tradeEvents = [], isLoading: isLoadingHistory, refetch: refetchHistory } = useTradeHistory();

  const pnlByMarket = address
    ? computeMarketPnL(tradeEvents, address)
    : new Map();

  const balanceCalls = markets.flatMap((market) => {
    const marketId = market.marketId as `0x${string}`;
    const noId = keccak256(encodeAbiParameters(
      parseAbiParameters('bytes32, string'),
      [marketId, 'NO']
    ));
    return [
      {
        address: MARKET_ADDRESS,
        abi: MeridianMarketABI.abi as any,
        functionName: 'balanceOf',
        args: [address, BigInt(marketId)],
      },
      {
        address: MARKET_ADDRESS,
        abi: MeridianMarketABI.abi as any,
        functionName: 'balanceOf',
        args: [address, BigInt(noId)],
      },
    ];
  });

  const { data: balances, isLoading: isLoadingBalances } = useReadContracts({
    contracts: balanceCalls,
    query: {
      enabled: isConnected && markets.length > 0,
    },
  });

  if (!isConnected) {
    return (
      <div className="flex flex-col min-h-screen bg-[#0b0e11]">
        <Navbar />
        <main className="container mx-auto px-4 py-20 text-center flex flex-col items-center justify-center">
          <div className="w-20 h-20 bg-slate-900 border border-slate-800 rounded-3xl flex items-center justify-center mb-6">
            <Briefcase className="w-10 h-10 text-slate-500" />
          </div>
          <h1 className="text-4xl font-outfit font-bold mb-4">Your Portfolio</h1>
          <p className="text-slate-400 mb-8 font-inter max-w-md">
            Connect your wallet to track your binary options positions and redeem winnings.
          </p>
        </main>
      </div>
    );
  }

  const holdings = markets.map((market, i) => {
    const yesBalance = (balances?.[i * 2]?.result as bigint) || 0n;
    const noBalance = (balances?.[i * 2 + 1]?.result as bigint) || 0n;
    const ticker = market.ticker as Ticker;
    const feedId = PYTH_FEED_IDS[ticker];
    const currentPrice = prices ? prices[feedId] : null;
    const strikePrice = Number(market.strikePrice) / 1e5;

    // Implied current value: yesBalance * bestBid (approximated from currentPrice vs strike)
    // Since we don't have live best bid/ask here, use Pyth price as probability proxy:
    //   implied YES value ≈ clamp(currentPrice / strike, 0, 1) * $1.00
    // This is a rough approximation for display purposes. Live order book prices are shown on the trade screen.
    let impliedValue: number | null = null;
    if (currentPrice != null && (yesBalance > 0n || noBalance > 0n)) {
      const prob = Math.min(1, Math.max(0, currentPrice / strikePrice));
      const yesVal = Number(yesBalance) * prob;
      const noVal = Number(noBalance) * (1 - prob);
      impliedValue = yesVal + noVal;
    }

    const pnlData = pnlByMarket.get(market.marketId as string);

    return {
      marketId: market.marketId as `0x${string}`,
      ticker,
      strikePrice,
      yesBalance,
      noBalance,
      settled: market.settled,
      yesWins: market.yesWins,
      impliedValue,
      avgEntryPriceCents: pnlData?.avgEntryPriceCents ?? null,
      unrealizedPnl: impliedValue != null && pnlData?.totalCostUsdc != null
        ? impliedValue - pnlData.totalCostUsdc
        : null,
      realizedPnl: pnlData?.realizedPnlUsdc ?? null,
    };
  }).filter(h => h.yesBalance > 0n || h.noBalance > 0n);

  const isLoading = isLoadingBalances || isLoadingMarkets;

  return (
    <div className="flex flex-col min-h-screen bg-[#0b0e11]">
      <Navbar />

      <main className="container mx-auto px-4 py-12 flex-grow">
        <div className="flex flex-col md:flex-row md:items-end justify-between mb-12 gap-6">
          <div>
            <h1 className="text-5xl font-outfit font-black mb-2 tracking-tight">Portfolio</h1>
            <p className="text-slate-500 font-medium">Positions, P&amp;L, and settlement claims</p>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-4 bg-slate-900/50 border border-slate-800 px-5 py-3 rounded-2xl backdrop-blur-md">
              <div className="flex flex-col">
                <span className="text-[9px] uppercase font-bold text-slate-500 tracking-widest">USDC Balance</span>
                <span className="text-sm text-green-400 font-mono font-bold">${formattedBalance}</span>
              </div>
              <div className="border-l border-slate-800 pl-4 flex flex-col">
                <span className="text-[9px] uppercase font-bold text-slate-500 tracking-widest">Active Wallet</span>
                <span className="text-xs text-blue-400 font-mono font-bold">
                  {address?.slice(0, 8)}...{address?.slice(-6)}
                </span>
              </div>
              <ExternalLink className="w-4 h-4 text-slate-600" />
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetchHistory()}
              disabled={isLoadingHistory}
              className="border-slate-800 text-slate-400 hover:text-white hover:bg-slate-800 h-10 rounded-xl gap-2"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoadingHistory ? 'animate-spin' : ''}`} />
              <span className="text-[10px] font-black uppercase tracking-widest">Sync History</span>
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-8">
          <Card className="bg-[#0f1217] border-slate-800 shadow-2xl shadow-blue-500/5 rounded-3xl overflow-hidden">
            <CardHeader className="bg-slate-900/30 border-b border-slate-800/50 px-8 py-6">
              <div className="flex items-center justify-between">
                <CardTitle className="text-xs uppercase tracking-[0.3em] font-black text-slate-500 flex items-center gap-3">
                  <div className="w-2 h-2 rounded-full bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.5)]" />
                  Active Positions
                </CardTitle>
                {isLoadingHistory && (
                  <div className="flex items-center gap-2 text-[10px] text-slate-500 font-bold uppercase tracking-widest">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Syncing P&amp;L history...
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {isLoading ? (
                <div className="flex flex-col items-center justify-center py-32 gap-6">
                  <Loader2 className="w-12 h-12 animate-spin text-blue-500" />
                  <span className="text-sm font-outfit text-slate-500 uppercase tracking-widest font-bold">
                    Synchronizing with Chain
                  </span>
                </div>
              ) : holdings.length === 0 ? (
                <div className="text-center py-32 flex flex-col items-center">
                  <div className="w-16 h-16 bg-slate-900 border border-slate-800 rounded-2xl flex items-center justify-center mb-6">
                    <Briefcase className="w-8 h-8 text-slate-700" />
                  </div>
                  <p className="text-slate-500 font-outfit text-xl mb-6">No active positions detected.</p>
                  <Button asChild size="lg" className="bg-blue-600 hover:bg-blue-700 font-bold rounded-xl px-8">
                    <Link href="/markets">Start Trading</Link>
                  </Button>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-slate-800/50 hover:bg-transparent bg-slate-900/10">
                        <TableHead className="text-slate-500 text-[10px] uppercase font-black tracking-widest px-8 h-12">Market</TableHead>
                        <TableHead className="text-slate-500 text-[10px] uppercase font-black tracking-widest h-12">Side</TableHead>
                        <TableHead className="text-slate-500 text-[10px] uppercase font-black tracking-widest text-right h-12">Holdings</TableHead>
                        <TableHead className="text-slate-500 text-[10px] uppercase font-black tracking-widest text-right h-12">Avg Entry</TableHead>
                        <TableHead className="text-slate-500 text-[10px] uppercase font-black tracking-widest text-right h-12">Curr. Value</TableHead>
                        <TableHead className="text-slate-500 text-[10px] uppercase font-black tracking-widest text-right h-12">Unrealized P&amp;L</TableHead>
                        <TableHead className="text-slate-500 text-[10px] uppercase font-black tracking-widest text-right h-12">Realized P&amp;L</TableHead>
                        <TableHead className="text-slate-500 text-[10px] uppercase font-black tracking-widest h-12">Status</TableHead>
                        <TableHead className="text-slate-500 text-[10px] uppercase font-black tracking-widest text-right px-8 h-12">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {holdings.map((holding) => {
                        const meta = ASSET_META[holding.ticker];
                        return (
                          <TableRow key={holding.marketId} className="border-slate-800/30 hover:bg-slate-800/10 transition-colors">
                            <TableCell className="py-5 px-8">
                              <div className="flex items-center gap-3">
                                <TickerLogo ticker={holding.ticker} size={32} />
                                <div className="flex flex-col">
                                  <span className="font-bold text-white font-outfit">{holding.ticker}</span>
                                  <span className="text-[10px] text-slate-500 uppercase font-black tracking-tighter tabular-nums">
                                    Above ${holding.strikePrice.toLocaleString()}
                                  </span>
                                </div>
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="flex gap-1.5 flex-wrap">
                                {holding.yesBalance > 0n && (
                                  <Badge className="bg-blue-500/10 text-blue-400 border-blue-500/20 text-[10px] py-0.5 px-2.5 rounded-md font-black">
                                    YES ×{holding.yesBalance.toString()}
                                  </Badge>
                                )}
                                {holding.noBalance > 0n && (
                                  <Badge className="bg-red-500/10 text-red-400 border-red-500/20 text-[10px] py-0.5 px-2.5 rounded-md font-black">
                                    NO ×{holding.noBalance.toString()}
                                  </Badge>
                                )}
                              </div>
                            </TableCell>
                            <TableCell className="text-right py-5 font-mono text-sm text-slate-300">
                              {(Number(holding.yesBalance) + Number(holding.noBalance)).toLocaleString()}
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm">
                              {holding.avgEntryPriceCents != null
                                ? <span className="text-slate-300">{holding.avgEntryPriceCents.toFixed(0)}¢</span>
                                : <span className="text-slate-600">N/A</span>
                              }
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm">
                              {holding.impliedValue != null
                                ? <span className="text-slate-300">${holding.impliedValue.toFixed(2)}</span>
                                : <span className="text-slate-600">—</span>
                              }
                            </TableCell>
                            <TableCell className={`text-right font-mono text-sm font-bold ${pnlColor(holding.unrealizedPnl)}`}>
                              {holding.settled ? '—' : formatPnl(holding.unrealizedPnl)}
                            </TableCell>
                            <TableCell className={`text-right font-mono text-sm font-bold ${pnlColor(holding.realizedPnl)}`}>
                              {formatPnl(holding.realizedPnl)}
                            </TableCell>
                            <TableCell>
                              {holding.settled ? (
                                <div className="flex flex-col gap-1">
                                  <Badge variant="secondary" className="bg-[#1a1c23] text-slate-400 text-[10px] border-slate-700/50 uppercase font-black w-fit">
                                    Settled
                                  </Badge>
                                  {holding.yesWins ? (
                                    <span className="text-[9px] text-green-400 font-black uppercase tracking-widest">YES wins</span>
                                  ) : (
                                    <span className="text-[9px] text-red-400 font-black uppercase tracking-widest">NO wins</span>
                                  )}
                                </div>
                              ) : (
                                <div className="flex items-center gap-2">
                                  <div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                                  <span className="text-blue-400 text-[10px] font-black uppercase tracking-widest bg-blue-500/5 px-2 py-0.5 rounded border border-blue-500/20">
                                    Live
                                  </span>
                                </div>
                              )}
                            </TableCell>
                            <TableCell className="text-right py-5 px-8">
                              {holding.settled ? (
                                <RedeemButton marketId={holding.marketId} />
                              ) : (
                                <Button variant="ghost" size="sm" asChild className="text-slate-400 hover:text-white hover:bg-slate-800 font-black text-[10px] uppercase tracking-widest">
                                  <Link href={`/market/${holding.marketId}`}>Trade</Link>
                                </Button>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          {tradeEvents.length === 0 && !isLoadingHistory && (
            <div className="text-center py-6">
              <p className="text-[11px] text-slate-600 font-bold uppercase tracking-widest">
                P&amp;L columns show N/A until the new contracts with OrderFilled events are deployed.
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
