'use client';

import { useReadContracts, useAccount } from 'wagmi';
import MockUSDCABI from '@/lib/abi/MockUSDC.json';

const USDC_ADDRESS = process.env.NEXT_PUBLIC_MOCK_USDC_ADDRESS as `0x${string}`;
const MARKET_ADDRESS = process.env.NEXT_PUBLIC_MERIDIAN_MARKET_ADDRESS as `0x${string}`;

export function useUSDCData() {
  const { address, isConnected } = useAccount();

  const { data, isLoading, refetch } = useReadContracts({
    contracts: [
      {
        address: USDC_ADDRESS,
        abi: MockUSDCABI.abi as any,
        functionName: 'balanceOf',
        args: [address],
      },
      {
        address: USDC_ADDRESS,
        abi: MockUSDCABI.abi as any,
        functionName: 'allowance',
        args: [address, MARKET_ADDRESS],
      },
    ],
    query: {
      enabled: isConnected && !!address,
      refetchInterval: 5000,
    },
  });

  const balance = (data?.[0]?.result as bigint) ?? 0n;
  const allowance = (data?.[1]?.result as bigint) ?? 0n;

  const formattedBalance = (Number(balance) / 1e6).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const isAllowanceUnlimited = allowance >= BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff') / 2n;

  const formattedAllowance = isAllowanceUnlimited
    ? 'Unlimited'
    : (Number(allowance) / 1e6).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

  const hasEnoughBalance = (required: bigint) => balance >= required;
  const hasEnoughAllowance = (required: bigint) => allowance >= required;

  return {
    balance,
    allowance,
    formattedBalance,
    formattedAllowance,
    isAllowanceUnlimited,
    hasEnoughBalance,
    hasEnoughAllowance,
    isLoading,
    refetch,
  };
}
