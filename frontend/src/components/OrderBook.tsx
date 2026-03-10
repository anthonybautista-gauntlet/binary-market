'use client';

import { useOrderBook } from '@/hooks/useOrderBook';
import { formatUnits } from 'viem';

interface OrderBookProps {
  marketId: `0x${string}`;
}

export function OrderBook({ marketId }: OrderBookProps) {
  const { bids, asks } = useOrderBook(marketId);

  // Use raw quantity for binary tokens as they represent contract counts (0 decimals)
  const maxQuantity = Math.max(
    ...bids.map(b => Number(b.quantity)),
    ...asks.map(a => Number(a.quantity)),
    1
  );

  return (
    <div className="bg-[#0b0e11] border border-slate-800 rounded-2xl overflow-hidden flex flex-col h-[650px] shadow-2xl shadow-blue-500/5">
      <div className="p-5 border-b border-slate-800 bg-slate-900/40 backdrop-blur-sm">
        <h3 className="font-outfit font-extrabold text-sm uppercase tracking-[0.2em] text-slate-400 text-center">
            Depth Analysis
        </h3>
      </div>

      <div className="flex-grow overflow-auto font-mono">
        <div className="grid grid-cols-3 px-5 py-4 text-[11px] font-bold text-slate-500 uppercase tracking-widest border-b border-slate-800/50">
          <span>Price (¢)</span>
          <span className="text-right">Size</span>
          <span className="text-right">Total</span>
        </div>

        {/* Asks (Sells) - Red Side */}
        <div className="flex flex-col-reverse">
          {asks.slice(0, 20).map((ask, i) => {
            const runningTotal = asks.slice(0, i + 1).reduce((acc, curr) => acc + Number(curr.quantity), 0);
            return (
              <div key={ask.price} className="relative group hover:bg-red-500/5 transition-colors py-1.5 px-5 cursor-pointer">
                <div 
                  className="absolute inset-y-0 right-0 bg-red-500/10 transition-all duration-500" 
                  style={{ width: `${(Number(ask.quantity) / maxQuantity) * 100}%` }}
                />
                <div className="relative grid grid-cols-3 z-10 text-[13px]">
                  <span className="text-red-400 font-bold">{ask.price}¢</span>
                  <span className="text-slate-300 text-right font-medium">{Number(ask.quantity).toLocaleString()}</span>
                  <span className="text-slate-500 text-right text-[11px] self-center">{runningTotal.toLocaleString()}</span>
                </div>
              </div>
            );
          })}
          {asks.length === 0 && (
            <div className="py-12 flex flex-col items-center justify-center text-slate-700">
               <span className="text-[10px] uppercase font-bold tracking-widest mb-1">Liquidity Void</span>
               <span className="text-[11px] italic">No active asks</span>
            </div>
          )}
        </div>

        {/* Mid Market / Spread */}
        <div className="py-4 px-5 bg-slate-900/80 border-y border-slate-800 flex justify-between items-center border-l-4 border-l-blue-500 shadow-inner">
            <div className="flex flex-col">
                <span className="text-slate-500 uppercase text-[9px] font-black tracking-widest leading-none mb-1">Market Spread</span>
                <span className="text-white text-lg font-bold font-outfit uppercase">
                    {bids.length > 0 && asks.length > 0 ? `${asks[0].price - bids[0].price}¢` : 'Wide'}
                </span>
            </div>
            <div className="text-right">
                <span className="text-slate-500 uppercase text-[9px] font-black tracking-widest leading-none mb-1">Mid Price</span>
                <span className="text-blue-400 text-lg font-bold font-mono">
                    {bids.length > 0 && asks.length > 0 ? `${((asks[0].price + bids[0].price) / 2).toFixed(1)}¢` : '-'}
                </span>
            </div>
        </div>

        {/* Bids (Buys) - Green Side */}
        <div className="flex flex-col">
          {bids.slice(0, 20).map((bid, i) => {
            const runningTotal = bids.slice(0, i + 1).reduce((acc, curr) => acc + Number(curr.quantity), 0);
            return (
              <div key={bid.price} className="relative group hover:bg-green-500/5 transition-colors py-1.5 px-5 cursor-pointer">
                <div 
                  className="absolute inset-y-0 right-0 bg-green-500/10 transition-all duration-500" 
                  style={{ width: `${(Number(bid.quantity) / maxQuantity) * 100}%` }}
                />
                <div className="relative grid grid-cols-3 z-10 text-[13px]">
                  <span className="text-green-400 font-bold">{bid.price}¢</span>
                  <span className="text-slate-300 text-right font-medium">{Number(bid.quantity).toLocaleString()}</span>
                  <span className="text-slate-500 text-right text-[11px] self-center">{runningTotal.toLocaleString()}</span>
                </div>
              </div>
            );
          })}
          {bids.length === 0 && (
            <div className="py-12 flex flex-col items-center justify-center text-slate-700">
               <span className="text-[10px] uppercase font-bold tracking-widest mb-1">Liquidity Void</span>
               <span className="text-[11px] italic">No active bids</span>
            </div>
          )}
        </div>
      </div>

      <div className="p-4 border-t border-slate-800 bg-slate-900/60 flex items-center justify-between">
           <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Live Feed</span>
           </div>
           <span className="text-[10px] text-slate-600 font-mono">v1.2.0-secure</span>
      </div>
    </div>
  );
}
