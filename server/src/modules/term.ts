import * as pty from 'node-pty';
import path from 'node:path';
import { z } from 'zod';
import type { TermInfo } from '../../../protocol/types.js';
import { app } from '../app.js';
import { events } from '../events.js';
import { log } from '../log.js';
import { resolveProject } from '../paths.js';
import { register, RpcError } from '../rpc.js';
import { run } from '../util/exec.js';
import { touchProject } from './projects.js';

const PREFIX = 'nicode-';
const RING_BYTES = 256 * 1024;

/** One PTY client attached to a tmux session. termId === tmux session name, so it survives restarts. */
interface Term {
  id: string;
  cwd: string;
  cols: number;
  rows: number;
  proc: pty.IPty;
  ring: Buffer[];
  ringBytes: number;
  pending: string;
  flushTimer: NodeJS.Timeout | null;
}

const terms = new Map<string, Term>();
let hasTmux: boolean | null = null;

async function tmuxAvailable(): Promise<boolean> {
  if (hasTmux === null) hasTmux = await run('tmux', ['-V'], { timeoutMs: 5000 }).then((r) => r.code === 0, () => false);
  return hasTmux;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'shell';
}

function info(t: Term): TermInfo {
  return { termId: t.id, name: t.id.slice(PREFIX.length), cwd: t.cwd, cols: t.cols, rows: t.rows, attached: true };
}

function ptyEnv(): Record<string, string> {
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>;
  env.LANG ??= 'C.UTF-8';
  delete env.NICODE_CONFIG;
  return env;
}

async function spawnTerm(id: string, cwd: string, cols: number, rows: number, attachOnly: boolean): Promise<Term> {
  let file: string;
  let args: string[];
  if (await tmuxAvailable()) {
    file = 'tmux';
    args = attachOnly ? ['attach-session', '-t', id] : ['new-session', '-A', '-s', id, '-c', cwd];
  } else {
    // No tmux: a plain login shell (won't survive daemon restarts).
    file = process.env.SHELL || '/bin/bash';
    args = ['-l'];
  }
  const proc = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env: ptyEnv() });
  const t: Term = { id, cwd, cols, rows, proc, ring: [], ringBytes: 0, pending: '', flushTimer: null };
  const flush = () => {
    t.flushTimer = null;
    if (!t.pending) return;
    const buf = Buffer.from(t.pending, 'utf8');
    t.pending = '';
    t.ring.push(buf);
    t.ringBytes += buf.length;
    while (t.ringBytes > RING_BYTES && t.ring.length > 1) t.ringBytes -= t.ring.shift()!.length;
    events.emit('term.data', { termId: id, data: buf.toString('base64') });
  };
  proc.onData((d) => {
    t.pending += d;
    if (t.pending.length > 32 * 1024) flush();
    else t.flushTimer ??= setTimeout(flush, 16);
  });
  proc.onExit(({ exitCode }) => {
    flush();
    if (terms.get(id) === t) terms.delete(id);
    events.emit('term.exit', { termId: id, code: exitCode });
  });
  terms.set(id, t);
  return t;
}

async function tmuxSessions(): Promise<{ id: string; cwd: string }[]> {
  if (!(await tmuxAvailable())) return [];
  const r = await run('tmux', ['list-sessions', '-F', '#{session_name}\t#{pane_current_path}'], { timeoutMs: 5000 }).catch(() => null);
  if (!r || r.code !== 0) return [];
  return r.stdout
    .split('\n')
    .map((l) => l.split('\t'))
    .filter(([n]) => n?.startsWith(PREFIX))
    .map(([id, cwd]) => ({ id: id!, cwd: cwd ?? '' }));
}

const Size = { cols: z.number().int().min(10).max(1000), rows: z.number().int().min(3).max(500) };

export function registerTermModule(): void {
  register('term.open', z.object({ cwd: z.string(), name: z.string().max(60).optional(), ...Size }), async ({ cwd, name, cols, rows }) => {
    const dir = await resolveProject(app.config.projectsRoot, cwd);
    const id = PREFIX + slug(name ?? path.basename(dir));
    let t = terms.get(id);
    if (t) {
      t.proc.resize(cols, rows);
      Object.assign(t, { cols, rows });
    } else {
      t = await spawnTerm(id, dir, cols, rows, false);
    }
    void touchProject(dir);
    return info(t);
  });

  register('term.attach', z.object({ termId: z.string(), ...Size }), async ({ termId, cols, rows }) => {
    if (!termId.startsWith(PREFIX)) throw new RpcError('bad_request', 'Not a niCode terminal');
    let t = terms.get(termId);
    if (!t) {
      // Daemon restarted but the tmux session is still alive: re-attach.
      const s = (await tmuxSessions()).find((x) => x.id === termId);
      if (!s) throw new RpcError('not_found', 'Terminal has ended');
      t = await spawnTerm(termId, s.cwd || app.config.projectsRoot, cols, rows, true);
    } else {
      t.proc.resize(cols, rows);
      Object.assign(t, { cols, rows });
    }
    return { info: info(t), replay: Buffer.concat(t.ring).toString('base64') };
  });

  register('term.write', z.object({ termId: z.string(), data: z.string() }), ({ termId, data }) => {
    const t = terms.get(termId);
    if (!t) throw new RpcError('not_found', 'Terminal is not attached; call term.attach');
    t.proc.write(Buffer.from(data, 'base64').toString('utf8'));
    return { ok: true as const };
  });

  register('term.resize', z.object({ termId: z.string(), ...Size }), ({ termId, cols, rows }) => {
    const t = terms.get(termId);
    if (!t) throw new RpcError('not_found', 'Terminal is not attached');
    t.proc.resize(cols, rows);
    Object.assign(t, { cols, rows });
    return { ok: true as const };
  });

  register('term.close', z.object({ termId: z.string(), kill: z.boolean().optional() }), async ({ termId, kill }) => {
    const t = terms.get(termId);
    if (t) {
      terms.delete(termId);
      t.proc.kill();
    }
    if (kill && termId.startsWith(PREFIX)) await run('tmux', ['kill-session', '-t', termId], { timeoutMs: 5000 }).catch(() => undefined);
    return { ok: true as const };
  });

  register('term.list', z.object({}).passthrough(), async () => {
    const out = new Map<string, TermInfo>();
    for (const s of await tmuxSessions()) {
      out.set(s.id, { termId: s.id, name: s.id.slice(PREFIX.length), cwd: s.cwd, cols: 80, rows: 24, attached: false });
    }
    for (const t of terms.values()) out.set(t.id, info(t));
    return [...out.values()];
  });
}

/** Detach PTY clients on shutdown; tmux sessions keep running (unit uses KillMode=process). */
export function detachAllTerms(): void {
  for (const t of terms.values()) {
    try {
      t.proc.kill();
    } catch (err) {
      log.debug({ err }, 'pty kill failed');
    }
  }
  terms.clear();
}
