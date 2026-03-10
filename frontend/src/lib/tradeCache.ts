import { openDB, IDBPDatabase } from 'idb';

const DB_NAME = 'meridian';
const DB_VERSION = 2;

export type TradeEventType = 'OrderFilled' | 'PairMinted' | 'Redeemed';

export interface TradeEvent {
  // Composite primary key: unique across all events
  id: string; // `${txHash}-${logIndex}`
  wallet: string; // lowercase wallet address (indexed)
  chainId: number; // (indexed)
  blockNumber: number; // (indexed)
  txHash: string;
  logIndex: number;
  eventType: TradeEventType;
  marketId: string;
  timestamp?: number; // block timestamp if available

  // OrderFilled fields
  orderId?: string;
  maker?: string;
  taker?: string;
  side?: number; // 0=BID, 1=ASK (taker side)
  priceCents?: number;
  qty?: bigint;

  // PairMinted fields
  mintQty?: bigint;

  // Redeemed fields
  redeemQty?: bigint;
  payout?: bigint;
}

export interface MarketExecutionEvent {
  // Composite primary key: unique across all logs
  id: string; // `${txHash}-${logIndex}`
  chainId: number; // (indexed)
  marketId: string; // (indexed)
  blockNumber: number; // (indexed)
  txHash: string;
  logIndex: number;
  timestamp?: number; // block timestamp if available
  maker: string;
  taker: string;
  side: number; // taker side: 0=BID, 1=ASK
  priceCents: number;
  qty: bigint;
}

interface CursorRecord {
  id: string; // `${wallet}_${chainId}`
  lastBlock: number;
  updatedAt: number;
}

interface MarketCursorRecord {
  id: string; // `${chainId}_${marketId}`
  lastBlock: number;
  updatedAt: number;
}

type MeridianDB = {
  tradeEvents: {
    key: string;
    value: TradeEvent;
    indexes: {
      byWallet: string;
      byChain: number;
      byBlock: number;
      byWalletAndChain: [string, number];
    };
  };
  cursors: {
    key: string;
    value: CursorRecord;
  };
  marketExecutionEvents: {
    key: string;
    value: MarketExecutionEvent;
    indexes: {
      byChain: number;
      byMarket: string;
      byBlock: number;
      byChainAndMarket: [number, string];
    };
  };
  marketExecutionCursors: {
    key: string;
    value: MarketCursorRecord;
  };
};

let dbPromise: Promise<IDBPDatabase<MeridianDB>> | null = null;

function getDB(): Promise<IDBPDatabase<MeridianDB>> {
  if (!dbPromise) {
    dbPromise = openDB<MeridianDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('tradeEvents')) {
          const store = db.createObjectStore('tradeEvents', { keyPath: 'id' });
          store.createIndex('byWallet', 'wallet', { unique: false });
          store.createIndex('byChain', 'chainId', { unique: false });
          store.createIndex('byBlock', 'blockNumber', { unique: false });
          store.createIndex('byWalletAndChain', ['wallet', 'chainId'], { unique: false });
        }
        if (!db.objectStoreNames.contains('cursors')) {
          db.createObjectStore('cursors', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('marketExecutionEvents')) {
          const store = db.createObjectStore('marketExecutionEvents', { keyPath: 'id' });
          store.createIndex('byChain', 'chainId', { unique: false });
          store.createIndex('byMarket', 'marketId', { unique: false });
          store.createIndex('byBlock', 'blockNumber', { unique: false });
          store.createIndex('byChainAndMarket', ['chainId', 'marketId'], { unique: false });
        }
        if (!db.objectStoreNames.contains('marketExecutionCursors')) {
          db.createObjectStore('marketExecutionCursors', { keyPath: 'id' });
        }
      },
    });
  }
  return dbPromise;
}

export async function getCursor(wallet: string, chainId: number): Promise<number | null> {
  const db = await getDB();
  const key = `${wallet.toLowerCase()}_${chainId}`;
  const record = await db.get('cursors', key);
  return record?.lastBlock ?? null;
}

export async function setCursor(wallet: string, chainId: number, lastBlock: number): Promise<void> {
  const db = await getDB();
  const key = `${wallet.toLowerCase()}_${chainId}`;
  await db.put('cursors', { id: key, lastBlock, updatedAt: Date.now() });
}

export async function saveEvents(events: TradeEvent[]): Promise<void> {
  if (events.length === 0) return;
  const db = await getDB();
  const tx = db.transaction('tradeEvents', 'readwrite');
  await Promise.all([...events.map((e) => tx.store.put(e)), tx.done]);
}

export async function getEventsForWallet(wallet: string, chainId: number): Promise<TradeEvent[]> {
  const db = await getDB();
  return db.getAllFromIndex('tradeEvents', 'byWalletAndChain', [wallet.toLowerCase(), chainId]);
}

export async function clearCacheForWallet(wallet: string, chainId: number): Promise<void> {
  const db = await getDB();
  const key = `${wallet.toLowerCase()}_${chainId}`;
  const existing = await db.getAllFromIndex('tradeEvents', 'byWalletAndChain', [wallet.toLowerCase(), chainId]);
  const tx = db.transaction(['tradeEvents', 'cursors'], 'readwrite');
  await Promise.all([
    ...existing.map((e) => tx.objectStore('tradeEvents').delete(e.id)),
    tx.objectStore('cursors').delete(key),
    tx.done,
  ]);
}

function marketCursorKey(chainId: number, marketId: string): string {
  return `${chainId}_${marketId.toLowerCase()}`;
}

export async function getMarketExecutionCursor(
  chainId: number,
  marketId: string
): Promise<number | null> {
  const db = await getDB();
  const key = marketCursorKey(chainId, marketId);
  const record = await db.get('marketExecutionCursors', key);
  return record?.lastBlock ?? null;
}

export async function setMarketExecutionCursor(
  chainId: number,
  marketId: string,
  lastBlock: number
): Promise<void> {
  const db = await getDB();
  const key = marketCursorKey(chainId, marketId);
  await db.put('marketExecutionCursors', {
    id: key,
    lastBlock,
    updatedAt: Date.now(),
  });
}

export async function saveMarketExecutionEvents(
  events: MarketExecutionEvent[]
): Promise<void> {
  if (events.length === 0) return;
  const db = await getDB();
  const tx = db.transaction('marketExecutionEvents', 'readwrite');
  await Promise.all([...events.map((e) => tx.store.put(e)), tx.done]);
}

export async function getMarketExecutionEvents(
  chainId: number,
  marketId: string
): Promise<MarketExecutionEvent[]> {
  const db = await getDB();
  const events = await db.getAllFromIndex(
    'marketExecutionEvents',
    'byChainAndMarket',
    [chainId, marketId.toLowerCase()]
  );
  return events.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return b.blockNumber - a.blockNumber;
    return b.logIndex - a.logIndex;
  });
}
