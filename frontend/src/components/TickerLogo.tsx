'use client';

import { useState } from 'react';
import { ASSET_META, Ticker } from '@/constants/assets';

interface TickerLogoProps {
  ticker: string;
  size?: number;
  className?: string;
}

export function TickerLogo({ ticker, size = 40, className = '' }: TickerLogoProps) {
  const [failed, setFailed] = useState(false);
  const meta = ASSET_META[ticker as Ticker];
  const logoUrl = meta?.logoUrl;

  if (!logoUrl || failed) {
    return (
      <div
        className={`flex items-center justify-center font-bold text-slate-300 bg-slate-800 rounded-xl ${className}`}
        style={{ width: size, height: size, fontSize: size * 0.4 }}
      >
        {ticker[0]}
      </div>
    );
  }

  return (
    <img
      src={logoUrl}
      alt={`${ticker} logo`}
      width={size}
      height={size}
      className={`rounded-xl object-contain bg-white ${className}`}
      style={{ width: size, height: size }}
      onError={() => setFailed(true)}
    />
  );
}
