import { useEffect, useState, useSyncExternalStore } from 'react';
import type { EventData, EventName, ServerInfo } from '@protocol';
import { getHost } from '@/state/hosts';
import { type ConnState, NicodeClient } from './client';

/** One client per paired server, created lazily and kept for the app's lifetime. */
const clients = new Map<string, NicodeClient>();

export function getClient(hostId: string): NicodeClient | null {
  let c = clients.get(hostId);
  if (!c) {
    const host = getHost(hostId);
    if (!host) return null;
    c = new NicodeClient(host);
    clients.set(hostId, c);
  }
  c.start();
  return c;
}

export function dropClient(hostId: string): void {
  clients.get(hostId)?.stop();
  clients.delete(hostId);
}

export function useClient(hostId: string): NicodeClient | null {
  const [client] = useState(() => getClient(hostId));
  return client;
}

/** Re-renders on connection state changes. */
export function useConnection(hostId: string): { client: NicodeClient | null; state: ConnState; info: ServerInfo | null; error: string | null } {
  const client = useClient(hostId);
  const snapshot = useSyncExternalStore(
    (cb) => client?.subscribeState(cb) ?? (() => undefined),
    () => `${client?.state}|${client?.lastError}|${client?.info?.setup.claude}|${client?.info?.setup.github}`,
  );
  void snapshot;
  return { client, state: client?.state ?? 'idle', info: client?.info ?? null, error: client?.lastError ?? null };
}

/** Subscribes to a server event for the lifetime of the component. */
export function useServerEvent<E extends EventName>(client: NicodeClient | null, event: E, fn: (data: EventData<E>) => void): void {
  useEffect(() => client?.on(event, fn), [client, event, fn]);
}

/** Calls fn every time the connection (re)opens, including immediately if already open. */
export function useOnConnected(client: NicodeClient | null, fn: () => void): void {
  useEffect(() => {
    if (!client) return;
    if (client.state === 'open') fn();
    return client.on('connected', () => fn());
  }, [client, fn]);
}
