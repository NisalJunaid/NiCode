/**
 * Temporary dev servers (hot reload) for live preview: one per project, run by the daemon (not
 * pm2), bound to 127.0.0.1 on a free port. Stopped on request, after 2 h without preview use,
 * or when the daemon stops. Output streams as `tasks.output` with the dev server's opId.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import stripAnsi from 'strip-ansi';
import type { DevServer } from '../../../protocol/types.js';
import { devCommand } from '../apps/catalog.js';
import { events } from '../events.js';
import { log } from '../log.js';
import { RpcError } from '../rpc.js';
import { freePort, waitForPort } from '../util/net.js';
import { cleanEnv } from '../util/stream.js';
import { lastPreviewUse } from './proxy.js';

const MAX_DEV = 3;
const IDLE_MS = 2 * 3600_000;
const KEEP = 100_000;

interface Running {
  info: DevServer;
  proc: ChildProcess;
  output: string;
}
const devs = new Map<string, Running>();

function kill(proc: ChildProcess): void {
  if (proc.exitCode !== null || !proc.pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-proc.pid, 'SIGTERM'); // the whole group: npm → node → esbuild…
  } catch {
    proc.kill('SIGTERM');
  }
}

export function devStatus(projectPath: string): { dev: DevServer | null; output: string } {
  const d = devs.get(projectPath);
  return { dev: d ? { ...d.info } : null, output: d?.output ?? '' };
}

export function devOptions(projectPath: string): { available: boolean; command: string | null; framework: string | null; reason?: string } {
  const cmd = devCommand(projectPath, 5173);
  if (!cmd) return { available: false, command: null, framework: null, reason: 'No dev script found (looked for dev, serve or start in package.json, or a Laravel artisan file).' };
  return { available: true, command: cmd.command.replace('5173', '<port>'), framework: cmd.framework };
}

export async function devStart(projectPath: string, opId?: string): Promise<DevServer> {
  const existing = devs.get(projectPath);
  if (existing && existing.info.state !== 'exited') return { ...existing.info };
  if ([...devs.values()].filter((d) => d.info.state !== 'exited').length >= MAX_DEV) {
    throw new RpcError('busy', `Up to ${MAX_DEV} dev servers can run at once. Stop one first.`);
  }
  const used = new Set([...devs.values()].map((d) => d.info.port));
  const port = await freePort(5170, used);
  const cmd = devCommand(projectPath, port);
  if (!cmd) throw new RpcError('bad_request', 'No dev script found in this project.');

  const id = opId ?? randomUUID();
  const info: DevServer = { projectPath, port, command: cmd.command, framework: cmd.framework, state: 'starting', startedAt: new Date().toISOString(), exitCode: null, opId: id };
  const env = cleanEnv({ PORT: String(port), HOST: '127.0.0.1', BROWSER: 'none', NODE_ENV: 'development', FORCE_COLOR: '0' });
  delete env.CI; // some dev servers turn off watching in CI mode
  const proc = spawn(cmd.file, cmd.args, {
    cwd: projectPath,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    // npm/pnpm are .cmd shims on Windows (dev machines only); the arguments are built by us.
    shell: process.platform === 'win32',
  });
  const run: Running = { info, proc, output: `$ ${cmd.command}\n` };
  devs.set(projectPath, run);
  lastPreviewUse.set(port, Date.now());
  events.emit('tasks.output', { opId: id, chunk: run.output });

  let pending = '';
  let timer: NodeJS.Timeout | null = null;
  const onData = (d: Buffer) => {
    const text = stripAnsi(d.toString('utf8'));
    run.output = (run.output + text).slice(-KEEP);
    pending += text;
    timer ??= setTimeout(() => {
      timer = null;
      events.emit('tasks.output', { opId: id, chunk: pending });
      pending = '';
    }, 150);
  };
  proc.stdout?.on('data', onData);
  proc.stderr?.on('data', onData);
  proc.on('error', (err) => onData(Buffer.from(`\n${err.message}\n`)));
  proc.on('exit', (code) => {
    info.state = 'exited';
    info.exitCode = code;
    onData(Buffer.from(`\n[niCode] dev server stopped (exit ${code ?? 'signal'})\n`));
    log.info({ projectPath, code }, 'dev server exited');
  });

  const up = await waitForPort(port, 120_000, () => info.state === 'exited');
  if (!up) {
    kill(proc);
    const tail = run.output.trim().split('\n').slice(-6).join('\n');
    throw new RpcError('bad_request', info.state === 'exited' ? 'The dev server stopped while starting' : `Nothing answered on port ${port} after 2 minutes`, { output: tail });
  }
  info.state = 'running';
  log.info({ projectPath, port, cmd: cmd.command }, 'dev server running');
  return { ...info };
}

export function devStop(projectPath: string): void {
  const d = devs.get(projectPath);
  if (!d) return;
  kill(d.proc);
  devs.delete(projectPath);
}

export function stopAllDev(): void {
  for (const p of [...devs.keys()]) devStop(p);
}

/** Stops dev servers nobody has previewed for 2 hours; forgets ones that exited long ago. */
export function startDevJanitor(): void {
  setInterval(() => {
    for (const [p, d] of devs) {
      const last = Math.max(Date.parse(d.info.startedAt), lastPreviewUse.get(d.info.port) ?? 0);
      if (Date.now() - last < IDLE_MS) continue;
      if (d.info.state !== 'exited') log.info({ projectPath: p }, 'stopping idle dev server');
      devStop(p);
    }
  }, 5 * 60_000).unref();
}
