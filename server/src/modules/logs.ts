/**
 * Logs: a catalog of log sources built on the server (nginx per site, pm2 apps, the niCode
 * daemon, Laravel, syslog), read by id only — the app never sends a path. Root-only files are
 * read through `priv`. Following streams new lines as `logs.data` until unfollowed or the
 * phone disconnects.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { LogSource } from '../../../protocol/types.js';
import { app } from '../app.js';
import { events } from '../events.js';
import { register, RpcError } from '../rpc.js';
import { parseSite } from '../sites/nginx.js';
import { run } from '../util/exec.js';
import { priv } from '../util/priv.js';
import { listApps } from './apps.js';
import { projectOf } from './projects.js';

const NGINX = process.env.NICODE_NGINX_DIR ?? '/etc/nginx';
const LOG_DIR = process.env.NICODE_LOG_DIR ?? '/var/log';
const READ_BYTES = 2 * 1024 * 1024;

type Reader = { kind: 'file'; path: string } | { kind: 'journal'; unit: string };
interface Entry extends LogSource {
  reader: Reader;
}

async function exists(p: string): Promise<boolean> {
  return !!(await stat(p).catch(() => null));
}

/** Newest file in a folder matching a pattern (Laravel daily logs, rotated pm2 logs). */
async function newest(dir: string, re: RegExp): Promise<string | null> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => re.test(n));
  let best: { p: string; t: number } | null = null;
  for (const n of names) {
    const st = await stat(path.join(dir, n)).catch(() => null);
    if (st?.isFile() && (!best || st.mtimeMs > best.t)) best = { p: path.join(dir, n), t: st.mtimeMs };
  }
  return best?.p ?? null;
}

async function catalog(projectPath?: string): Promise<Entry[]> {
  const out: Entry[] = [];
  const projectsRoot = app.config.projectsRoot.replace(/[\\/]+$/, '');
  const projectOfRoot = (root: string | null) => {
    if (!root || !root.startsWith(projectsRoot + '/')) return null;
    const name = root.slice(projectsRoot.length + 1).split('/')[0];
    return name ? path.posix.join(projectsRoot, name) : null;
  };

  // nginx: per site (access_log/error_log directives), then the global logs.
  const sitesDir = path.join(NGINX, 'sites-enabled');
  for (const name of (await readdir(sitesDir).catch(() => [] as string[])).filter((n) => !n.startsWith('nicode-preview-')).sort()) {
    const text = await readFile(path.join(sitesDir, name), 'utf8').catch(() => '');
    const site = parseSite(text);
    const label = site.domains[0] ?? name;
    const proj = projectOfRoot(site.root);
    for (const [kind, re] of [
      ['access', /\baccess_log\s+(\/[^;\s]+)/],
      ['error', /\berror_log\s+(\/[^;\s]+)/],
    ] as const) {
      const p = re.exec(text)?.[1];
      if (p && p !== '/dev/null') out.push({ id: `nginx-${kind}:${name}`, label: `${label} · ${kind}`, group: 'nginx', detail: p, projectPath: proj, reader: { kind: 'file', path: p } });
    }
  }
  for (const kind of ['access', 'error'] as const) {
    const p = path.join(LOG_DIR, 'nginx', `${kind}.log`);
    if (await exists(path.join(LOG_DIR, 'nginx'))) out.push({ id: `nginx-${kind}`, label: `nginx ${kind} (all sites)`, group: 'nginx', detail: p, projectPath: null, reader: { kind: 'file', path: p } });
  }

  // pm2 apps
  const pm2Logs = path.join(process.env.PM2_HOME ?? path.join(app.home, '.pm2'), 'logs');
  if (await exists(pm2Logs)) {
    const apps = await listApps().catch(() => []);
    for (const a of apps) {
      const safe = a.name.replace(/[^A-Za-z0-9._-]/g, '-');
      for (const [kind, suffix] of [
        ['output', 'out'],
        ['errors', 'error'],
      ] as const) {
        const p = await newest(pm2Logs, new RegExp(`^${safe.replace(/[.]/g, '\\.')}-${suffix}(-\\d+)?\\.log$`));
        if (p) out.push({ id: `pm2-${suffix}:${a.name}`, label: `${a.name} · ${kind}`, group: 'pm2', detail: p, projectPath: a.projectPath, reader: { kind: 'file', path: p } });
      }
    }
  }

  // Laravel (every project, or just this one)
  const projects = projectPath ? [projectPath] : (await readdir(projectsRoot).catch(() => [] as string[])).map((n) => path.join(projectsRoot, n));
  for (const proj of projects) {
    const p = await newest(path.join(proj, 'storage', 'logs'), /^laravel(-\d{4}-\d{2}-\d{2})?\.log$/);
    if (p) out.push({ id: `laravel:${path.basename(proj)}`, label: `${path.basename(proj)} · Laravel`, group: 'project', detail: p, projectPath: proj, reader: { kind: 'file', path: p } });
  }

  // The daemon itself, and the system
  out.push({ id: 'nicode', label: 'niCode daemon', group: 'system', detail: 'journalctl -u nicode', projectPath: null, reader: { kind: 'journal', unit: 'nicode' } });
  const syslog = path.join(LOG_DIR, 'syslog');
  if (await exists(syslog)) out.push({ id: 'syslog', label: 'System log', group: 'system', detail: syslog, projectPath: null, reader: { kind: 'file', path: syslog } });

  return projectPath ? out.filter((e) => e.projectPath === projectPath) : out;
}

async function find(id: string): Promise<Entry> {
  const e = (await catalog()).find((x) => x.id === id);
  if (!e) throw new RpcError('not_found', 'Unknown log');
  return e;
}

function lastLines(text: string, n: number, filter?: string): string {
  let lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (filter) {
    const f = filter.toLowerCase();
    lines = lines.filter((l) => l.toLowerCase().includes(f));
  }
  return lines.slice(-n).join('\n');
}

/** The end of a file: read directly when we may, else `tail` as root. */
async function readEnd(file: string, lines: number): Promise<string> {
  try {
    const fh = await open(file, 'r');
    try {
      const { size } = await fh.stat();
      const len = Math.min(size, READ_BYTES);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      const text = buf.toString('utf8');
      return len < size ? text.slice(text.indexOf('\n') + 1) : text; // drop the cut-off first line
    } finally {
      await fh.close();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    const r = await priv('tail', ['-n', String(lines), '--', file], 30_000);
    if (r.code !== 0) throw new RpcError('forbidden', `Can't read ${file}: ${r.stderr.trim() || 'permission denied'}`);
    return r.stdout;
  }
}

async function tail(e: Entry, lines: number, filter?: string): Promise<string> {
  if (e.reader.kind === 'journal') {
    const args = ['-u', e.reader.unit, '-n', String(filter ? 5000 : lines), '--no-pager', '-o', 'short-iso'];
    let r = await run('journalctl', args, { timeoutMs: 30_000 }).catch(() => null);
    if (!r || r.code !== 0 || !r.stdout.trim() || /No journal files|insufficient permissions/i.test(r.stdout + r.stderr)) r = await priv('journalctl', args, 30_000).catch(() => null);
    if (!r || r.code !== 0) throw new RpcError('forbidden', 'journalctl is not available here');
    return lastLines(r.stdout, lines, filter);
  }
  return lastLines(await readEnd(e.reader.path, filter ? 20_000 : lines), lines, filter);
}

// ── follow ───────────────────────────────────────────────────────────────────

interface Follow {
  clientId: string;
  stop: () => void;
}
const follows = new Map<string, Follow>();

function emit(followId: string, chunk: string): void {
  if (chunk) events.emit('logs.data', { followId, chunk });
}

/** Polls a readable file for appended bytes (handles truncation/rotation). */
async function followFile(followId: string, file: string): Promise<() => void> {
  let pos = (await stat(file).catch(() => null))?.size ?? 0;
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const st = await stat(file).catch(() => null);
      if (!st) return;
      if (st.size < pos) pos = 0; // rotated or truncated
      if (st.size > pos) {
        const fh = await open(file, 'r');
        try {
          const len = Math.min(st.size - pos, READ_BYTES);
          const buf = Buffer.alloc(len);
          await fh.read(buf, 0, len, st.size - len);
          pos = st.size;
          emit(followId, buf.toString('utf8'));
        } finally {
          await fh.close();
        }
      }
    } finally {
      busy = false;
    }
  }, 1000);
  return () => clearInterval(timer);
}

function followProcess(followId: string, file: string, args: string[]): () => void {
  const [cmd, cmdArgs] = app.isRoot ? [file, args] : ['sudo', ['-n', file, ...args]];
  const proc: ChildProcess = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout?.on('data', (d: Buffer) => emit(followId, d.toString('utf8')));
  proc.on('error', () => emit(followId, `\n[niCode] could not follow this log\n`));
  return () => proc.kill('SIGTERM');
}

async function follow(e: Entry, clientId: string): Promise<string> {
  const followId = randomUUID();
  let stop: () => void;
  if (e.reader.kind === 'journal') stop = followProcess(followId, 'journalctl', ['-u', e.reader.unit, '-f', '-n', '0', '--no-pager', '-o', 'short-iso']);
  else {
    const readable = await open(e.reader.path, 'r').then(
      (fh) => (void fh.close(), true),
      () => false,
    );
    stop = readable ? await followFile(followId, e.reader.path) : followProcess(followId, 'tail', ['-n', '0', '-F', '--', e.reader.path]);
  }
  follows.set(followId, { clientId, stop });
  return followId;
}

function unfollow(followId: string): void {
  follows.get(followId)?.stop();
  follows.delete(followId);
}

export function registerLogsModule(): void {
  events.onClientClosed((clientId) => {
    for (const [id, f] of follows) if (f.clientId === clientId) unfollow(id);
  });

  register('logs.sources', z.object({ projectPath: z.string().optional() }), async ({ projectPath }) => {
    const entries = await catalog(projectPath ? await projectOf(projectPath) : undefined);
    return entries.map(({ reader: _r, ...s }) => s);
  });

  register('logs.tail', z.object({ id: z.string().max(300), lines: z.number().int().min(1).max(2000).optional(), filter: z.string().max(200).optional() }), async ({ id, lines, filter }) => ({
    text: await tail(await find(id), lines ?? 300, filter?.trim() || undefined),
  }));

  register('logs.follow', z.object({ id: z.string().max(300) }), async ({ id }, ctx) => {
    if ([...follows.values()].filter((f) => f.clientId === ctx.clientId).length >= 4) throw new RpcError('busy', 'Too many logs followed at once');
    return { followId: await follow(await find(id), ctx.clientId) };
  });

  register('logs.unfollow', z.object({ followId: z.string().max(64) }), ({ followId }) => {
    unfollow(followId);
    return { ok: true as const };
  });
}
