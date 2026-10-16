import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ServerRole } from '@protocol';
import { kvStorage } from '@/lib/storage';

/** A paired server. No secrets here: login uses the phone's device key (lib/deviceKey). */
export interface Host {
  id: string;
  /** Display name (server hostname unless renamed). */
  name: string;
  host: string;
  port: number;
  scheme: 'https' | 'http';
  deviceId: string;
  addedAt: string;
  /** Last role the server reported (for grouping the list before connecting). */
  role?: ServerRole;
}

interface HostsState {
  hosts: Host[];
  add(h: Host): void;
  update(id: string, patch: Partial<Host>): void;
  remove(id: string): void;
}

export const useHosts = create<HostsState>()(
  persist(
    (set) => ({
      hosts: [],
      add: (h) => set((s) => ({ hosts: [...s.hosts.filter((x) => !(x.host === h.host && x.port === h.port)), h] })),
      update: (id, patch) => set((s) => ({ hosts: s.hosts.map((h) => (h.id === id ? { ...h, ...patch } : h)) })),
      remove: (id) => set((s) => ({ hosts: s.hosts.filter((h) => h.id !== id) })),
    }),
    { name: 'nicode.hosts', storage: kvStorage },
  ),
);

export function getHost(id: string): Host | undefined {
  return useHosts.getState().hosts.find((h) => h.id === id);
}

export function useHost(id: string | undefined): Host | undefined {
  return useHosts((s) => s.hosts.find((h) => h.id === id));
}
