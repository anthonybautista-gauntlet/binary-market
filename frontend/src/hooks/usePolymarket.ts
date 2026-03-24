'use client';

import { useQuery } from '@tanstack/react-query';
import {
  buildPolymarketSlug,
  type PolymarketEvent,
} from '@/lib/polymarket';

async function fetchPolymarketEvent(slug: string): Promise<PolymarketEvent | null> {
  const res = await fetch(`/api/polymarket/${encodeURIComponent(slug)}`);
  if (!res.ok) return null;

  const data = await res.json();
  if (!data.markets || data.markets.length === 0) return null;
  return data as PolymarketEvent;
}

/**
 * Fetches the Polymarket "closes above" event that corresponds to a
 * Meridian market identified by its ticker and expiry timestamp.
 */
export function usePolymarketEvent(ticker: string, expiryTimestamp: bigint) {
  const slug = buildPolymarketSlug(ticker, expiryTimestamp);

  return useQuery({
    queryKey: ['polymarket', slug],
    queryFn: () => fetchPolymarketEvent(slug),
    staleTime: 60_000,
    retry: 1,
    enabled: !!ticker && !!expiryTimestamp,
  });
}
