'use client';

import { useState, useCallback } from 'react';
import { useWriteContract, useAccount } from 'wagmi';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useMockUSDC } from '@/hooks/useContracts';
import { useUSDCData } from '@/hooks/useUSDCData';
import { useTokenBalances } from '@/hooks/useTokenBalances';
import MeridianMarketABI from '@/lib/abi/MeridianMarket.json';
import {
  Loader2,
  Zap,
  Info,
  AlertTriangle,
  CheckCircle2,
  TrendingUp,
  TrendingDown,
  Layers,
  ArrowUpRight,
  ArrowDownLeft,
} from 'lucide-react';

interface TradePanelProps {
  marketId: `0x${string}`;
  ticker?: string;
  strikePrice?: number;
  /** When true, all trade actions are disabled (market has settled). */
  settled?: boolean;
  /** Unix seconds; trading is disabled when current time >= expiry (contract rejects). */
  expiryTimestamp?: bigint;
}

const MARKET_ADDRESS = process.env.NEXT_PUBLIC_MERIDIAN_MARKET_ADDRESS as `0x${string}`;

// Map contract error selectors to human-readable messages
const ERROR_MESSAGES: Record<string, string> = {
  MarketExpired: 'This market has already expired.',
  MarketNotFound: 'Market not found.',
  ZeroQuantity: 'Quantity must be greater than zero.',
  InvalidPrice: 'Price must be between 1 and 99 cents.',
  InsufficientProceed: 'Insufficient liquidity — no bids at your minimum price.',
  SelfTradeNotAllowed: 'You cannot trade against your own orders.',
  'User rejected': 'Transaction rejected by wallet.',
};

function parseContractError(err: unknown): string {
  const msg = String(err);
  for (const [key, human] of Object.entries(ERROR_MESSAGES)) {
    if (msg.includes(key)) return human;
  }
  if (msg.includes('insufficient funds') || msg.includes('InsufficientBalance')) {
    return 'Insufficient USDC balance.';
  }
  return 'Transaction failed. Check your balance and try again.';
}

interface PositionBlockProps {
  side: 'yes' | 'no';
  balance: bigint;
  onSwitchTab: (tab: string) => void;
}

function PositionBlock({ side, balance, onSwitchTab }: PositionBlockProps) {
  const holdingSide = side === 'yes' ? 'YES' : 'NO';
  const requiredAction = side === 'yes' ? 'Sell YES' : 'Sell NO';
  const switchTo = side === 'yes' ? 'sell-yes' : 'sell-no';
  const bgColor = side === 'yes' ? 'bg-blue-500/8 border-blue-500/20' : 'bg-red-500/8 border-red-500/20';
  const textColor = side === 'yes' ? 'text-blue-400' : 'text-red-400';
  const btnColor = side === 'yes' ? 'bg-blue-600 hover:bg-blue-700' : 'bg-red-600 hover:bg-red-700';

  return (
    <div className={`p-5 border rounded-2xl flex flex-col gap-3 ${bgColor}`}>
      <div className="flex items-start gap-3">
        <AlertTriangle className={`w-4 h-4 mt-0.5 ${textColor} flex-shrink-0`} />
        <div>
          <p className={`text-[11px] font-bold uppercase tracking-tight ${textColor}`}>
            Position conflict
          </p>
          <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
            You hold <span className="font-bold">{balance.toString()} {holdingSide}</span> tokens for this market.
            To take the opposite side, sell your {holdingSide} position first.
          </p>
        </div>
      </div>
      <Button
        size="sm"
        onClick={() => onSwitchTab(switchTo)}
        className={`w-full ${btnColor} h-9 text-[10px] font-black uppercase tracking-widest rounded-xl`}
      >
        {requiredAction} First
      </Button>
    </div>
  );
}

export function TradePanel({ marketId, ticker, strikePrice, settled = false, expiryTimestamp }: TradePanelProps) {
  const { address } = useAccount();
  const now = Math.floor(Date.now() / 1000);
  const isExpired = expiryTimestamp != null && now >= Number(expiryTimestamp);
  const isTradingClosed = settled || isExpired;
  const { mint: mintUSDC } = useMockUSDC(address);
  const { balance, allowance, formattedBalance, hasEnoughBalance, hasEnoughAllowance, refetch: refetchUSDC } = useUSDCData();
  const { yesBalance, noBalance, isApprovedForAll, refetch: refetchBalances } = useTokenBalances(marketId);

  const { writeContractAsync } = useWriteContract();

  const [price, setPrice] = useState('50');
  const [noLimitPrice, setNoLimitPrice] = useState('60');
  const [sellYesPrice, setSellYesPrice] = useState('50');
  const [sellNoMaxPrice, setSellNoMaxPrice] = useState('50');
  const [quantity, setQuantity] = useState('10');
  const [isPending, setIsPending] = useState(false);
  const [activeTab, setActiveTab] = useState('buy-yes');
  const [txError, setTxError] = useState<string | null>(null);
  const [txSuccess, setTxSuccess] = useState<string | null>(null);

  const q = BigInt(Math.max(1, parseInt(quantity) || 1));
  const p = Math.max(1, Math.min(99, parseInt(price) || 50));
  const noLP = Math.max(1, Math.min(99, parseInt(noLimitPrice) || 60));
  const syp = Math.max(1, Math.min(99, parseInt(sellYesPrice) || 50));
  const snp = Math.max(1, Math.min(99, parseInt(sellNoMaxPrice) || 50));

  // Required amounts per tab
  const yesRequiredUsdc = q * BigInt(p) * 10000n;
  const noMarketRequiredUsdc = q * 1000000n;
  const noLimitRequiredUsdc = q * 1000000n;
  const mintRequiredUsdc = q * 1000000n;
  const sellNoRequiredUsdc = q * BigInt(snp) * 10000n;

  const refetchAll = useCallback(() => {
    refetchUSDC();
    refetchBalances();
  }, [refetchUSDC, refetchBalances]);

  const withTx = async (label: string, fn: () => Promise<void>) => {
    if (!address) return;
    setIsPending(true);
    setTxError(null);
    setTxSuccess(null);
    try {
      await fn();
      setTxSuccess(`${label} submitted successfully.`);
      setTimeout(() => setTxSuccess(null), 5000);
      refetchAll();
    } catch (e) {
      setTxError(parseContractError(e));
    } finally {
      setIsPending(false);
    }
  };

  const ensureUSDCApproval = async (required: bigint) => {
    if (!hasEnoughAllowance(required)) {
      await writeContractAsync({
        address: process.env.NEXT_PUBLIC_MOCK_USDC_ADDRESS as `0x${string}`,
        abi: (await import('@/lib/abi/MockUSDC.json')).default.abi as any,
        functionName: 'approve',
        args: [MARKET_ADDRESS, BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')],
      });
    }
  };

  const ensureTokenApproval = async () => {
    if (!isApprovedForAll) {
      await writeContractAsync({
        address: MARKET_ADDRESS,
        abi: MeridianMarketABI.abi as any,
        functionName: 'setApprovalForAll',
        args: [MARKET_ADDRESS, true],
      });
    }
  };

  // ── Buy YES (limit bid) ──
  const handleBuyYes = () =>
    withTx('Buy YES', async () => {
      if (!hasEnoughBalance(yesRequiredUsdc)) throw new Error('InsufficientBalance');
      await ensureUSDCApproval(yesRequiredUsdc);
      await writeContractAsync({
        address: MARKET_ADDRESS,
        abi: MeridianMarketABI.abi as any,
        functionName: 'placeOrder',
        args: [marketId, 0, p, q, false],
      });
    });

  // ── Buy NO (market) ──
  const handleBuyNoMarket = () =>
    withTx('Buy NO', async () => {
      if (!hasEnoughBalance(noMarketRequiredUsdc)) throw new Error('InsufficientBalance');
      await ensureUSDCApproval(noMarketRequiredUsdc);
      await writeContractAsync({
        address: MARKET_ADDRESS,
        abi: MeridianMarketABI.abi as any,
        functionName: 'buyNoMarket',
        args: [marketId, q, 0n, 100],
      });
    });

  // ── Buy NO (limit) ──
  const handleBuyNoLimit = () =>
    withTx('Buy NO (limit)', async () => {
      if (!hasEnoughBalance(noLimitRequiredUsdc)) throw new Error('InsufficientBalance');
      await ensureUSDCApproval(noLimitRequiredUsdc);
      await writeContractAsync({
        address: MARKET_ADDRESS,
        abi: MeridianMarketABI.abi as any,
        functionName: 'buyNoLimit',
        args: [marketId, q, noLP],
      });
    });

  // ── Sell YES (limit ask) ──
  const handleSellYes = () =>
    withTx('Sell YES', async () => {
      if (yesBalance < q) throw new Error('Insufficient YES tokens');
      await ensureTokenApproval();
      await writeContractAsync({
        address: MARKET_ADDRESS,
        abi: MeridianMarketABI.abi as any,
        functionName: 'placeOrder',
        args: [marketId, 1, syp, q, false],
      });
    });

  // ── Sell NO (market) ──
  const handleSellNo = () =>
    withTx('Sell NO', async () => {
      if (noBalance < q) throw new Error('Insufficient NO tokens');
      if (!hasEnoughBalance(sellNoRequiredUsdc)) throw new Error('InsufficientBalance');
      await ensureTokenApproval();
      await ensureUSDCApproval(sellNoRequiredUsdc);
      await writeContractAsync({
        address: MARKET_ADDRESS,
        abi: MeridianMarketABI.abi as any,
        functionName: 'sellNoMarket',
        args: [marketId, q, snp, 100],
      });
    });

  // ── Mint Pair ──
  const handleMintPair = () =>
    withTx('Mint Pair', async () => {
      if (!hasEnoughBalance(mintRequiredUsdc)) throw new Error('InsufficientBalance');
      await ensureUSDCApproval(mintRequiredUsdc);
      await writeContractAsync({
        address: MARKET_ADDRESS,
        abi: MeridianMarketABI.abi as any,
        functionName: 'mintPair',
        args: [marketId, q],
      });
    });

  const insufficientBalance = (required: bigint) =>
    address && !hasEnoughBalance(required);
  const insufficientYes = address && yesBalance < q;
  const insufficientNo = address && noBalance < q;

  const payoffLine = ticker && strikePrice
    ? `You win $1.00 if ${ticker} closes above $${strikePrice.toLocaleString()}`
    : null;

  return (
    <div className="bg-[#0b0e11] border border-slate-800 rounded-3xl p-6 h-fit sticky top-24 backdrop-blur-xl shadow-2xl shadow-blue-500/5">
      {/* USDC Balance Header */}
      {address && (
        <div className="mb-5 px-3 py-2.5 bg-slate-900/50 rounded-xl border border-slate-800/50 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.5)]" />
              <span className="text-[10px] uppercase font-black text-slate-500 tracking-widest">USDC Balance</span>
            </div>
            <span className="text-white font-mono font-bold text-sm">${formattedBalance}</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg border border-blue-500/20 bg-blue-500/8 px-2 py-1.5">
              <p className="text-[9px] text-blue-400 font-black uppercase tracking-widest">YES Held</p>
              <p className="text-sm font-mono font-bold text-white">{yesBalance.toString()}</p>
            </div>
            <div className="rounded-lg border border-red-500/20 bg-red-500/8 px-2 py-1.5">
              <p className="text-[9px] text-red-400 font-black uppercase tracking-widest">NO Held</p>
              <p className="text-sm font-mono font-bold text-white">{noBalance.toString()}</p>
            </div>
          </div>
        </div>
      )}

      {/* Market closed: no new trades */}
      {isTradingClosed && (
        <div className="mb-4 p-4 bg-slate-700/30 border border-slate-600/50 rounded-xl flex items-start gap-3">
          <CheckCircle2 className="w-4 h-4 text-slate-400 mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-[11px] font-black uppercase tracking-widest text-slate-400">
              {settled ? 'Market settled' : 'Market expired'}
            </p>
            <p className="text-[11px] text-slate-500 mt-1">
              {settled
                ? 'Trading is closed. Redeem winning tokens from your portfolio.'
                : 'This market has passed its expiry. No new orders or mints allowed.'}
            </p>
          </div>
        </div>
      )}

      {/* Status banners */}
      {txError && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-xl flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 text-red-400 mt-0.5 flex-shrink-0" />
          <p className="text-[11px] text-red-400 font-bold">{txError}</p>
        </div>
      )}
      {txSuccess && (
        <div className="mb-4 p-3 bg-green-500/10 border border-green-500/20 rounded-xl flex items-start gap-2">
          <CheckCircle2 className="w-3.5 h-3.5 text-green-400 mt-0.5 flex-shrink-0" />
          <p className="text-[11px] text-green-400 font-bold">{txSuccess}</p>
        </div>
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid grid-cols-3 w-full bg-[#1a1c23] p-1 mb-1 rounded-2xl border border-slate-800/50 h-10">
          <TabsTrigger value="buy-yes" className="data-[state=active]:bg-blue-600 data-[state=active]:text-white rounded-xl transition-all font-black text-[9px] tracking-widest uppercase h-full flex items-center gap-1">
            <TrendingUp className="w-3 h-3" />Buy YES
          </TabsTrigger>
          <TabsTrigger value="buy-no" className="data-[state=active]:bg-red-600 data-[state=active]:text-white rounded-xl transition-all font-black text-[9px] tracking-widest uppercase h-full flex items-center gap-1">
            <TrendingDown className="w-3 h-3" />Buy NO
          </TabsTrigger>
          <TabsTrigger value="buy-no-limit" className="data-[state=active]:bg-purple-600 data-[state=active]:text-white rounded-xl transition-all font-black text-[9px] tracking-widest uppercase h-full flex items-center gap-1">
            <Zap className="w-3 h-3" />NO Limit
          </TabsTrigger>
        </TabsList>
        <TabsList className="grid grid-cols-3 w-full bg-[#1a1c23] p-1 mb-6 rounded-2xl border border-slate-800/50 h-10">
          <TabsTrigger value="sell-yes" className="data-[state=active]:bg-slate-600 data-[state=active]:text-white rounded-xl transition-all font-black text-[9px] tracking-widest uppercase h-full flex items-center gap-1">
            <TrendingDown className="w-3 h-3" />Sell YES
          </TabsTrigger>
          <TabsTrigger value="sell-no" className="data-[state=active]:bg-orange-600 data-[state=active]:text-white rounded-xl transition-all font-black text-[9px] tracking-widest uppercase h-full flex items-center gap-1">
            <TrendingUp className="w-3 h-3" />Sell NO
          </TabsTrigger>
          <TabsTrigger value="lp" className="data-[state=active]:bg-slate-700 data-[state=active]:text-white rounded-xl transition-all font-black text-[9px] tracking-widest uppercase h-full flex items-center gap-1">
            <Layers className="w-3 h-3" />Mint
          </TabsTrigger>
        </TabsList>

        {/* ── BUY YES ── */}
        <TabsContent value="buy-yes" className="space-y-5 outline-none">
          {noBalance > 0n ? (
            <PositionBlock side="no" balance={noBalance} onSwitchTab={setActiveTab} />
          ) : (
            <>
              <PriceQtyFields
                priceId="price-yes" priceLabel="Limit Price (¢)" priceValue={price} onPriceChange={setPrice}
                qtyId="qty-yes" qtyLabel="Order Size" qtyValue={quantity} onQtyChange={setQuantity}
                qtyUnit="YES Tokens" focusColor="blue"
              />
              {payoffLine && (
                <p className="text-[10px] text-slate-500 px-1 leading-relaxed">
                  <span className="text-blue-400">Payoff:</span> {payoffLine}
                </p>
              )}
              {insufficientBalance(yesRequiredUsdc) && (
                <InsufficientBalanceWarning required={yesRequiredUsdc} />
              )}
              <Button
                onClick={handleBuyYes}
                disabled={isTradingClosed || isPending || !address || !!insufficientBalance(yesRequiredUsdc)}
                className="w-full bg-blue-600 hover:bg-blue-700 h-14 text-base font-black rounded-2xl shadow-xl shadow-blue-600/20 transition-all active:scale-[0.98] uppercase tracking-widest"
              >
                {isPending ? <Loader2 className="animate-spin" /> : 'Place YES Order'}
              </Button>
              <EstimatedOutlay label="Cost" amount={Number(q) * p / 100} />
            </>
          )}
        </TabsContent>

        {/* ── BUY NO (MARKET) ── */}
        <TabsContent value="buy-no" className="space-y-5 outline-none">
          {yesBalance > 0n ? (
            <PositionBlock side="yes" balance={yesBalance} onSwitchTab={setActiveTab} />
          ) : (
            <>
              <div className="p-4 bg-red-500/5 border border-red-500/10 rounded-2xl flex items-start gap-3">
                <Zap className="w-4 h-4 text-red-500 fill-red-500/20 mt-0.5 flex-shrink-0" />
                <p className="text-[11px] text-red-400 leading-relaxed font-bold tracking-tight uppercase">
                  Market order: mints pairs + immediately sells YES at market price.
                </p>
              </div>
              <QtyField id="qty-no" label="Order Size" value={quantity} onChange={setQuantity} unit="NO Tokens" focusColor="red" />
              {insufficientBalance(noMarketRequiredUsdc) && (
                <InsufficientBalanceWarning required={noMarketRequiredUsdc} />
              )}
              <Button
                onClick={handleBuyNoMarket}
                disabled={isTradingClosed || isPending || !address || !!insufficientBalance(noMarketRequiredUsdc)}
                className="w-full bg-red-600 hover:bg-red-700 h-14 text-base font-black rounded-2xl shadow-xl shadow-red-600/20 transition-all active:scale-[0.98] uppercase tracking-widest"
              >
                {isPending ? <Loader2 className="animate-spin" /> : 'Buy NO (Market)'}
              </Button>
              <EstimatedOutlay label="Max Cost" amount={Number(q)} note="(minus YES sale proceeds)" />
            </>
          )}
        </TabsContent>

        {/* ── SELL YES ── */}
        <TabsContent value="sell-yes" className="space-y-5 outline-none">
          <div className="text-[10px] text-slate-500 px-1 flex items-center gap-2">
            <span className="text-blue-400 font-bold">Balance:</span>
            <span className="font-mono font-bold text-white">{yesBalance.toString()} YES</span>
          </div>
          <PriceQtyFields
            priceId="price-sell-yes" priceLabel="Ask Price (¢)" priceValue={sellYesPrice} onPriceChange={setSellYesPrice}
            qtyId="qty-sell-yes" qtyLabel="Order Size" qtyValue={quantity} onQtyChange={setQuantity}
            qtyUnit="YES Tokens" focusColor="slate"
          />
          {insufficientYes && (
            <div className="p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-xl flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-yellow-400 mt-0.5 flex-shrink-0" />
              <p className="text-[11px] text-yellow-400 font-bold">
                You only hold {yesBalance.toString()} YES tokens.
              </p>
            </div>
          )}
          {!isApprovedForAll && address && (
            <div className="p-3 bg-slate-500/10 border border-slate-500/20 rounded-xl flex items-start gap-2">
              <Info className="w-3.5 h-3.5 text-slate-400 mt-0.5 flex-shrink-0" />
              <p className="text-[11px] text-slate-400 font-bold">
                Token approval required — will prompt before placing order.
              </p>
            </div>
          )}
          <Button
            onClick={handleSellYes}
            disabled={isTradingClosed || isPending || !address || !!insufficientYes}
            className="w-full bg-slate-600 hover:bg-slate-700 h-14 text-base font-black rounded-2xl shadow-xl shadow-slate-700/20 transition-all active:scale-[0.98] uppercase tracking-widest"
          >
            {isPending ? <Loader2 className="animate-spin" /> : 'Place Sell YES Order'}
          </Button>
          <EstimatedOutlay label="Proceeds (if filled)" amount={Number(q) * syp / 100} />
        </TabsContent>

        {/* ── SELL NO ── */}
        <TabsContent value="sell-no" className="space-y-5 outline-none">
          <div className="text-[10px] text-slate-500 px-1 flex items-center gap-2">
            <span className="text-red-400 font-bold">Balance:</span>
            <span className="font-mono font-bold text-white">{noBalance.toString()} NO</span>
          </div>
          <div className="p-4 bg-orange-500/5 border border-orange-500/10 rounded-2xl flex items-start gap-3">
            <Info className="w-4 h-4 text-orange-400 mt-0.5 flex-shrink-0" />
            <p className="text-[11px] text-orange-400 leading-relaxed font-bold tracking-tight uppercase">
              Buys YES at market price + redeems YES+NO pair for $1.00 USDC.
            </p>
          </div>
          <PriceQtyFields
            priceId="price-sell-no" priceLabel="Max YES Buy Price (¢)" priceValue={sellNoMaxPrice} onPriceChange={setSellNoMaxPrice}
            qtyId="qty-sell-no" qtyLabel="NO Tokens to Sell" qtyValue={quantity} onQtyChange={setQuantity}
            qtyUnit="NO Tokens" focusColor="orange"
          />
          {insufficientNo && (
            <div className="p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-xl flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-yellow-400 mt-0.5 flex-shrink-0" />
              <p className="text-[11px] text-yellow-400 font-bold">
                You only hold {noBalance.toString()} NO tokens.
              </p>
            </div>
          )}
          {insufficientBalance(sellNoRequiredUsdc) && (
            <InsufficientBalanceWarning required={sellNoRequiredUsdc} />
          )}
          {!isApprovedForAll && address && (
            <div className="p-3 bg-slate-500/10 border border-slate-500/20 rounded-xl flex items-start gap-2">
              <Info className="w-3.5 h-3.5 text-slate-400 mt-0.5 flex-shrink-0" />
              <p className="text-[11px] text-slate-400 font-bold">
                Token approval required — will prompt before placing order.
              </p>
            </div>
          )}
          <Button
            onClick={handleSellNo}
            disabled={isTradingClosed || isPending || !address || !!insufficientNo || !!insufficientBalance(sellNoRequiredUsdc)}
            className="w-full bg-orange-600 hover:bg-orange-700 h-14 text-base font-black rounded-2xl shadow-xl shadow-orange-700/20 transition-all active:scale-[0.98] uppercase tracking-widest"
          >
            {isPending ? <Loader2 className="animate-spin" /> : 'Sell NO (Market)'}
          </Button>
          <EstimatedOutlay label="Net Receive" amount={Number(q) * (100 - snp) / 100} note="(per pair at fill price)" />
        </TabsContent>

        {/* ── BUY NO LIMIT ── */}
        <TabsContent value="buy-no-limit" className="space-y-5 outline-none">
          {yesBalance > 0n ? (
            <PositionBlock side="yes" balance={yesBalance} onSwitchTab={setActiveTab} />
          ) : (
            <>
              <div className="p-4 bg-purple-500/5 border border-purple-500/10 rounded-2xl flex items-start gap-3">
                <Info className="w-4 h-4 text-purple-400 mt-0.5 flex-shrink-0" />
                <p className="text-[11px] text-purple-400 leading-relaxed font-bold tracking-tight uppercase">
                  Mints pairs + posts YES as resting ASK at your limit price. NO tokens received immediately.
                </p>
              </div>
              <PriceQtyFields
                priceId="price-no-limit" priceLabel="YES Ask Price (¢)" priceValue={noLimitPrice} onPriceChange={setNoLimitPrice}
                qtyId="qty-no-limit" qtyLabel="NO Tokens to Acquire" qtyValue={quantity} onQtyChange={setQuantity}
                qtyUnit="NO Tokens" focusColor="purple"
              />
              {insufficientBalance(noLimitRequiredUsdc) && (
                <InsufficientBalanceWarning required={noLimitRequiredUsdc} />
              )}
              <Button
                onClick={handleBuyNoLimit}
                disabled={isTradingClosed || isPending || !address || !!insufficientBalance(noLimitRequiredUsdc)}
                className="w-full bg-purple-600 hover:bg-purple-700 h-14 text-base font-black rounded-2xl shadow-xl shadow-purple-700/20 transition-all active:scale-[0.98] uppercase tracking-widest"
              >
                {isPending ? <Loader2 className="animate-spin" /> : 'Buy NO (Limit)'}
              </Button>
              <EstimatedOutlay label="Upfront Cost" amount={Number(q)} note={`(recover ${(Number(q) * noLP / 100).toFixed(2)} USDC when YES fills)`} />
            </>
          )}
        </TabsContent>

        {/* ── MINT PAIR ── */}
        <TabsContent value="lp" className="space-y-5 outline-none">
          <div className="p-4 bg-slate-500/5 border border-slate-500/10 rounded-2xl flex items-start gap-3">
            <Layers className="w-4 h-4 text-slate-400 mt-0.5 flex-shrink-0" />
            <p className="text-[11px] text-slate-400 leading-relaxed font-bold tracking-tight uppercase">
              Deposit $1.00 USDC per pair → receive 1 YES + 1 NO token. Used by liquidity providers.
            </p>
          </div>
          <QtyField id="qty-lp" label="Pairs to Mint" value={quantity} onChange={setQuantity} unit="Pairs" focusColor="slate" />
          {insufficientBalance(mintRequiredUsdc) && (
            <InsufficientBalanceWarning required={mintRequiredUsdc} />
          )}
          <Button
            onClick={handleMintPair}
            disabled={isTradingClosed || isPending || !address || !!insufficientBalance(mintRequiredUsdc)}
            className="w-full bg-slate-700 hover:bg-slate-800 h-14 text-base font-black rounded-2xl shadow-xl shadow-slate-700/20 transition-all active:scale-[0.98] uppercase tracking-widest"
          >
            {isPending ? <Loader2 className="animate-spin" /> : 'Mint YES/NO Pairs'}
          </Button>
          <EstimatedOutlay label="Cost" amount={Number(q)} note="($1.00 per pair)" />
        </TabsContent>
      </Tabs>

      <div className="mt-6 pt-5 border-t border-slate-800/50 flex flex-col gap-3">
        {!address ? (
          <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-3 text-center">
            <p className="text-[10px] text-blue-400 font-black uppercase tracking-widest animate-pulse">
              Connect wallet to trade
            </p>
          </div>
        ) : (
          <Button
            variant="outline"
            onClick={mintUSDC}
            className="w-full border-slate-800 text-slate-400 hover:text-white hover:bg-slate-800 h-10 font-black text-[10px] uppercase tracking-widest rounded-xl transition-all"
          >
            Mint Test Collateral (1,000 USDC)
          </Button>
        )}
      </div>
    </div>
  );
}

// ── Shared sub-components ──────────────────────────────────────────────────

function PriceQtyFields({
  priceId, priceLabel, priceValue, onPriceChange,
  qtyId, qtyLabel, qtyValue, onQtyChange, qtyUnit, focusColor,
}: {
  priceId: string; priceLabel: string; priceValue: string; onPriceChange: (v: string) => void;
  qtyId: string; qtyLabel: string; qtyValue: string; onQtyChange: (v: string) => void;
  qtyUnit: string; focusColor: string;
}) {
  return (
    <>
      <div className="space-y-2">
        <div className="flex justify-between items-center px-1">
          <Label htmlFor={priceId} className="text-[10px] uppercase font-black text-slate-500 tracking-[0.2em]">{priceLabel}</Label>
          <span className="text-[10px] text-slate-600 font-mono">1–99</span>
        </div>
        <div className="relative">
          <Input
            id={priceId}
            type="number"
            min="1" max="99"
            value={priceValue}
            onChange={(e) => onPriceChange(e.target.value)}
            className={`bg-[#15181e] border-slate-800 h-14 text-2xl font-mono focus:ring-${focusColor}-500/20 rounded-2xl font-bold`}
          />
          <div className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500 font-black uppercase text-xs tracking-widest pointer-events-none">¢</div>
        </div>
      </div>
      <QtyField id={qtyId} label={qtyLabel} value={qtyValue} onChange={onQtyChange} unit={qtyUnit} focusColor={focusColor} />
    </>
  );
}

function QtyField({ id, label, value, onChange, unit, focusColor }: {
  id: string; label: string; value: string; onChange: (v: string) => void; unit: string; focusColor: string;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-[10px] uppercase font-black text-slate-500 tracking-[0.2em] px-1">{label}</Label>
      <div className="relative">
        <Input
          id={id}
          type="number"
          min="1"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`bg-[#15181e] border-slate-800 h-14 text-2xl font-mono focus:ring-${focusColor}-500/20 rounded-2xl font-bold`}
        />
        <div className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500 font-black uppercase text-[9px] tracking-widest pointer-events-none">{unit}</div>
      </div>
    </div>
  );
}

function EstimatedOutlay({ label, amount, note }: { label: string; amount: number; note?: string }) {
  return (
    <div className="flex items-baseline justify-between px-1">
      <span className="text-[9px] text-slate-600 uppercase font-black tracking-widest">{label}</span>
      <div className="text-right">
        <span className="text-white font-mono font-bold">${amount.toFixed(2)} </span>
        <span className="text-[9px] text-slate-500">USDC</span>
        {note && <p className="text-[9px] text-slate-600">{note}</p>}
      </div>
    </div>
  );
}

function InsufficientBalanceWarning({ required }: { required: bigint }) {
  const amountStr = (Number(required) / 1e6).toFixed(2);
  return (
    <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl flex items-start gap-2">
      <AlertTriangle className="w-3.5 h-3.5 text-red-400 mt-0.5 flex-shrink-0" />
      <p className="text-[11px] text-red-400 font-bold">
        Insufficient USDC balance. Need ${amountStr} — mint test collateral below.
      </p>
    </div>
  );
}
