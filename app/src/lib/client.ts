/**
 * One connection to one niCode server.
 * Every (re)connect: GET /auth/challenge → sign with the device key → open /ws with
 * `Authorization: Signature …`. Reconnects with backoff and when the app returns to the foreground.
 */
import { AppState } from 'react-native';
import {
  authMessage,
  baseUrl,
  type Challenge,
  type EventData,
  type EventName,
  type MethodName,
  type MethodParams,
  type MethodResult,
  PROTOCOL_VERSION,
  type ServerFrame,
  type ServerInfo,
  signatureHeader,
  wsUrl,
} from '@protocol';
import { getHost, type Host, useHosts } from '@/state/hosts';
import { KeyLockedError, KeyLostError, sign } from './deviceKey';

export type ConnState =
  | 'idle'
  | 'unlocking' // waiting for the biometric prompt
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'locked' // user cancelled the biometric prompt; needs a tap to retry
  | 'unpaired' // server no longer accepts this phone (revoked / key reset)
  | 'offline';

export class RpcCallError extends Error {
  constructor(
    public code: string,
    message: string,
    public data?: unknown,
  ) {
    super(message);
  }
}

type Listener = (data: any) => void;

export class NicodeClient {
  state: ConnState = 'idle';
  info: ServerInfo | null = null;
  lastError: string | null = null;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Map<string, Set<Listener>>();
  private stateListeners = new Set<() => void>();
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private connecting = false;
  private appStateSub: { remove(): void } | null = null;

  constructor(public host: Host) {
    // Production / development can change while connected (another phone, or `nicode role`).
    this.on('server.role', () => {
      this.call('server.info', {})
        .then((info) => this.setInfo(info))
        .catch(() => undefined);
    });
  }

  private setInfo(info: ServerInfo): void {
    this.info = info;
    const role = info.role ?? 'development'; // older daemons have no roles
    if (getHost(this.host.id)?.role !== role) useHosts.getState().update(this.host.id, { role });
    this.setState('open');
  }

  /** Re-reads server.info (after changing the role, for example). */
  async refreshInfo(): Promise<ServerInfo> {
    const info = await this.call('server.info', {});
    this.setInfo(info);
    return info;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.appStateSub = AppState.addEventListener('change', (s) => {
      if (s === 'active' && this.state !== 'open' && this.state !== 'unpaired' && this.state !== 'locked') this.reconnectNow();
    });
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.appStateSub?.remove();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close();
    this.ws = null;
    this.setState('idle');
  }

  /** Manual retry (e.g. "Unlock" button after a cancelled prompt). */
  reconnectNow(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retry = 0;
    this.stopped = false;
    void this.connect();
  }

  private setState(s: ConnState, error?: string | null): void {
    this.state = s;
    if (error !== undefined) this.lastError = error;
    for (const l of this.stateListeners) l();
  }

  subscribeState(fn: () => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  private async connect(): Promise<void> {
    if (this.connecting || this.stopped || this.state === 'open') return;
    this.connecting = true;
    try {
      const base = baseUrl(this.host);
      let challenge: Challenge;
      try {
        const res = await fetch(`${base}/auth/challenge`, { headers: { accept: 'application/json' } });
        if (res.status === 429) throw new Error('Too many failed logins; waiting');
        if (!res.ok) throw new Error(`Server answered ${res.status}`);
        challenge = (await res.json()) as Challenge;
      } catch (err) {
        this.scheduleRetry(err instanceof Error ? err.message : 'Server unreachable');
        return;
      }

      this.setState('unlocking');
      let sig: string;
      try {
        sig = await sign(authMessage(challenge.nonce, this.host.deviceId), `Unlock ${this.host.name}`);
      } catch (err) {
        if (err instanceof KeyLostError) return this.setState('unpaired', err.message);
        if (err instanceof KeyLockedError) return this.setState('locked', 'Unlock to connect');
        return this.setState('locked', err instanceof Error ? err.message : 'Could not unlock');
      }

      this.setState(this.retry > 0 ? 'reconnecting' : 'connecting');
      await this.openSocket(signatureHeader(this.host.deviceId, challenge.nonce, sig));
    } finally {
      this.connecting = false;
    }
  }

  private openSocket(authorization: string): Promise<void> {
    return new Promise((resolve) => {
      // React Native's WebSocket accepts headers as the third argument.
      const WS = WebSocket as unknown as new (url: string, protocols: string[] | undefined, options: { headers: Record<string, string> }) => WebSocket;
      const ws = new WS(wsUrl(this.host), undefined, { headers: { Authorization: authorization } });
      this.ws = ws;
      let opened = false;
      ws.onopen = () => {
        opened = true;
        this.retry = 0;
        this.setState('open', null);
        resolve();
        this.call('server.info', {})
          .then((info) => {
            this.setInfo(info);
            this.emitLocal('connected', info);
          })
          .catch(() => undefined);
      };
      ws.onmessage = (e) => this.onFrame(String(e.data));
      ws.onerror = (e) => {
        const msg = String((e as unknown as { message?: string }).message ?? '');
        // Handshake rejected: RN reports the HTTP status in the error message.
        if (!opened && /\b401\b/.test(msg)) {
          this.ws = null;
          this.setState('unpaired', 'This phone is no longer paired with the server.');
          resolve();
        }
      };
      ws.onclose = (e) => {
        if (this.ws !== ws) return resolve();
        this.ws = null;
        this.failPending('Connection lost');
        if (e.code === 4401) {
          this.setState('unpaired', e.reason === 'access expired' ? 'Access expired.' : 'This phone was removed from the server.');
        } else if (!this.stopped && this.state !== 'unpaired') {
          this.scheduleRetry(opened ? 'Connection lost' : 'Could not connect');
        }
        resolve();
      };
    });
  }

  private scheduleRetry(reason: string): void {
    if (this.stopped) return;
    const delay = Math.min(30_000, 500 * 2 ** this.retry);
    this.retry += 1;
    this.setState(this.retry > 2 ? 'offline' : 'reconnecting', reason);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.connect(), delay);
  }

  private failPending(message: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new RpcCallError('disconnected', message));
      this.pending.delete(id);
    }
  }

  // ── RPC ────────────────────────────────────────────────────────────────────

  private onFrame(text: string): void {
    let f: ServerFrame;
    try {
      f = JSON.parse(text) as ServerFrame;
    } catch {
      return;
    }
    if ('id' in f) {
      const p = this.pending.get(f.id);
      if (!p) return;
      this.pending.delete(f.id);
      clearTimeout(p.timer);
      if ('error' in f) p.reject(new RpcCallError(f.error.code, f.error.message, f.error.data));
      else p.resolve(f.result);
      return;
    }
    this.emitLocal(f.event, f.data);
  }

  private async waitOpen(ms: number): Promise<void> {
    if (this.state === 'open' && this.ws) return;
    if (this.state === 'idle') this.start();
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        unsub();
        reject(new RpcCallError('offline', this.lastError ?? 'Not connected to the server'));
      }, ms);
      const unsub = this.subscribeState(() => {
        if (this.state === 'open' && this.ws) {
          clearTimeout(t);
          unsub();
          resolve();
        } else if (this.state === 'unpaired' || this.state === 'locked') {
          clearTimeout(t);
          unsub();
          reject(new RpcCallError(this.state, this.lastError ?? 'Not connected'));
        }
      });
    });
  }

  async call<M extends MethodName>(method: M, params: MethodParams<M>, timeoutMs = 30_000): Promise<MethodResult<M>> {
    if (method !== 'server.info') await this.waitOpen(15_000);
    const ws = this.ws;
    if (!ws) throw new RpcCallError('offline', 'Not connected');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcCallError('timeout', 'The server took too long to answer'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Fire-and-forget (terminal keystrokes): no promise bookkeeping. */
  send<M extends MethodName>(method: M, params: MethodParams<M>): void {
    this.ws?.send(JSON.stringify({ id: this.nextId++, method, params }));
  }

  // ── events ─────────────────────────────────────────────────────────────────

  on<E extends EventName>(event: E, fn: (data: EventData<E>) => void): () => void;
  on(event: 'connected', fn: (info: ServerInfo) => void): () => void;
  on(event: string, fn: Listener): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  private emitLocal(event: string, data: unknown): void {
    for (const fn of this.listeners.get(event) ?? []) {
      try {
        fn(data);
      } catch {
        // a bad listener must not break the connection
      }
    }
  }

  get protocolMismatch(): boolean {
    return !!this.info && this.info.protocolVersion !== PROTOCOL_VERSION;
  }
}
