/**
 * Repository fingerprints for Analyze chats: taken before and after every turn, so a change to the
 * repository (which Analyze itself can't make) is reported instead of going unnoticed.
 * Only reads: `--no-optional-locks` keeps `git status` from refreshing the index.
 */
import { run } from '../util/exec.js';

export interface RepoFingerprint {
  head: string | null;
  /**
   * "refname sha" lines for local refs. Excluded: niCode's checkpoint refs (other chats make those)
   * and remote-tracking refs (a fetch updates them without touching local work).
   */
  refs: string[];
  stashes: string[];
  /** `git status --porcelain` lines. */
  status: string[];
}

const env = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });

async function lines(cwd: string, args: string[]): Promise<string[] | null> {
  const r = await run('git', ['--no-optional-locks', ...args], { cwd, env: env(), timeoutMs: 60_000 }).catch(() => null);
  if (!r || r.code !== 0) return null;
  return r.stdout.split('\n').filter((l) => l.trim() !== '');
}

/** Null when the project isn't a git repository (or git fails). */
export async function repoFingerprint(dir: string): Promise<RepoFingerprint | null> {
  const [head, refs, stashes, status] = await Promise.all([
    lines(dir, ['rev-parse', '--verify', '-q', 'HEAD']),
    lines(dir, ['for-each-ref', '--format=%(refname) %(objectname)']),
    lines(dir, ['stash', 'list', '--format=%H %gs']),
    lines(dir, ['status', '--porcelain=v1']),
  ]);
  if (!refs || !status) return null;
  return {
    head: head?.[0] ?? null,
    refs: refs.filter((r) => !r.startsWith('refs/nicode/') && !r.startsWith('refs/remotes/')),
    stashes: stashes ?? [],
    status,
  };
}

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : 'none');

/** Human-readable differences (empty when nothing changed). */
export function diffFingerprints(a: RepoFingerprint, b: RepoFingerprint): string[] {
  const out: string[] = [];
  if (a.head !== b.head) out.push(`HEAD ${short(a.head)} → ${short(b.head)}`);
  const refMap = (l: string[]) => new Map(l.map((x) => [x.split(' ')[0]!, x.split(' ')[1]!]));
  const ra = refMap(a.refs);
  const rb = refMap(b.refs);
  for (const [name, sha] of rb) {
    if (!ra.has(name)) out.push(`new ref ${name}`);
    else if (ra.get(name) !== sha) out.push(`${name} ${short(ra.get(name))} → ${short(sha)}`);
  }
  for (const name of ra.keys()) if (!rb.has(name)) out.push(`deleted ref ${name}`);
  if (a.stashes.join('\n') !== b.stashes.join('\n')) out.push(`stashes: ${a.stashes.length} → ${b.stashes.length}`);
  const sa = new Set(a.status);
  const sb = new Set(b.status);
  const added = b.status.filter((x) => !sa.has(x));
  const gone = a.status.filter((x) => !sb.has(x));
  for (const x of added.slice(0, 20)) out.push(`working tree: ${x.trim()}`);
  if (added.length > 20) out.push(`working tree: ${added.length - 20} more changes`);
  if (gone.length) out.push(`working tree: ${gone.length} earlier change${gone.length === 1 ? '' : 's'} gone`);
  return out;
}
