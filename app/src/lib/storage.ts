import Storage from 'expo-sqlite/kv-store';
import { createJSONStorage } from 'zustand/middleware';

/** Synchronous key-value storage (SQLite-backed) for zustand persist. Holds no secrets. */
export const kvStorage = createJSONStorage(() => ({
  getItem: (k: string) => Storage.getItemSync(k),
  setItem: (k: string, v: string) => Storage.setItemSync(k, v),
  removeItem: (k: string) => {
    Storage.removeItemSync(k);
  },
}));
