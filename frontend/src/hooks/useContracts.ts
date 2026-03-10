'use client';

import { useReadContract, useWriteContract } from 'wagmi';
import MeridianMarketABI from '@/lib/abi/MeridianMarket.json';
import MockUSDCABI from '@/lib/abi/MockUSDC.json';
import { parseUnits, hexToString } from 'viem';

const MARKET_ADDRESS = process.env.NEXT_PUBLIC_MERIDIAN_MARKET_ADDRESS as `0x${string}`;
const USDC_ADDRESS = process.env.NEXT_PUBLIC_MOCK_USDC_ADDRESS as `0x${string}`;

export function useMeridianMarket() {
  const { data: marketCount } = useReadContract({
    address: MARKET_ADDRESS,
    abi: MeridianMarketABI.abi,
    functionName: 'marketCount',
  });

  const { data: markets, isLoading: isLoadingMarkets } = useReadContract({
    address: MARKET_ADDRESS,
    abi: MeridianMarketABI.abi,
    functionName: 'getMarkets',
    args: [marketCount ? BigInt(marketCount as any) : 0n],
    query: {
      enabled: !!marketCount && Number(marketCount) > 0,
    }
  });

  const parsedMarkets = (markets as any[])?.map(m => ({
    ...m,
    ticker: hexToString(m.ticker, { size: 32 }).replace(/\0/g, ''),
  })) || [];

  return {
    marketCount: marketCount ? Number(marketCount) : 0,
    markets: parsedMarkets,
    isLoadingMarkets,
    address: MARKET_ADDRESS,
  };
}

export function useMarket(marketId?: `0x${string}`) {
  const { data: market, isLoading } = useReadContract({
    address: MARKET_ADDRESS,
    abi: MeridianMarketABI.abi,
    functionName: 'markets',
    args: [marketId],
    query: {
      enabled: !!marketId,
    }
  });

  // viem v2 returns a named-property *object* (not an array) for functions with
  // multiple named outputs. We support both the object form (viem v2) and the
  // legacy array form so this continues to work regardless of viem version.
  const m = market as any;
  const parsedMarket = m ? {
    ticker: hexToString(m.ticker ?? m[0], { size: 32 }).replace(/\0/g, ''),
    strikePrice: (m.strikePrice ?? m[1]) as bigint,
    pythFeedId: (m.pythFeedId ?? m[2]) as `0x${string}`,
    expiryTimestamp: (m.expiryTimestamp ?? m[3]) as bigint,
    totalPairsMinted: (m.totalPairsMinted ?? m[4]) as bigint,
    vaultBalance: (m.vaultBalance ?? m[5]) as bigint,
    feeBpsSnapshot: Number(m.feeBpsSnapshot ?? m[6]),
    settled: Boolean(m.settled ?? m[7]),
    yesWins: Boolean(m.yesWins ?? m[8]),
  } : null;

  return {
    market: parsedMarket,
    isLoading,
  };
}

export function useMockUSDC(address?: `0x${string}`) {
  const { writeContractAsync: mint } = useWriteContract();
  const { writeContractAsync: approve } = useWriteContract();

  const handleMint = async () => {
    return mint({
      address: USDC_ADDRESS,
      abi: MockUSDCABI.abi,
      functionName: 'mint',
      args: [address, parseUnits('1000', 6)], 
    });
  };

  const handleApprove = async (spender: `0x${string}`, amount: bigint) => {
    return approve({
      address: USDC_ADDRESS,
      abi: MockUSDCABI.abi,
      functionName: 'approve',
      args: [spender, amount],
    });
  };

  return {
    address: USDC_ADDRESS,
    mint: handleMint,
    approve: handleApprove,
  };
}
