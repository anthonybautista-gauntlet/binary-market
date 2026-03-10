'use client';

import { useState } from 'react';
import { useWriteContract, useWaitForTransactionReceipt, useReadContract, useAccount } from 'wagmi';
import MeridianMarketABI from '@/lib/abi/MeridianMarket.json';
import { Button } from '@/components/ui/button';
import { Loader2, CheckCircle2 } from 'lucide-react';
import { keccak256, encodeAbiParameters, parseAbiParameters } from 'viem';

const MARKET_ADDRESS = process.env.NEXT_PUBLIC_MERIDIAN_MARKET_ADDRESS as `0x${string}`;

interface RedeemButtonProps {
  marketId: `0x${string}`;
}

export function RedeemButton({ marketId }: RedeemButtonProps) {
  const { address } = useAccount();
  const [isPending, setIsPending] = useState(false);
  const { writeContractAsync, data: hash } = useWriteContract();

  // We need to know which token to redeem and how much.
  // The contract handles the choice, but we need to pass a quantity.
  // We'll fetch the market to see who won, then fetch the according balance.
  const { data: market } = useReadContract({
    address: MARKET_ADDRESS,
    abi: MeridianMarketABI.abi,
    functionName: 'markets',
    args: [marketId],
  });

  const yesWins = market ? (market as any)[8] : false;
  const targetTokenId = yesWins 
    ? BigInt(marketId) 
    : BigInt(keccak256(encodeAbiParameters(parseAbiParameters('bytes32, string'), [marketId, "NO"])));

  const { data: balance } = useReadContract({
    address: MARKET_ADDRESS,
    abi: MeridianMarketABI.abi,
    functionName: 'balanceOf',
    args: [address, targetTokenId],
  });
  
  const { isLoading: isWaiting, isSuccess } = useWaitForTransactionReceipt({
    hash,
  });

  const handleRedeem = async () => {
    if (!balance || (balance as bigint) === 0n) return;
    setIsPending(true);
    try {
      await writeContractAsync({
        address: MARKET_ADDRESS,
        abi: MeridianMarketABI.abi,
        functionName: 'redeem',
        args: [marketId, balance],
      });
    } catch (e) {
      console.error(e);
    } finally {
      setIsPending(false);
    }
  };

  if (isSuccess) {
    return (
      <Button disabled className="bg-green-600/20 text-green-500 border-green-500/20 font-bold gap-2 text-xs uppercase tracking-widest h-9 px-4">
        <CheckCircle2 className="w-3 h-3" />
        Redeemed
      </Button>
    );
  }

  const hasBalance = balance && (balance as bigint) > 0n;

  return (
    <Button 
      onClick={handleRedeem} 
      disabled={isPending || isWaiting || !hasBalance}
      className="bg-green-600 hover:bg-green-700 font-bold shadow-lg shadow-green-600/20 text-xs uppercase tracking-widest h-9 px-4"
    >
      {(isPending || isWaiting) ? (
        <>
          <Loader2 className="w-3 h-3 mr-2 animate-spin" />
          Processing...
        </>
      ) : (
        'Redeem'
      )}
    </Button>
  );
}
