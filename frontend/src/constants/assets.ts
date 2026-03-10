export const PYTH_FEED_IDS = {
  AAPL: '0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688',
  MSFT: '0xd0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1',
  NVDA: '0x61c4ca5b9731a79e285a01e24432d57d89f0ecdd4cd7828196ca8992d5eafef6',
  GOOGL: '0xe65ff435be42630439c96396653a342829e877e2aafaeaf1a10d0ee5fd2cf3f2',
  AMZN: '0x82c59e36a8e0247e15283748d6cd51f5fa1019d73fbf3ab6d927e17d9e357a7f',
  META: '0x78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe',
  TSLA: '0x42676a595d0099c381687124805c8bb22c75424dffcaa55e3dc6549854ebe20a',
} as const;

export type Ticker = keyof typeof PYTH_FEED_IDS;

export const ASSET_META: Record<
  Ticker,
  { name: string; logoUrl: string; domain: string }
> = {
  AAPL: {
    name: 'Apple Inc.',
    logoUrl: '/images/logos/AAPL.png',
    domain: 'apple.com',
  },
  MSFT: {
    name: 'Microsoft Corp.',
    logoUrl: '/images/logos/MSFT.png',
    domain: 'microsoft.com',
  },
  NVDA: {
    name: 'NVIDIA Corp.',
    logoUrl: '/images/logos/NVDA.png',
    domain: 'nvidia.com',
  },
  GOOGL: {
    name: 'Alphabet Inc.',
    logoUrl: '/images/logos/GOOGL.png',
    domain: 'google.com',
  },
  AMZN: {
    name: 'Amazon.com, Inc.',
    logoUrl: '/images/logos/AMZN.png',
    domain: 'amazon.com',
  },
  META: {
    name: 'Meta Platforms, Inc.',
    logoUrl: '/images/logos/META.png',
    domain: 'meta.com',
  },
  TSLA: {
    name: 'Tesla, Inc.',
    logoUrl: '/images/logos/TSLA.png',
    domain: 'tesla.com',
  },
};

export const ASSETS: { ticker: Ticker; name: string; logoUrl: string }[] =
  Object.entries(ASSET_META).map(([ticker, meta]) => ({
    ticker: ticker as Ticker,
    name: meta.name,
    logoUrl: meta.logoUrl,
  }));
