/** Claude usage per account: the usage endpoint (per token) and limits reported during chats. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseUsageResponse, toIso, toPercent } from '../src/claude/usage.js';
import { Client, startDaemon, type TestDaemon, TOKEN } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('usage parsing', () => {
  it('reads both windows, in percent, with reset times', () => {
    const p = parseUsageResponse({ five_hour: { utilization: 37, resets_at: '2026-10-13T12:00:00Z' }, seven_day: { utilization: 12.54, resets_at: null }, extra: 1 });
    expect(p).toEqual({ fiveHour: { usedPercent: 37, resetsAt: '2026-10-13T12:00:00.000Z' }, sevenDay: { usedPercent: 12.5, resetsAt: null } });
    expect(parseUsageResponse({ nothing: true })).toBeNull();
    expect(toPercent(0.83, 'fraction')).toBe(83);
    expect(toPercent(1, 'percent')).toBe(1);
    expect(toIso(1791900000)).toBe(new Date(1791900000 * 1000).toISOString());
  });
});

describe('usage through the daemon', () => {
  let d: TestDaemon;
  let c: Client;
  let fake: http.Server;
  const T1 = 'sk-ant-oat01-usage-one-aaaa';
  const T2 = 'sk-ant-oat01-usage-two-bbbb';

  beforeAll(async () => {
    fake = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization === `Bearer ${T1}`) return res.end(JSON.stringify({ five_hour: { utilization: 40, resets_at: '2026-10-13T15:00:00Z' }, seven_day: { utilization: 9, resets_at: '2026-10-19T00:00:00Z' } }));
      res.statusCode = 403;
      res.end('{"error":"scope"}');
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
    d = await startDaemon({
      claudeToken: T1,
      env: { NICODE_TEST_CLAUDE_VERIFY: '1', NICODE_TEST_CLAUDE_SHIM: path.join(here, 'fake-claude.mjs'), NICODE_USAGE_URL: `http://127.0.0.1:${(fake.address() as AddressInfo).port}/usage` },
    });
    c = await Client.connect(d.port, TOKEN);
  }, 30_000);

  afterAll(() => {
    c?.close();
    d?.stop();
    fake?.close();
  });

  it('checks every account with its own token', async () => {
    const second = (await c.call('setup.claudeLogin.setToken', { token: T2, label: 'Work', activate: false })).result.accountId;
    const { accounts } = (await c.call('setup.claudeAccounts.list', {})).result;
    const first = accounts.find((a: any) => a.label === 'Account 1').id;
    const r = (await c.call('setup.claudeAccounts.usage', { refresh: true })).result;
    expect(r.activeId).toBe(first);
    expect(r.usage[first]).toMatchObject({ source: 'api', fiveHour: { usedPercent: 40, resetsAt: '2026-10-13T15:00:00.000Z' }, sevenDay: { usedPercent: 9 } });
    expect(r.usage[second].error).toMatch(/can't read usage directly/);
    expect(JSON.stringify(r)).not.toContain('sk-ant');
  });

  it('updates the active account from limits reported during a chat', async () => {
    c.events = [];
    const st = await c.call('claude.start', { projectPath: d.demo, prompt: 'rate-limit please' });
    const ev = await c.waitEvent((e: any) => e.event === 'claude.usage');
    expect(ev.data.usage).toMatchObject({ source: 'chat', status: 'allowed_warning', fiveHour: { usedPercent: 83, resetsAt: new Date(1791900000 * 1000).toISOString() }, sevenDay: { usedPercent: 9 } });
    expect(st.result.sessionId).toBeTruthy();
  });
});
