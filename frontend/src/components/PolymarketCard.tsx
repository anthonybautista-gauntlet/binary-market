'use client';

import { usePolymarketEvent } from '@/hooks/usePolymarket';
import {
  buildPolymarketSlug,
  buildPolymarketEventUrl,
  buildPolymarketStrikeUrl,
  findMatchingMarket,
  findNearestMarket,
  parseYesProbability,
  marketVolume,
  eventVolume24h,
  eventLiquidity,
  type PolymarketSubMarket,
} from '@/lib/polymarket';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ExternalLink } from 'lucide-react';

function StrikeRow({
  market,
  eventSlug,
  matchLabel,
}: {
  market: PolymarketSubMarket;
  eventSlug: string;
  matchLabel?: 'match' | 'nearest';
}) {
  const yesProb = parseYesProbability(market.outcomePrices);
  const strike = market.groupItemTitle;
  const url = buildPolymarketStrikeUrl(eventSlug, market.slug);

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={`flex items-center justify-between text-sm py-2 px-2 -mx-2 rounded-lg transition-colors hover:bg-slate-800/60 ${
        matchLabel ? 'bg-slate-800/40 ring-1 ring-purple-500/30' : ''
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="font-mono font-bold text-slate-200">{strike}</span>
        {matchLabel === 'match' && (
          <span className="text-[9px] uppercase font-black tracking-widest text-purple-400">
            Match
          </span>
        )}
        {matchLabel === 'nearest' && (
          <span className="text-[9px] uppercase font-black tracking-widest text-slate-500">
            Nearest
          </span>
        )}
      </div>
      <div className="flex items-center gap-3">
        <span className="font-mono font-bold text-emerald-400">
          {(yesProb * 100).toFixed(1)}%
        </span>
        <span className="text-[10px] text-slate-500 font-mono w-16 text-right">
          ${Math.round(marketVolume(market)).toLocaleString()}
        </span>
      </div>
    </a>
  );
}

interface PolymarketCardProps {
  ticker: string;
  expiryTimestamp: bigint;
  /** Meridian strike price in whole dollars (e.g. 250) for highlighting */
  strikeDollars?: number;
}

export function PolymarketCard({
  ticker,
  expiryTimestamp,
  strikeDollars,
}: PolymarketCardProps) {
  const { data: event, isLoading } = usePolymarketEvent(ticker, expiryTimestamp);
  const slug = buildPolymarketSlug(ticker, expiryTimestamp);
  const eventUrl = buildPolymarketEventUrl(slug);

  if (isLoading) {
    return (
      <Card className="bg-slate-900/40 border-slate-800">
        <CardHeader className="pb-2">
          <Skeleton className="h-4 w-32 bg-slate-800" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-20 bg-slate-800 rounded-lg" />
        </CardContent>
      </Card>
    );
  }

  if (!event || !event.markets || event.markets.length === 0) {
    return null;
  }

  const sortedMarkets = [...event.markets].sort((a, b) => {
    const aStrike = parseInt(a.groupItemTitle.replace('$', ''), 10);
    const bStrike = parseInt(b.groupItemTitle.replace('$', ''), 10);
    return aStrike - bStrike;
  });

  const exactMatch = strikeDollars
    ? findMatchingMarket(sortedMarkets, strikeDollars)
    : undefined;

  const nearestMarket =
    strikeDollars && !exactMatch
      ? findNearestMarket(sortedMarkets, strikeDollars)
      : undefined;

  function labelFor(m: PolymarketSubMarket): 'match' | 'nearest' | undefined {
    if (!strikeDollars) return undefined;
    const pmStrike = parseInt(m.groupItemTitle.replace('$', ''), 10);
    if (pmStrike === strikeDollars) return 'match';
    if (nearestMarket && m.id === nearestMarket.id) return 'nearest';
    return undefined;
  }

  return (
    <Card className="bg-slate-900/40 border-slate-800 border-purple-500/10">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <PolymarketLogo />
            <CardTitle className="text-sm font-outfit text-slate-300">
              Polymarket
            </CardTitle>
          </div>
          <a
            href={eventUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-purple-400 hover:text-purple-300 flex items-center gap-1 font-semibold transition-colors"
          >
            View All <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      </CardHeader>
      <CardContent className="space-y-1">
        <div className="flex items-center justify-between text-[10px] text-slate-600 uppercase tracking-widest font-black mb-1 px-2 -mx-2">
          <span>Strike</span>
          <div className="flex gap-3">
            <span>YES %</span>
            <span className="w-16 text-right">Volume</span>
          </div>
        </div>

        {sortedMarkets.map(m => (
          <StrikeRow
            key={m.id}
            market={m}
            eventSlug={slug}
            matchLabel={labelFor(m)}
          />
        ))}

        <div className="flex items-center justify-between pt-2 border-t border-slate-800/50 text-[10px] text-slate-500">
          <span>
            24h Vol: <span className="text-slate-400 font-mono">${Math.round(eventVolume24h(event)).toLocaleString()}</span>
          </span>
          <span>
            Liquidity: <span className="text-slate-400 font-mono">${Math.round(eventLiquidity(event)).toLocaleString()}</span>
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Inline SVG-based Polymarket logo — a simple "P" glyph in a rounded square
 * so we don't need to ship an external image asset.
 */
function PolymarketLogo() {
  return (
    <div className="w-5 h-5 rounded bg-purple-500/20 border border-purple-500/30 flex items-center justify-center">
      <span className="text-[10px] font-black text-purple-400 leading-none">P</span>
    </div>
  );
}

/**
 * Lightweight Polymarket external link for market listing cards.
 * Renders a small clickable badge that links to the Polymarket event page.
 */
export function PolymarketBadge({
  ticker,
  expiryTimestamp,
}: {
  ticker: string;
  expiryTimestamp: bigint;
}) {
  const slug = buildPolymarketSlug(ticker, expiryTimestamp);
  const url = buildPolymarketEventUrl(slug);

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title="View on Polymarket"
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-purple-500/10 border border-purple-500/20 text-purple-400 hover:bg-purple-500/20 hover:text-purple-300 transition-colors text-[10px] font-bold"
      onClick={e => e.stopPropagation()}
    >
      <PolymarketLogo />
      <span className="hidden sm:inline">Polymarket</span>
      <ExternalLink className="w-2.5 h-2.5" />
    </a>
  );
}
