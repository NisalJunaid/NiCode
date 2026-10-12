/**
 * Starts the compiled daemon (run `npm run build` first) against a temp config and exercises
 * the real WebSocket API: auth, server.info, setup gating, projects, fs, git and devices.
 */
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client as C, sha, startDaemon, type TestDaemon, TOKEN } from './helpers.js';

let d: TestDaemon;
let port: number;
let tmp: string;
let projectsRoot: string;
let cfgPath: string;
const Client = { connect: (token: string) => C.connect(port, token) };

beforeAll(async () => {
  d = await startDaemon();
  ({ port, tmp, projectsRoot, cfgPath } = d);
}, 30_000);

afterAll(() => d?.stop());

describe('daemon over WebSocket', () => {
  it('serves /health and rejects bad tokens', async () => {
    const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    expect(h).toMatchObject({ ok: true, state: 'needs_claude_login' });
    await expect(Client.connect('b'.repeat(64))).rejects.toThrow('401');
  });

  it('accepts the token as a WebSocket subprotocol (browser test console)', async () => {
    const WebSocket = (await import('ws')).default;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['nicode', `nicode.${TOKEN}`]);
    const proto = await new Promise<string>((resolve, reject) => {
      ws.once('open', () => resolve(ws.protocol));
      ws.once('unexpected-response', (_q, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
    expect(proto).toBe('nicode');
    ws.close();
  });

  it('reports server info and gates claude.* until Claude is logged in', async () => {
    const c = await Client.connect(TOKEN);
    const info = await c.call('server.info');
    expect(info.result).toMatchObject({ protocolVersion: 2, setup: { claude: false }, device: { id: 'd_test', name: 'test phone' } });
    expect(info.result.permissionModes).toContain('default');
    const gated = await c.call('claude.list');
    expect(gated.error.code).toBe('setup_required');
    const bad = await c.call('fs.list', { projectPath: 123 });
    expect(bad.error.code).toBe('bad_request');
    c.close();
  });

  it('lists projects, reads/writes files with conflict detection, blocks traversal', async () => {
    const c = await Client.connect(TOKEN);
    const projects = (await c.call('projects.list')).result;
    expect(projects.map((p: any) => p.name)).toEqual(['demo']);
    const demo = projects[0].path;
    expect(projects[0]).toMatchObject({ isGit: true, branch: 'main' });

    const list = (await c.call('fs.list', { projectPath: demo, dir: '' })).result;
    expect(list.map((e: any) => e.name)).toEqual(['readme.md']);

    const read = (await c.call('fs.read', { projectPath: demo, path: 'readme.md' })).result;
    expect(read).toMatchObject({ content: 'hello\n', encoding: 'utf8', truncated: false });

    const w = await c.call('fs.write', { projectPath: demo, path: 'readme.md', content: 'hello world\n', expectedMtimeMs: read.mtimeMs });
    expect(w.result.mtimeMs).toBeGreaterThan(0);
    const conflict = await c.call('fs.write', { projectPath: demo, path: 'readme.md', content: 'x', expectedMtimeMs: read.mtimeMs - 10_000 });
    expect(conflict.error.code).toBe('conflict');

    await c.call('fs.write', { projectPath: demo, path: 'src/new.ts', content: 'export const a = 1;\n' });
    expect((await c.call('fs.read', { projectPath: demo, path: '../config.json' })).error.code).toBe('forbidden');
    expect((await c.call('fs.list', { projectPath: tmp, dir: '' })).error.code).toBe('forbidden');
    c.close();
  });

  it('shows git status/diff, stages and commits', async () => {
    const c = await Client.connect(TOKEN);
    const demo = path.join(projectsRoot, 'demo');
    const projectPath = (await c.call('projects.list')).result[0].path;
    const st = (await c.call('git.status', { projectPath })).result;
    expect(st.branch).toBe('main');
    expect(st.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'readme.md', workingDir: 'M' }),
        expect.objectContaining({ path: 'src/', index: '?' }),
      ]),
    );
    const diff = (await c.call('git.diff', { projectPath, path: 'readme.md' })).result.diff;
    expect(diff).toContain('+hello world');
    expect((await c.call('git.stage', { projectPath, paths: ['readme.md', 'src/new.ts'] })).result.ok).toBe(true);
    const commit = (await c.call('git.commit', { projectPath, message: 'from niCode' })).result;
    expect(commit.hash).toMatch(/^[0-9a-f]{40}$/);
    const log = (await c.call('git.log', { projectPath, limit: 5 })).result;
    expect(log[0].message).toBe('from niCode');
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: demo }).toString()).toBe('');
    c.close();
  });

  it('picks up a new browser token from the config file without a restart', async () => {
    const c = await Client.connect(TOKEN);
    const devices = (await c.call('auth.devices')).result;
    expect(devices).toEqual([expect.objectContaining({ id: 'd_test', kind: 'token', current: true })]);

    // Simulate `nicode token add tablet --expires 1h` editing the config file.
    const cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
    const tablet = 'c'.repeat(64);
    cfg.devices.push({ id: 'd_tab', name: 'tablet', sha256: sha(tablet), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    await writeFile(cfgPath, JSON.stringify(cfg));
    let t: C | null = null;
    for (let i = 0; i < 30 && !t; i++) {
      t = await Client.connect(tablet).catch(() => null);
      if (!t) await new Promise((r) => setTimeout(r, 100));
    }
    expect(t).not.toBeNull();
    expect((await t!.call('server.info')).result.device).toMatchObject({ name: 'tablet', kind: 'token' });
    t!.close();
    c.close();
  });
});
