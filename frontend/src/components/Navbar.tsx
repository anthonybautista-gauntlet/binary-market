'use client';

import Link from 'next/link';
import { ConnectButton } from '@rainbow-me/rainbowkit';

export function Navbar() {
  return (
    <nav className="border-b border-slate-800 bg-slate-900/50 backdrop-blur-md sticky top-0 z-50">
      <div className="container mx-auto px-4 h-16 flex items-center justify-between">
        <div className="flex items-center gap-8">
          <Link href="/" className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-white font-bold text-xl">M</div>
            <span className="font-outfit font-bold text-xl tracking-tight hidden sm:inline-block">MERIDIAN</span>
          </Link>
          
          <div className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-400">
            <Link href="/markets" className="hover:text-white transition-colors">Markets</Link>
            <Link href="/portfolio" className="hover:text-white transition-colors">Portfolio</Link>
            <Link href="/history" className="hover:text-white transition-colors">History</Link>
            <Link href="/docs" className="hover:text-white transition-colors">Docs</Link>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <ConnectButton 
            accountStatus="avatar"
            chainStatus="icon"
            showBalance={false}
          />
        </div>
      </div>
    </nav>
  );
}
