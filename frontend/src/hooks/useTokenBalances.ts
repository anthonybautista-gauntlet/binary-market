'use client';

import { useReadContracts, useAccount } from 'wagmi';
import { keccak256, encodeAbiParameters, parseAbiParameters } from 'viem';
import MeridianMarketABI from '@/lib/abi/MeridianMarket.json';

const MARKET_ADDRESS = process.env.NEXT_PUBLIC_MERIDIAN_MARKET_ADDRESS as `0x${string}`;

export function useTokenBalances(marketId?: `0x${string}`) {
  const { address, isConnected } = useAccount();

  const noId = marketId
    ? BigInt(
        keccak256(
          encodeAbiParameters(parseAbiParameters('bytes32, string'), [marketId, 'NO'])
        )
      )
    : 0n;

  const { data, isLoading, refetch } = useReadContracts({
    contracts: [
      {
        address: MARKET_ADDRESS,
        abi: MeridianMarketABI.abi as any,
        functionName: 'balanceOf',
        args: [address, marketId ? BigInt(marketId) : 0n],
      },
      {
        address: MARKET_ADDRESS,
        abi: MeridianMarketABI.abi as any,
        functionName: 'balanceOf',
        args: [address, noId],
      },
      {
        address: MARKET_ADDRESS,
        abi: MeridianMarketABI.abi as any,
        functionName: 'isApprovedForAll',
        args: [address, MARKET_ADDRESS],
      },
    ],
    query: {
      enabled: isConnected && !!address && !!marketId,
      refetchInterval: 5000,
    },
  });

  const yesBalance = (data?.[0]?.result as bigint) ?? 0n;
  const noBalance = (data?.[1]?.result as bigint) ?? 0n;
  const isApprovedForAll = (data?.[2]?.result as boolean) ?? false;

  return {
    yesBalance,
    noBalance,
    isApprovedForAll,
    isLoading,
    refetch,
  };
}
