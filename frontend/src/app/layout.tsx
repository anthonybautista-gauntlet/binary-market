import type { Metadata } from 'next';
import { Inter, Outfit } from 'next/font/google';
import './globals.css';
import { Providers } from '@/components/Providers';
import '@rainbow-me/rainbowkit/styles.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const outfit = Outfit({ subsets: ['latin'], variable: '--font-outfit' });

export const metadata: Metadata = {
  title: 'Meridian Market | Binary Stock Options',
  description: 'Trade binary options on MAG7 equities with on-chain settlement.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.variable} ${outfit.variable} font-sans antialiased bg-slate-950 text-slate-50`}>
        <Providers>
          {children}
        </Providers>
      </body>
    </html>
  );
}
