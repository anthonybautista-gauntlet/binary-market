import { create } from 'zustand';

export interface OrderLevel {
  price: number; // 1-99
  quantity: bigint;
}

interface OrderBookState {
  bids: OrderLevel[];
  asks: OrderLevel[];
  setBids: (bids: OrderLevel[]) => void;
  setAsks: (asks: OrderLevel[]) => void;
  updateLevel: (side: 'bid' | 'ask', price: number, quantity: bigint) => void;
}

export const useOrderBookStore = create<OrderBookState>((set) => ({
  bids: [],
  asks: [],
  setBids: (bids) => set({ bids: bids.sort((a, b) => b.price - a.price) }),
  setAsks: (asks) => set({ asks: asks.sort((a, b) => a.price - b.price) }),
  updateLevel: (side, price, quantity) => set((state) => {
    const levels = side === 'bid' ? [...state.bids] : [...state.asks];
    const index = levels.findIndex((l) => l.price === price);
    
    if (quantity === 0n) {
      if (index !== -1) levels.splice(index, 1);
    } else {
      if (index !== -1) {
        levels[index] = { price, quantity };
      } else {
        levels.push({ price, quantity });
      }
    }

    const sorted = side === 'bid' 
      ? levels.sort((a, b) => b.price - a.price)
      : levels.sort((a, b) => a.price - b.price);

    return side === 'bid' ? { bids: sorted } : { asks: sorted };
  }),
}));
