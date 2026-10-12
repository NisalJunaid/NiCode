/** Push: per-phone preferences, the test notification, and the crash/site watchers. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wants } from '../src/modules/push.js';
import { CrashWatcher, SiteWatcher, Throttle } from '../src/modules/watch.js';
import { Client, startDaemon, type TestDaemon, TOKEN } from './helpers.js';

describe('push preferences', () => {
  it('filters by kind; unknown kinds and tests always go out', () => {
    const t = { token: 'x', platform: 'android' as const, addedAt: '', prefs: { finished: false } };
    expect(wants(t, 'result')).toBe(false);
    expect(wants(t, 'permission')).toBe(true);
    expect(wants(t, 'test')).toBe(true);
    expect(wants({ ...t, prefs: undefined }, 'result')).toBe(true);
  });
});

describe('watchers', () => {
  it('alerts when an app becomes errored or keeps restarting', () => {
    const w = new CrashWatcher();
    const t0 = 1_000_000;
    expect(w.observe([{ name: 'api', status: 'errored', restarts: 9 }], t0)).toEqual([]); // first look only primes
    expect(w.observe([{ name: 'api', status: 'online', restarts: 9 }], t0 + 30_000)).toEqual([]);
    expect(w.observe([{ name: 'api', status: 'errored', restarts: 9 }], t0 + 60_000).map((a) => a.key)).toEqual(['app:api:errored']);
    const w2 = new CrashWatcher();
    w2.observe([{ name: 'web', status: 'online', restarts: 0 }], t0);
    expect(w2.observe([{ name: 'web', status: 'online', restarts: 2 }], t0 + 30_000)).toEqual([]);
    expect(w2.observe([{ name: 'web', status: 'online', restarts: 4 }], t0 + 60_000).map((a) => a.title)).toEqual(['⚠️ web keeps restarting']);
    expect(w2.observe([{ name: 'web', status: 'online', restarts: 4 }], t0 + 10 * 60_000)).toEqual([]); // old restarts age out
  });

  it('marks a site down after two failures and up again once it answers', () => {
    const w = new SiteWatcher();
    const r = (ok: boolean) => [{ name: 'shop.conf', domain: 'shop.dev', ok, detail: 'No answer' }];
    expect(w.observe(r(false))).toEqual([]);
    expect(w.observe(r(false)).map((a) => a.title)).toEqual(['🔴 shop.dev is down']);
    expect(w.observe(r(false))).toEqual([]);
    expect(w.observe(r(true)).map((a) => a.title)).toEqual(['✅ shop.dev is back up']);
    expect(w.observe(r(true))).toEqual([]);
  });

  it('throttles each alert to once an hour', () => {
    const t = new Throttle();
    expect(t.allow('a', 0)).toBe(true);
    expect(t.allow('a', 1000)).toBe(false);
    expect(t.allow('b', 1000)).toBe(true);
    expect(t.allow('a', 3600_001)).toBe(true);
  });
});

describe('push through the daemon', () => {
  let d: TestDaemon;
  let c: Client;
  let expo: http.Server;
  const received: any[] = [];

  beforeAll(async () => {
    expo = http.createServer((req, res) => {
      let body = '';
      req.on('data', (x) => (body += x));
      req.on('end', () => {
        const msgs = JSON.parse(body) as unknown[];
        received.push(...msgs);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: msgs.map(() => ({ status: 'ok', id: 'x' })) }));
      });
    });
    await new Promise<void>((r) => expo.listen(0, '127.0.0.1', r));
    d = await startDaemon({ env: { NICODE_PUSH_URL: `http://127.0.0.1:${(expo.address() as AddressInfo).port}/send` } });
    c = await Client.connect(d.port, TOKEN);
  }, 30_000);

  afterAll(() => {
    c?.close();
    d?.stop();
    expo?.close();
  });

  it('sends a test notification to registered phones', async () => {
    expect((await c.call('push.test', {})).error.message).toMatch(/No phone/);
    await c.call('push.register', { expoPushToken: 'ExponentPushToken[abc123]', platform: 'android', prefs: { finished: false } });
    expect((await c.call('push.test', {})).result).toEqual({ sent: 1 });
    expect(received[0]).toMatchObject({ to: 'ExponentPushToken[abc123]', title: '🔔 niCode', data: { kind: 'test' } });
  });
});
