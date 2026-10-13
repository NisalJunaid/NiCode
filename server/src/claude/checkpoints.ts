/**
 * Checkpoints: snapshots of a project's files taken before every Claude turn, so a turn can be
 * undone. Snapshots are commits made with a temporary index (`git add -A` → `write-tree` →
 * `commit-tree`) and kept under refs/nicode/cp/… — HEAD, the real index, branches and the
 * user's stash are never touched, and pushes don't include them.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { TurnFileChange } from '../../../protocol/types.js';
import { app } from '../app.js';
import { resolveInProject } from '../paths.js';
import { run } from '../util/exec.js';

export const CP_PREFIX = 'refs/nicode/cp/';
export const CP_REF_RE = /^refs\/nicode\/cp\/[A-Za-z0-9-]{1,64}\/[A-Za-z0-9-]{1,40}$/;
const KEEP_PER_PROJECT = 100;

const baseEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  // commit-tree needs an identity; checkpoints are internal, so use a fixed one.
  GIT_AUTHOR_NAME: 'niCode',
  GIT_AUTHOR_EMAIL: 'checkpoint@nicode.local',
  GIT_COMMITTER_NAME: 'niCode',
  GIT_COMMITTER_EMAIL: 'checkpoint@nicode.local',
});

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = baseEnv(), okCodes = [0]): Promise<string> {
  // Store and restore bytes exactly as they are (no CRLF conversion), so a rewind is byte-identical.
  const r = await run('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args], { cwd, env, timeoutMs: 120_000, okCodes });
  if (!okCodes.includes(r.code)) throw new Error(`git ${args[0]} failed: ${r.stderr.trim().split('\n')[0]}`);
  return r.stdout;
}

export async function isGitRepo(dir: string): Promise<boolean> {
  const r = await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, env: baseEnv(), timeoutMs: 10_000, okCodes: [0, 128] }).catch(() => null);
  return r?.code === 0 && r.stdout.trim() === 'true';
}

/** Commits the current files (tracked + untracked, minus .gitignore) without touching HEAD or the index. */
export async function snapshot(dir: string, message = 'nicode checkpoint'): Promise<string> {
  const tmpDir = path.join(app.config.dataDir, 'tmp');
  await mkdir(tmpDir, { recursive: true });
  const index = path.join(tmpDir, `index-${randomUUID()}`);
  const env = { ...baseEnv(), GIT_INDEX_FILE: index };
  try {
    const head = (await git(dir, ['rev-parse', '--verify', '-q', 'HEAD'], env, [0, 1])).trim();
    if (head) await git(dir, ['read-tree', head], env); // start from HEAD: fast, and keeps files outside the project folder
    await git(dir, ['add', '-A', '--', '.'], env);
    const tree = (await git(dir, ['write-tree'], env)).trim();
    return (await git(dir, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', message], env)).trim();
  } finally {
    await rm(index, { force: true });
  }
}

export async function saveRef(dir: string, ref: string, sha: string): Promise<void> {
  if (!CP_REF_RE.test(ref)) throw new Error(`bad checkpoint ref ${ref}`);
  await git(dir, ['update-ref', ref, sha]);
}

export async function resolveRef(dir: string, ref: string): Promise<string | null> {
  if (!CP_REF_RE.test(ref)) return null;
  const out = (await git(dir, ['rev-parse', '--verify', '-q', `${ref}^{commit}`], baseEnv(), [0, 1])).trim();
  return out || null;
}

/** Files changed between two snapshots (paths relative to the project folder). */
export async function changes(dir: string, from: string, to: string): Promise<TurnFileChange[]> {
  const num = await git(dir, ['diff', '--relative', '--numstat', '-z', '-M', from, to, '--', '.']);
  const status = await git(dir, ['diff', '--relative', '--name-status', '-z', '-M', from, to, '--', '.']);
  const st = new Map<string, TurnFileChange['status']>();
  const sp = status.split('\0');
  for (let i = 0; i < sp.length - 1; ) {
    const code = sp[i++]![0] as string;
    if (code === 'R' || code === 'C') {
      i++; // old path
      st.set(sp[i++]!, 'R');
    } else st.set(sp[i++]!, (['A', 'D', 'M'].includes(code) ? code : 'M') as TurnFileChange['status']);
  }
  const out: TurnFileChange[] = [];
  const np = num.split('\0');
  for (let i = 0; i < np.length - 1; i++) {
    const rec = np[i]!;
    const [a, d, p] = rec.split('\t');
    let file = p ?? '';
    if (file === '') {
      // rename: "add\tdel\t" then old\0new\0
      i++;
      file = np[++i] ?? '';
    }
    if (!file) continue;
    out.push({ path: file, status: st.get(file) ?? 'M', add: a === '-' ? 0 : Number(a), del: d === '-' ? 0 : Number(d), binary: a === '-' });
  }
  return out;
}

/**
 * Makes the project's files match `target` (a snapshot). Files created since are deleted.
 * HEAD and the index stay as they are, so `git status` afterwards shows the difference to HEAD.
 */
export async function restoreFiles(dir: string, target: string): Promise<{ changed: number; before: string }> {
  const now = await snapshot(dir, 'nicode before-restore');
  const added = (await git(dir, ['diff', '--relative', '--name-only', '-z', '--diff-filter=A', target, now, '--', '.'])).split('\0').filter(Boolean);
  for (const f of added) await rm(await resolveInProject(dir, f), { force: true });
  await git(dir, ['restore', `--source=${target}`, '--worktree', '--', '.']);
  return { changed: (await changes(dir, now, target)).length, before: now };
}

/** Keeps the newest checkpoints of a project; deletes older refs. */
export async function prune(dir: string): Promise<void> {
  const refs = (await git(dir, ['for-each-ref', '--sort=-creatordate', '--format=%(refname)', CP_PREFIX])).split('\n').filter(Boolean);
  for (const r of refs.slice(KEEP_PER_PROJECT * 2)) await git(dir, ['update-ref', '-d', r]).catch(() => undefined);
}
