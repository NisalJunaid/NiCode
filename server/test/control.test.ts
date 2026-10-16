/**
 * The local control socket used by `nicode deploy` and hosting panels: an allowlist of methods,
 * callers recorded by name, and production guards that still need a phone.
 */
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDaemon, type TestDaemon } from './helpers.js';

function socketOf(d: TestDaemon): string {
  return process.platform === 'win32' ? String.raw`\\.\pipe\nicode-control-` + d.proc.pid : path.join(d.tmp, 'data', 'control.sock');
}

function post(d: TestDaemon, body: string, actor = 'panel'): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: socketOf(d), path: '/rpc', method: 'POST', headers: { 'content-type': 'application/json', 'x-nicode-actor': actor } },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function rpc(d: TestDaemon, method: string, params: unknown = {}) {
  // The socket comes up right after /health; retry briefly on a fresh daemon.
  for (let i = 0; ; i++) {
    try {
      return await post(d, JSON.stringify({ method, params }));
    } catch (err) {
      if (i > 50) throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

const restartOnly = { pull: false, install: false, build: false, migrate: false, restart: true };

describe('control socket (development server)', () => {
  let d: TestDaemon;
  beforeAll(async () => {
    d = await startDaemon();
  });
  afterAll(() => d?.stop());

  it('answers allowed methods', async () => {
    const r = await rpc(d, 'server.info');
    expect(r.status).toBe(200);
    expect(r.json.result.role).toBe('development');
  });

  it('refuses everything else', async () => {
    expect((await rpc(d, 'fs.read', { projectPath: d.demo, path: 'readme.md' })).status).toBe(403);
    expect((await rpc(d, 'term.open')).json.error.code).toBe('forbidden');
    expect((await post(d, 'not json')).status).toBe(400);
  });

  it('runs deploys and records who asked', async () => {
    const r = await rpc(d, 'deploy.run', { projectPath: d.demo, steps: restartOnly });
    expect(r.status).toBe(200);
    expect(r.json.result).toMatchObject({ ok: true, device: 'panel' });
    expect(r.json.result.steps).toEqual([expect.objectContaining({ step: 'restart', status: 'skipped' })]);

    const hist = await rpc(d, 'deploy.history', { projectPath: d.demo });
    expect(hist.json.result[0].device).toBe('panel');
  });

  it('keeps project paths inside projectsRoot', async () => {
    const r = await rpc(d, 'deploy.plan', { projectPath: path.dirname(d.projectsRoot) });
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe('forbidden');
  });
});

describe('control socket (production server)', () => {
  let d: TestDaemon;
  beforeAll(async () => {
    d = await startDaemon({ config: { role: 'production' } });
  });
  afterAll(() => d?.stop());

  it('cannot run migrations without a phone', async () => {
    const r = await rpc(d, 'deploy.run', { projectPath: d.demo, steps: { ...restartOnly, restart: false, migrate: true } });
    expect(r.json.error).toMatchObject({ code: 'forbidden' });
  });
});
