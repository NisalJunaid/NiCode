import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listTasks, splitCommand, startOptions } from '../src/apps/catalog.js';

async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nicode-apps-'));
  for (const [f, c] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, f)), { recursive: true });
    await writeFile(path.join(dir, f), c);
  }
  return dir;
}

describe('task catalog', () => {
  it('offers install, build and scripts for a Node project (dev servers excluded)', async () => {
    const dir = await project({
      'package.json': JSON.stringify({ scripts: { dev: 'vite', build: 'vite build', start: 'node dist/main.js', test: 'vitest', lint: 'eslint .', prebuild: 'x' } }),
      'package-lock.json': '{}',
      '.git/HEAD': 'ref: refs/heads/main',
    });
    const tasks = listTasks(dir);
    expect(tasks.map((t) => t.id)).toEqual(['git-pull', 'install', 'script:build', 'script:test', 'script:lint']);
    expect(tasks.find((t) => t.id === 'install')).toMatchObject({ file: 'npm', args: ['ci'], command: 'npm ci' });
    expect(tasks.find((t) => t.id === 'script:build')).toMatchObject({ label: 'Build', group: 'build', command: 'npm run build' });
  });

  it('uses the project package manager and adds Laravel tasks', async () => {
    const pnpm = await project({ 'package.json': JSON.stringify({ scripts: { build: 'x' } }), 'pnpm-lock.yaml': '' });
    expect(listTasks(pnpm).find((t) => t.id === 'install')?.command).toBe('pnpm install --frozen-lockfile');
    const laravel = await project({ artisan: '', 'composer.json': '{}' });
    expect(listTasks(laravel).map((t) => t.id)).toEqual(['composer-install', 'artisan-migrate', 'artisan-optimize', 'artisan-clear', 'artisan-storage-link']);
  });

  it('never turns weird script names into tasks', async () => {
    const dir = await project({ 'package.json': JSON.stringify({ scripts: { 'ok:name': 'x', 'bad name; rm -rf /': 'x' } }) });
    expect(listTasks(dir).map((t) => t.id)).toEqual(['install', 'script:ok:name']);
  });
});

describe('start options', () => {
  it('prefers start scripts and reads PORT from .env', async () => {
    const dir = await project({ 'package.json': JSON.stringify({ dependencies: { next: '15' }, scripts: { build: 'next build', start: 'next start', dev: 'next dev' } }), '.env': 'PORT=4100\n' });
    expect(startOptions(dir)).toMatchObject({ suggested: { kind: 'script', script: 'start' }, port: 4100, hasBuild: true });
  });
  it('falls back to node entry files, FastAPI and Laravel guidance', async () => {
    expect(startOptions(await project({ 'server.js': '' })).suggested).toEqual({ kind: 'command', command: 'node server.js' });
    expect(startOptions(await project({ 'requirements.txt': 'fastapi\nuvicorn\n' })).suggested).toMatchObject({ kind: 'command' });
    expect(startOptions(await project({ artisan: '' }))).toMatchObject({ suggested: null });
  });
  it('splits commands without a shell', () => {
    expect(splitCommand(`python3 -m uvicorn main:app --root-path "/my api" --x 'a b'`)).toEqual(['python3', '-m', 'uvicorn', 'main:app', '--root-path', '/my api', '--x', 'a b']);
  });
});

describe('tasks API over the daemon', () => {
  it('lists tasks and runs one by id with live output', async () => {
    const { Client, startDaemon, TOKEN } = await import('./helpers.js');
    const d = await startDaemon();
    try {
      const c = await Client.connect(d.port, TOKEN);
      const tasks = (await c.call('tasks.list', { projectPath: d.demo })).result;
      expect(tasks.map((t: any) => t.id)).toEqual(['git-pull']);
      const r = (await c.call('tasks.run', { projectPath: d.demo, taskId: 'git-pull', opId: 'op1' }, )).result;
      expect(r.code).not.toBe(0); // no upstream configured in the test repo
      expect(c.events.some((e: any) => e.event === 'tasks.output' && e.data.opId === 'op1' && e.data.chunk.includes('git pull --ff-only'))).toBe(true);
      expect((await c.call('tasks.run', { projectPath: d.demo, taskId: 'rm -rf /' })).error.code).toBe('not_found');
      expect((await c.call('apps.create', { projectPath: d.demo, name: 'bad name!', start: { kind: 'script', script: 'start' } })).error.code).toBe('bad_request');
      c.close();
    } finally {
      d.stop();
    }
  }, 30_000);
});
