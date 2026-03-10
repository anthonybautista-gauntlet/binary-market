import { Suspense } from 'react';
import { HistoryPageClient } from './HistoryPageClient';

type SearchParams = {
  tab?: string | string[];
  marketId?: string | string[];
};

export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const tabRaw = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab;
  const marketIdRaw = Array.isArray(sp.marketId) ? sp.marketId[0] : sp.marketId;

  return (
    <Suspense fallback={<div className="min-h-screen bg-[#0b0e11]" />}>
      <HistoryPageClient
        initialTabParam={tabRaw}
        initialMarketId={marketIdRaw ?? ''}
      />
    </Suspense>
  );
}
