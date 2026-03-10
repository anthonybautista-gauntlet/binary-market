'use client';

import { useQuery } from '@tanstack/react-query';
import { PYTH_FEED_IDS, Ticker } from '@/constants/assets';

const HERMES_URL = 'https://hermes.pyth.network/v2/updates/price/latest';

interface PythPriceResponse {
  parsed: Array<{
    id: string;
    price: {
      price: string;
      conf: string;
      expo: number;
      publish_time: number;
    };
  }>;
}

export function usePythPrices() {
  const ids = Object.values(PYTH_FEED_IDS);
  
  return useQuery({
    queryKey: ['pyth-prices'],
    queryFn: async () => {
      const url = new URL(HERMES_URL);
      ids.forEach(id => url.searchParams.append('ids[]', id));
      
      const response = await fetch(url.toString());
      if (!response.ok) throw new Error('Failed to fetch Pyth prices');
      
      const data: PythPriceResponse = await response.json();
      
      const priceMap: Record<string, number> = {};
      data.parsed.forEach((item) => {
        const id = `0x${item.id}`;
        const price = Number(item.price.price) * Math.pow(10, item.price.expo);
        priceMap[id] = price;
      });
      
      return priceMap;
    },
    refetchInterval: 5000, // Poll every 5 seconds
  });
}

export function usePythPrice(ticker: Ticker) {
  const { data: prices, ...rest } = usePythPrices();
  const id = PYTH_FEED_IDS[ticker];
  const price = prices ? prices[id] : null;
  
  return { price, ...rest };
}
