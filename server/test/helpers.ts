import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
export const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const TOKEN = 'a'.repeat(64);

export interface TestDaemon {
  port: number;
  tmp: string;
  projectsRoot: string;
  demo: string;
  cfgPath: string;
  proc: ChildProcess;
  stop(): void;
}

/** Starts the compiled daemon (`npm run build` first) with a temp config and a git repo "demo". */
export async function startDaemon(opts: { claudeToken?: string; claudeBin?: string; env?: Record<string, string> } = {}): Promise<TestDaemon> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'nicode-daemon-'));
  const projectsRoot = path.join(tmp, 'projects');
  const demo = path.join(projectsRoot, 'demo');
  await mkdir(demo, { recursive: true });
  const git = (...a: string[]) => execFileSync('git', a, { cwd: demo, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'Test');
  await writeFile(path.join(demo, 'readme.md'), 'hello\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');

  const port = 17_000 + Math.floor(Math.random() * 3000);
  const cfgPath = path.join(tmp, 'config.json');
  const envFile = path.join(tmp, 'env');
  if (opts.claudeToken) await writeFile(envFile, `CLAUDE_CODE_OAUTH_TOKEN=${opts.claudeToken}\n`);
  await writeFile(
    cfgPath,
    JSON.stringify({
      version: 1,
      bindHost: '127.0.0.1',
      port,
      // A short-lived browser-style token device, so tests can connect without key signing.
      devices: [{ id: 'd_test', name: 'test phone', sha256: sha(TOKEN), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString() }],
      transport: 'local',
      publicHost: 'localhost',
      user: 'tester',
      projectsRoot,
      dataDir: path.join(tmp, 'data'),
      envFile,
      statusFile: path.join(tmp, 'status.json'),
      claudeBin: opts.claudeBin ?? path.join(tmp, 'no-claude-here'),
      appDir: tmp,
    }),
  );
  // Isolated HOME so a real ~/.claude login on this machine doesn't leak in.
  const home = path.join(tmp, 'home');
  await mkdir(home);
  const proc = spawn(process.execPath, [path.join(here, '..')], {
    env: { ...process.env, NICODE_CONFIG: cfgPath, HOME: home, USERPROFILE: home, NICODE_LOG_LEVEL: 'warn', ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr?.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) {
        return { port, tmp, projectsRoot, demo, cfgPath, proc, stop: () => proc.kill('SIGTERM') };
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error('daemon did not start');
}

export class Client {
  private ws!: WebSocket;
  private id = 0;
  private waiting = new Map<number, (m: any) => void>();
  events: any[] = [];
  closed: { code: number; reason: string } | null = null;

  static connect(port: number, token: string): Promise<Client> {
    return Client.connectWith(port, `Bearer ${token}`);
  }

  static async connectWith(port: number, authorization: string): Promise<Client> {
    const c = new Client();
    c.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Authorization: authorization } });
    c.ws.on('close', (code, reason) => {
      c.closed = { code, reason: reason.toString() };
    });
    c.ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if ('id' in m) c.waiting.get(m.id)?.(m);
      else c.events.push(m);
    });
    await new Promise<void>((resolve, reject) => {
      c.ws.once('open', () => resolve());
      c.ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      c.ws.once('error', reject);
    });
    return c;
  }

  call(method: string, params: unknown = {}): Promise<any> {
    const n = ++this.id;
    return new Promise((resolve) => {
      this.waiting.set(n, resolve);
      this.ws.send(JSON.stringify({ id: n, method, params }));
    });
  }

  /** Waits for an event matching the predicate (searching events already received too). */
  async waitEvent(pred: (e: any) => boolean, ms = 10_000): Promise<any> {
    const start = Date.now();
    for (;;) {
      const hit = this.events.find(pred);
      if (hit) return hit;
      if (Date.now() - start > ms) throw new Error('timed out waiting for event');
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  close(): void {
    this.ws.close();
  }
}
