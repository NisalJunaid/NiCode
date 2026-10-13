/**
 * Commit history + "restore the code to a commit", with a safety net: before anything changes,
 * HEAD is saved as refs/nicode/backup/<ts> and uncommitted work as …/<ts>-work, so a restore can
 * always be undone. Both modes refuse while Claude is working in the project.
 *  - commit: a new commit whose files equal the chosen commit (history kept; a normal push works)
 *  - reset:  moves the branch back to the commit (rewrites history; never force-pushes)
 */
import type { GitBackup, GitCommit, GitCommitDetail, RestorePreview, RestoreResult } from '../../../protocol/types.js';
import { changes, restoreFiles, snapshot } from '../claude/checkpoints.js';
import { RpcError } from '../rpc.js';
import { run } from '../util/exec.js';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export const BACKUP_RE = /^refs\/nicode\/backup\/\d{13}$/;
const BACKUP_DAYS = 30;

const env = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });

async function git(cwd: string, args: string[], okCodes = [0]): Promise<string> {
  const r = await run('git', ['-c', 'core.autocrlf=false', ...args], { cwd, env: env(), timeoutMs: 120_000, okCodes });
  if (!okCodes.includes(r.code)) throw new RpcError('bad_request', (r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ') || `git ${args[0]} failed`);
  return r.stdout;
}
const ok = async (cwd: string, args: string[]) => (await run('git', args, { cwd, env: env(), timeoutMs: 60_000, okCodes: [0, 1, 128] })).code === 0;

/** Full hash of a commit, or a clear error. */
export async function resolveCommit(dir: string, hash: string): Promise<string> {
  const out = (await git(dir, ['rev-parse', '--verify', '-q', `${hash}^{commit}`], [0, 1])).trim();
  if (!out) throw new RpcError('not_found', `No commit ${hash} in this project`);
  return out;
}

async function upstreamSet(dir: string): Promise<Set<string> | null> {
  if (!(await ok(dir, ['rev-parse', '--verify', '-q', '@{u}']))) return null;
  const unpushed = (await git(dir, ['rev-list', '@{u}..HEAD'])).split('\n').filter(Boolean);
  return new Set(unpushed);
}

export async function log(dir: string, limit: number, skip: number): Promise<GitCommit[]> {
  const r = await run('git', ['log', '-n', String(limit), `--skip=${skip}`, '--pretty=format:%H%x1f%an%x1f%aI%x1f%s%x1f%D'], { cwd: dir, env: env() });
  if (r.code !== 0) return []; // no commits yet
  const unpushed = await upstreamSet(dir).catch(() => null);
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [hash = '', author = '', date = '', message = '', refs = ''] = l.split('\x1f');
      return { hash, author, date, message, refs: refs ? refs.split(', ').filter(Boolean) : [], pushed: unpushed ? !unpushed.has(hash) : null };
    });
}

export async function show(dir: string, hash: string): Promise<GitCommitDetail> {
  const full = await resolveCommit(dir, hash);
  const [h = '', author = '', email = '', date = '', parents = '', subject = '', body = ''] = (
    await git(dir, ['show', '-s', '--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%P%x1f%s%x1f%b', full])
  ).split('\x1f');
  const parentList = parents.split(' ').filter(Boolean);
  return { hash: h, author, email, date, message: subject, body: body.trim(), parents: parentList, files: await changes(dir, parentList[0] ?? EMPTY_TREE, full) };
}

export async function preview(dir: string, hash: string, busy: boolean): Promise<RestorePreview> {
  const full = await resolveCommit(dir, hash);
  const subject = (await git(dir, ['show', '-s', '--format=%s', full])).trim();
  const isAncestor = await ok(dir, ['merge-base', '--is-ancestor', full, 'HEAD']);
  const commitsAfter = isAncestor ? Number((await git(dir, ['rev-list', '--count', `${full}..HEAD`])).trim()) : 0;
  const files = await changes(dir, 'HEAD', full);
  const dirty = (await git(dir, ['status', '--porcelain', '--', '.'])).trim().length > 0;
  const hasUpstream = await ok(dir, ['rev-parse', '--verify', '-q', '@{u}']);
  const pushedAfter = hasUpstream && isAncestor ? Number((await git(dir, ['rev-list', '--count', `${full}..@{u}`])).trim()) > 0 : false;
  return { hash: full, subject, commitsAfter, files: files.slice(0, 100), totalFiles: files.length, dirty, isAncestor, pushedAfter, busy };
}

async function backup(dir: string): Promise<{ ref: string; head: string }> {
  const head = (await git(dir, ['rev-parse', 'HEAD'])).trim();
  const ref = `refs/nicode/backup/${Date.now()}`;
  await git(dir, ['update-ref', ref, head]);
  // Uncommitted work (tracked + untracked, minus .gitignore) goes into its own snapshot.
  const dirty = (await git(dir, ['status', '--porcelain', '--', '.'])).trim().length > 0;
  if (dirty) await git(dir, ['update-ref', `${ref}-work`, await snapshot(dir, 'nicode backup before restore')]);
  return { ref, head };
}

export async function restoreTo(dir: string, hash: string, mode: 'commit' | 'reset'): Promise<RestoreResult> {
  const full = await resolveCommit(dir, hash);
  const isAncestor = await ok(dir, ['merge-base', '--is-ancestor', full, 'HEAD']);
  if (mode === 'reset' && !isAncestor) throw new RpcError('bad_request', 'That commit is not on the current branch, so the branch cannot be reset to it');
  const { ref, head } = await backup(dir);
  const removedCommits = isAncestor ? Number((await git(dir, ['rev-list', '--count', `${full}..${head}`])).trim()) : 0;

  if (mode === 'reset') {
    await git(dir, ['reset', '--hard', full]);
    const hasUpstream = await ok(dir, ['rev-parse', '--verify', '-q', '@{u}']);
    const needsForcePush = hasUpstream && Number((await git(dir, ['rev-list', '--count', `${full}..@{u}`])).trim()) > 0;
    return { backupRef: ref, head: full, removedCommits, needsForcePush };
  }

  // commit mode: index + files of this folder become exactly the old commit's, then one new commit.
  await git(dir, ['restore', `--source=${full}`, '--staged', '--worktree', '--', '.']);
  if (await ok(dir, ['diff', '--cached', '--quiet'])) {
    throw new RpcError('bad_request', 'The code already matches that commit; nothing to restore (uncommitted changes were backed up)');
  }
  const subject = (await git(dir, ['show', '-s', '--format=%s', full])).trim();
  await git(dir, ['commit', '-q', '-m', `Restore code to ${full.slice(0, 7)}: ${subject}`.slice(0, 200), '-m', `Restored with niCode. Backup: ${ref}`]);
  return { backupRef: ref, head: (await git(dir, ['rev-parse', 'HEAD'])).trim(), removedCommits: 0, needsForcePush: false };
}

export async function undoRestore(dir: string, backupRef: string): Promise<{ head: string }> {
  if (!BACKUP_RE.test(backupRef)) throw new RpcError('bad_request', 'Not a niCode restore point');
  const head = (await git(dir, ['rev-parse', '--verify', '-q', `${backupRef}^{commit}`], [0, 1])).trim();
  if (!head) throw new RpcError('not_found', 'That restore point no longer exists');
  await git(dir, ['reset', '--hard', head]);
  const work = (await git(dir, ['rev-parse', '--verify', '-q', `${backupRef}-work^{commit}`], [0, 1])).trim();
  if (work) await restoreFiles(dir, work);
  return { head };
}

export async function backups(dir: string): Promise<GitBackup[]> {
  const out = await git(dir, ['for-each-ref', '--sort=-refname', '--format=%(refname)%1f%(objectname)%1f%(subject)', 'refs/nicode/backup/']);
  const lines = out.split('\n').filter(Boolean).map((l) => l.split('\x1f') as [string, string, string]);
  const works = new Set(lines.filter(([r]) => r.endsWith('-work')).map(([r]) => r.slice(0, -5)));
  const list: GitBackup[] = [];
  for (const [ref, sha, subject] of lines) {
    if (!BACKUP_RE.test(ref)) continue;
    const ts = Number(ref.split('/').pop());
    if (Date.now() - ts > BACKUP_DAYS * 86_400_000) {
      await git(dir, ['update-ref', '-d', ref]).catch(() => undefined);
      if (works.has(ref)) await git(dir, ['update-ref', '-d', `${ref}-work`]).catch(() => undefined);
      continue;
    }
    list.push({ ref, createdAt: new Date(ts).toISOString(), head: sha, subject, hadUncommitted: works.has(ref) });
  }
  return list;
}
