import { useCallback, useEffect } from 'react';
import { create } from 'zustand';
import type { ClaudeSessionState, ClaudeSessionSummary, PermissionRequest, SeqEvent } from '@protocol';
import type { NicodeClient } from '@/lib/client';
import { useOnConnected } from '@/lib/connections';

/** In-memory cache of chat sessions (survives tab switches; the server keeps the real history). */
interface SessionData {
  events: SeqEvent[];
  lastSeq: number;
  state: ClaudeSessionState;
  error?: string;
  loaded: boolean;
}

interface ChatState {
  sessions: Record<string, SessionData>; // key: `${hostId}:${sessionId}`
  permissions: Record<string, PermissionRequest[]>; // key: hostId
  summaries: Record<string, ClaudeSessionSummary[]>; // key: `${hostId}:${projectPath}`
  append(key: string, evs: SeqEvent[]): void;
  setState(key: string, state: ClaudeSessionState, error?: string): void;
  setPermissions(hostId: string, list: PermissionRequest[]): void;
  addPermission(hostId: string, p: PermissionRequest): void;
  removePermission(hostId: string, requestId: string): void;
  setSummaries(key: string, list: ClaudeSessionSummary[]): void;
}

const empty: SessionData = { events: [], lastSeq: 0, state: 'idle', loaded: false };

export const useChat = create<ChatState>()((set) => ({
  sessions: {},
  permissions: {},
  summaries: {},
  append: (key, evs) =>
    set((s) => {
      const cur = s.sessions[key] ?? empty;
      const fresh = evs.filter((e) => e.seq > cur.lastSeq);
      if (!fresh.length && cur.loaded) return s;
      const events = [...cur.events, ...fresh];
      return { sessions: { ...s.sessions, [key]: { ...cur, events, lastSeq: events[events.length - 1]?.seq ?? cur.lastSeq, loaded: true } } };
    }),
  setState: (key, state, error) =>
    set((s) => ({ sessions: { ...s.sessions, [key]: { ...(s.sessions[key] ?? empty), state, error } } })),
  setPermissions: (hostId, list) => set((s) => ({ permissions: { ...s.permissions, [hostId]: list } })),
  addPermission: (hostId, p) =>
    set((s) => ({ permissions: { ...s.permissions, [hostId]: [...(s.permissions[hostId] ?? []).filter((x) => x.requestId !== p.requestId), p] } })),
  removePermission: (hostId, id) =>
    set((s) => ({ permissions: { ...s.permissions, [hostId]: (s.permissions[hostId] ?? []).filter((x) => x.requestId !== id) } })),
  setSummaries: (key, list) => set((s) => ({ summaries: { ...s.summaries, [key]: list } })),
}));

/** Keeps the session cache in sync with the server: history on (re)connect + live events. */
export function useSessionSync(client: NicodeClient | null, hostId: string, sessionId: string | null): SessionData {
  const key = `${hostId}:${sessionId}`;
  const data = useChat((s) => s.sessions[key]) ?? empty;

  const catchUp = useCallback(async () => {
    if (!client || !sessionId) return;
    let since = useChat.getState().sessions[key]?.lastSeq ?? 0;
    for (;;) {
      const page = await client.call('claude.history', { sessionId, sinceSeq: since }).catch(() => null);
      if (!page) return;
      useChat.getState().append(key, page.events);
      if (!page.events.length || page.lastSeq <= (page.events[page.events.length - 1]?.seq ?? 0)) break;
      since = page.events[page.events.length - 1]!.seq;
    }
    const list = await client.call('claude.list', {}).catch(() => null);
    const me = list?.find((s) => s.sessionId === sessionId);
    if (me) useChat.getState().setState(key, me.state);
  }, [client, sessionId, key]);

  useOnConnected(client, catchUp);

  useEffect(() => {
    if (!client || !sessionId) return;
    const offEv = client.on('claude.event', (d) => {
      if (d.sessionId === sessionId) useChat.getState().append(key, [{ seq: d.seq, ts: d.ts, event: d.event }]);
    });
    const offSt = client.on('claude.status', (d) => {
      if (d.sessionId === sessionId) useChat.getState().setState(key, d.state, d.error);
    });
    return () => {
      offEv();
      offSt();
    };
  }, [client, sessionId, key]);

  return data;
}

/** Pending approvals for a server (all sessions), kept live. */
export function usePermissionSync(client: NicodeClient | null, hostId: string): PermissionRequest[] {
  const list = useChat((s) => s.permissions[hostId]) ?? [];
  useOnConnected(
    client,
    useCallback(() => {
      client
        ?.call('claude.permission.pending', {})
        .then((l) => useChat.getState().setPermissions(hostId, l))
        .catch(() => undefined);
    }, [client, hostId]),
  );
  useEffect(() => {
    if (!client) return;
    const a = client.on('claude.permission.request', (p) => useChat.getState().addPermission(hostId, p));
    const b = client.on('claude.permission.resolved', (r) => useChat.getState().removePermission(hostId, r.requestId));
    return () => {
      a();
      b();
    };
  }, [client, hostId]);
  return list;
}
