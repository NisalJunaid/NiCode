import { z } from 'zod';
import type { GitCommit, GitFileStatus, GitStatus } from '../../../protocol/types.js';
import { resolveInProject } from '../paths.js';
import { register, RpcError } from '../rpc.js';
import { run, runOk } from '../util/exec.js';
import { requireConfirmation } from '../auth/confirm.js';
import { CP_REF_RE } from '../claude/checkpoints.js';
import * as history from '../git/history.js';
import { pullPreflight, safePull } from '../git/pull.js';
import { app } from '../app.js';
import { projectBusy } from './claude.js';
import { projectOf } from './projects.js';

const Hash = z.string().regex(/^[0-9a-f]{7,40}$/);
const Proof = z.object({ nonce: z.string().min(16).max(100), sig: z.string().min(16).max(2000) });

const env = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });

function git(cwd: string, args: string[], timeoutMs = 60_000) {
  return runOk('git', args, { cwd, env: env(), timeoutMs }).catch((err: Error) => {
    throw new RpcError('bad_request', err.message);
  });
}

/** Parses `git status --porcelain=v1 -b -z`. */
export function parseStatus(out: string): GitStatus {
  const parts = out.split('\0');
  const res: GitStatus = { branch: null, ahead: 0, behind: 0, files: [] };
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (!p) continue;
    if (p.startsWith('## ')) {
      // "main...origin/main [ahead 1, behind 2]" | "main" | "No commits yet on main" | "HEAD (no branch)"
      const head = p.slice(3);
      const name = head
        .replace(/^(No commits yet on|Initial commit on) /, '')
        .split('...')[0]!
        .split(' ')[0]!;
      res.branch = head.startsWith('HEAD (no branch)') ? null : name || null;
      res.ahead = Number(/ahead (\d+)/.exec(head)?.[1] ?? 0);
      res.behind = Number(/behind (\d+)/.exec(head)?.[1] ?? 0);
      continue;
    }
    const f: GitFileStatus = { index: p[0]!, workingDir: p[1]!, path: p.slice(3) };
    if (f.index === 'R' || f.index === 'C') f.renamedFrom = parts[++i];
    res.files.push(f);
  }
  return res;
}

async function relPaths(project: string, paths: string[]): Promise<string[]> {
  for (const p of paths) await resolveInProject(project, p);
  return paths;
}

const P = { projectPath: z.string() };
const Paths = z.object({ ...P, paths: z.array(z.string().min(1)).min(1).max(1000) });

export function registerGitModule(): void {
  register('git.status', z.object(P), async ({ projectPath }) => {
    const project = await projectOf(projectPath);
    return parseStatus((await git(project, ['status', '--porcelain=v1', '-b', '-z'])).stdout);
  });

  const CpRef = z.string().regex(CP_REF_RE);
  register(
    'git.diff',
    z.object({ ...P, path: z.string().optional(), staged: z.boolean().optional(), base: CpRef.optional(), head: CpRef.optional(), commit: Hash.optional() }),
    async ({ projectPath, path, staged, base, head, commit }) => {
      const project = await projectOf(projectPath);
      if (path) await resolveInProject(project, path);
      if (commit) {
        // One commit's changes (Phase 6 history).
        const args = ['show', '--no-color', '--no-ext-diff', '--format=', '-M', commit];
        if (path) args.push('--', path);
        return { diff: (await git(project, args)).stdout };
      }
      if (base) {
        // One Claude turn's changes: checkpoint before → after (or → the files now).
        const args = ['diff', '--no-color', '--no-ext-diff', '-M', base, ...(head ? [head] : []), '--relative'];
        if (path) args.push('--', path);
        return { diff: (await git(project, args)).stdout };
      }
      if (path && !staged) {
        // Untracked files have no diff against the index; show them as all-added.
        const st = parseStatus((await git(project, ['status', '--porcelain=v1', '-z', '--', path])).stdout);
        if (st.files[0]?.index === '?') {
          const r = await run('git', ['diff', '--no-color', '--no-index', '--', '/dev/null', path], { cwd: project, env: env(), okCodes: [0, 1] });
          return { diff: r.stdout };
        }
      }
      const args = ['diff', '--no-color', '--no-ext-diff'];
      if (staged) args.push('--cached');
      if (path) args.push('--', path);
      return { diff: (await git(project, args)).stdout };
    },
  );

  register('git.stage', Paths, async ({ projectPath, paths }) => {
    const project = await projectOf(projectPath);
    await git(project, ['add', '--', ...(await relPaths(project, paths))]);
    return { ok: true as const };
  });

  register('git.unstage', Paths, async ({ projectPath, paths }) => {
    const project = await projectOf(projectPath);
    await git(project, ['restore', '--staged', '--', ...(await relPaths(project, paths))]);
    return { ok: true as const };
  });

  register('git.discard', Paths, async ({ projectPath, paths }) => {
    const project = await projectOf(projectPath);
    await relPaths(project, paths);
    const st = parseStatus((await git(project, ['status', '--porcelain=v1', '-z', '--', ...paths])).stdout);
    const untracked = st.files.filter((f) => f.index === '?').map((f) => f.path);
    const tracked = paths.filter((p) => !untracked.includes(p));
    if (tracked.length) await git(project, ['restore', '--staged', '--worktree', '--source=HEAD', '--', ...tracked]);
    if (untracked.length) await git(project, ['clean', '-fd', '--', ...untracked]);
    return { ok: true as const };
  });

  register('git.commit', z.object({ ...P, message: z.string().min(1).max(10_000) }), async ({ projectPath, message }) => {
    const project = await projectOf(projectPath);
    await git(project, ['commit', '-m', message]);
    return { hash: (await git(project, ['rev-parse', 'HEAD'])).stdout.trim() };
  });

  register('git.push', z.object(P), async ({ projectPath }) => {
    const project = await projectOf(projectPath);
    const upstream = await run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: project, env: env() });
    const args = upstream.code === 0 ? ['push'] : ['push', '-u', 'origin', 'HEAD'];
    const r = await git(project, args, 120_000);
    return { ok: true as const, output: (r.stdout + r.stderr).trim() };
  });

  register('git.pull', z.object({ ...P, onDirty: z.enum(['stash', 'discard']).optional(), proof: Proof.optional() }), async ({ projectPath, onDirty, proof }, ctx) => {
    const project = await projectOf(projectPath);
    if (onDirty === 'discard' && app.production) requireConfirmation(ctx, 'git.pull', [projectPath, 'discard'], proof);
    if (projectBusy(project)) throw new RpcError('busy', 'Claude is working in this project. Stop it first.');
    const r = await safePull(project, onDirty);
    return { ok: true as const, ...r };
  });

  register('git.pullPreflight', z.object(P), async ({ projectPath }) => pullPreflight(await projectOf(projectPath)));

  register('git.log', z.object({ ...P, limit: z.number().int().min(1).max(500).optional(), skip: z.number().int().min(0).max(1_000_000).optional() }), async ({ projectPath, limit, skip }) =>
    history.log(await projectOf(projectPath), limit ?? 50, skip ?? 0),
  );

  register('git.show', z.object({ ...P, hash: Hash }), async ({ projectPath, hash }) => history.show(await projectOf(projectPath), hash));

  register('git.restorePreview', z.object({ ...P, hash: Hash }), async ({ projectPath, hash }) => {
    const project = await projectOf(projectPath);
    return history.preview(project, hash, projectBusy(project));
  });

  // Destructive: needs a fresh biometric confirmation from the phone (auth.confirmChallenge).
  register('git.restoreTo', z.object({ ...P, hash: Hash, mode: z.enum(['commit', 'reset']), proof: Proof }), async ({ projectPath, hash, mode, proof }, ctx) => {
    const project = await projectOf(projectPath);
    requireConfirmation(ctx, 'git.restoreTo', [projectPath, hash, mode], proof); // bound to exactly what the phone sent
    if (projectBusy(project)) throw new RpcError('busy', 'Claude is working in this project. Stop it first.');
    return history.restoreTo(project, hash, mode);
  });

  register('git.undoRestore', z.object({ ...P, backupRef: z.string().regex(history.BACKUP_RE), proof: Proof }), async ({ projectPath, backupRef, proof }, ctx) => {
    const project = await projectOf(projectPath);
    requireConfirmation(ctx, 'git.undoRestore', [projectPath, backupRef], proof);
    if (projectBusy(project)) throw new RpcError('busy', 'Claude is working in this project. Stop it first.');
    return history.undoRestore(project, backupRef);
  });

  register('git.backups', z.object(P), async ({ projectPath }) => history.backups(await projectOf(projectPath)));

  register('git.branches', z.object(P), async ({ projectPath }) => {
    const project = await projectOf(projectPath);
    const all = (await git(project, ['branch', '--format=%(refname:short)'])).stdout.split('\n').filter(Boolean);
    const cur = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: project, env: env() });
    return { current: cur.code === 0 ? cur.stdout.trim() : null, all };
  });

  register('git.checkout', z.object({ ...P, branch: z.string().min(1).max(250), create: z.boolean().optional() }), async ({ projectPath, branch, create }) => {
    const project = await projectOf(projectPath);
    if (branch.startsWith('-')) throw new RpcError('bad_request', 'Invalid branch name');
    await git(project, ['check-ref-format', '--branch', branch]);
    await git(project, create ? ['checkout', '-b', branch] : ['checkout', branch]);
    return { ok: true as const };
  });
}
