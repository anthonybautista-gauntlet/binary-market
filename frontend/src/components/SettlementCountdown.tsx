'use client';

import { useState, useEffect } from 'react';
import { Clock, CheckCircle2, AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

interface SettlementCountdownProps {
  expiryTimestamp: bigint; // unix seconds
  settled: boolean;
  yesWins?: boolean;
}

type MarketStatus = 'live' | 'settling' | 'settled' | 'expired';

function getStatus(expiry: number, settled: boolean): MarketStatus {
  if (settled) return 'settled';
  const now = Math.floor(Date.now() / 1000);
  if (now < expiry) return 'live';
  // Between expiry and +20 minutes = settling window
  if (now < expiry + 20 * 60) return 'settling';
  return 'expired';
}

function formatCountdown(secondsLeft: number): string {
  if (secondsLeft <= 0) return '00:00:00';
  const h = Math.floor(secondsLeft / 3600);
  const m = Math.floor((secondsLeft % 3600) / 60);
  const s = secondsLeft % 60;
  if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m`;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export function SettlementCountdown({ expiryTimestamp, settled, yesWins }: SettlementCountdownProps) {
  const expiry = Number(expiryTimestamp);
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const status = getStatus(expiry, settled);
  const secondsLeft = Math.max(0, expiry - now);

  if (status === 'settled') {
    return (
      <div className="flex items-center gap-2">
        <CheckCircle2 className="w-4 h-4 text-green-400" />
        <Badge className="bg-green-500/10 text-green-400 border-green-500/20 text-[10px] font-black uppercase tracking-widest">
          Settled — {yesWins ? 'YES wins' : 'NO wins'}
        </Badge>
      </div>
    );
  }

  if (status === 'settling') {
    return (
      <div className="flex items-center gap-2">
        <div className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse" />
        <Badge className="bg-yellow-500/10 text-yellow-400 border-yellow-500/20 text-[10px] font-black uppercase tracking-widest">
          Settling...
        </Badge>
      </div>
    );
  }

  if (status === 'expired') {
    return (
      <div className="flex items-center gap-2">
        <AlertTriangle className="w-4 h-4 text-orange-400" />
        <Badge className="bg-orange-500/10 text-orange-400 border-orange-500/20 text-[10px] font-black uppercase tracking-widest">
          Awaiting settlement
        </Badge>
      </div>
    );
  }

  // Live — show countdown
  return (
    <div className="flex items-center gap-2">
      <Clock className="w-4 h-4 text-slate-400" />
      <div className="flex flex-col">
        <span className="text-[9px] uppercase font-black text-slate-500 tracking-widest">Settles in</span>
        <span className="font-mono font-bold text-white text-sm">{formatCountdown(secondsLeft)}</span>
      </div>
    </div>
  );
}

export function MarketStatusBadge({ expiryTimestamp, settled, yesWins }: SettlementCountdownProps) {
  const expiry = Number(expiryTimestamp);
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 5000);
    return () => clearInterval(id);
  }, []);

  const status = getStatus(expiry, settled);

  if (status === 'settled') {
    return (
      <Badge className="bg-green-500/10 text-green-400 border-green-500/20 text-[10px] font-black uppercase">
        Settled
      </Badge>
    );
  }
  if (status === 'settling') {
    return (
      <Badge className="bg-yellow-500/10 text-yellow-400 border-yellow-500/20 text-[10px] font-black uppercase">
        Settling
      </Badge>
    );
  }
  if (status === 'expired') {
    return (
      <Badge className="bg-orange-500/10 text-orange-400 border-orange-500/20 text-[10px] font-black uppercase">
        Expired
      </Badge>
    );
  }
  return (
    <Badge className="bg-blue-500/10 text-blue-400 border-blue-500/20 text-[10px] font-black uppercase">
      Live
    </Badge>
  );
}
