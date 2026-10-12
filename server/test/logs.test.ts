/** Logs: the server-side catalog, tail + filter, follow (and that unknown ids are refused). */
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, startDaemon, type TestDaemon, TOKEN } from './helpers.js';

let d: TestDaemon;
let c: Client;
let proj = '';
let logFile = '';

beforeAll(async () => {
  d = await startDaemon({ env: { NICODE_NGINX_DIR: path.join(process.cwd(), 'no-nginx-here'), NICODE_LOG_DIR: path.join(process.cwd(), 'no-logs-here') } });
  c = await Client.connect(d.port, TOKEN);
  proj = path.join(d.projectsRoot, 'shop');
  await mkdir(path.join(proj, 'storage', 'logs'), { recursive: true });
  await writeFile(path.join(proj, 'artisan'), '');
  logFile = path.join(proj, 'storage', 'logs', 'laravel.log');
  await writeFile(logFile, Array.from({ length: 50 }, (_, i) => `[2026-10-12] local.INFO: line ${i + 1}`).join('\n') + '\n[2026-10-12] local.ERROR: boom\n');
}, 30_000);

afterAll(() => {
  c?.close();
  d?.stop();
});

describe('logs', () => {
  it('lists the project logs from the server catalog', async () => {
    const all = (await c.call('logs.sources', {})).result;
    expect(all.map((s: any) => s.id)).toEqual(expect.arrayContaining(['laravel:shop', 'nicode']));
    const mine = (await c.call('logs.sources', { projectPath: proj })).result;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id: 'laravel:shop', group: 'project', label: 'shop · Laravel' });
  });

  it('tails and filters by id only', async () => {
    const t = (await c.call('logs.tail', { id: 'laravel:shop', lines: 3 })).result.text;
    expect(t.split('\n')).toEqual(['[2026-10-12] local.INFO: line 49', '[2026-10-12] local.INFO: line 50', '[2026-10-12] local.ERROR: boom']);
    expect((await c.call('logs.tail', { id: 'laravel:shop', filter: 'error' })).result.text).toBe('[2026-10-12] local.ERROR: boom');
    expect((await c.call('logs.tail', { id: '/etc/shadow' })).error.code).toBe('not_found');
    expect((await c.call('logs.tail', { id: 'laravel:../../etc' })).error.code).toBe('not_found');
  });

  it('follows new lines until unfollowed', async () => {
    const { followId } = (await c.call('logs.follow', { id: 'laravel:shop' })).result;
    await new Promise((r) => setTimeout(r, 300));
    await appendFile(logFile, 'fresh line\n');
    const ev = await c.waitEvent((e: any) => e.event === 'logs.data' && e.data.followId === followId && e.data.chunk.includes('fresh line'), 5000);
    expect(ev.data.chunk).toBe('fresh line\n');
    expect((await c.call('logs.unfollow', { followId })).result).toEqual({ ok: true });
  });
});
