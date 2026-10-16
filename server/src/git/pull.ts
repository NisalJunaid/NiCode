/**
 * Pulls that never trip over local changes: a preflight shows what's uncommitted and what a pull
 * would bring in; the pull itself is fast-forward only, and local changes are either stashed
 * (kept, recoverable) or discarded on request.
 */
import type { PullPreflight } from '../../../protocol/types.js';
import { RpcError } from '../rpc.js';
import { run } from '../util/exec.js';

const env = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });

async function git(cwd: string, args: string[], timeoutMs = 60_000) {
  return run('git', args, { cwd, env: env(), timeoutMs });
}

async function gitOk(cwd: string, args: string[], timeoutMs = 120_000): Promise<string> {
  const r = await git(cwd, args, timeoutMs);
  if (r.code !== 0) throw new RpcError('bad_request', `git ${args[0]} failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join('\n')}`);
  return (r.stdout + r.stderr).trim();
}

/** `git status --porcelain` lines (empty = clean). */
export async function dirtyFiles(dir: string): Promise<string[]> {
  const r = await git(dir, ['status', '--porcelain=v1']);
  if (r.code !== 0) throw new RpcError('bad_request', `git status failed: ${r.stderr.trim()}`);
  return r.stdout.split('\n').filter((l) => l.trim() !== '');
}

export async function pullPreflight(dir: string): Promise<PullPreflight> {
  const fetch = await git(dir, ['fetch', '--prune', '--quiet'], 120_000);
  const fetchError = fetch.code === 0 ? null : (fetch.stderr || fetch.stdout).trim().split('\n').slice(-2).join('\n') || 'git fetch failed';
  const branch = (await git(dir, ['symbolic-ref', '--short', '-q', 'HEAD'])).stdout.trim() || null;
  const up = await git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const upstream = up.code === 0 ? up.stdout.trim() : null;
  let ahead = 0;
  let behind = 0;
  let incoming: PullPreflight['incoming'] = [];
  if (upstream) {
    const counts = (await git(dir, ['rev-list', '--left-right', '--count', 'HEAD...@{u}'])).stdout.trim().split(/\s+/);
    ahead = Number(counts[0] ?? 0);
    behind = Number(counts[1] ?? 0);
    const log = await git(dir, ['log', '-n', '50', '--format=%h%x1f%s%x1f%an%x1f%aI', 'HEAD..@{u}']);
    incoming = log.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [hash = '', subject = '', author = '', date = ''] = l.split('\x1f');
        return { hash, subject, author, date };
      });
  }
  return { branch, upstream, dirty: await dirtyFiles(dir), ahead, behind, incoming, fetchError };
}

/**
 * Fast-forward pull. Local changes stop it (RpcError 'dirty') unless `onDirty` is 'stash' (kept as
 * "nicode: before pull <date>") or 'discard' (reset + clean; the caller checks authorization).
 */
export async function safePull(dir: string, onDirty?: 'stash' | 'discard'): Promise<{ output: string; stash?: string }> {
  const dirty = await dirtyFiles(dir);
  let stash: string | undefined;
  const out: string[] = [];
  if (dirty.length) {
    if (!onDirty) {
      throw new RpcError('dirty', `There are ${dirty.length} uncommitted change(s) on this server. Stash or discard them first.`, { dirty: dirty.slice(0, 200) });
    }
    if (onDirty === 'stash') {
      stash = `nicode: before pull ${new Date().toISOString()}`;
      out.push(await gitOk(dir, ['stash', 'push', '--include-untracked', '-m', stash]));
    } else {
      out.push(await gitOk(dir, ['reset', '--hard', 'HEAD']));
      out.push(await gitOk(dir, ['clean', '-fd']));
    }
  }
  out.push(await gitOk(dir, ['pull', '--ff-only'], 300_000));
  return { output: out.filter(Boolean).join('\n'), ...(stash ? { stash } : {}) };
}

export async function shortHead(dir: string): Promise<string | null> {
  const r = await git(dir, ['rev-parse', '--short', 'HEAD']);
  return r.code === 0 ? r.stdout.trim() : null;
}
