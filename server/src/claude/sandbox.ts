/**
 * The Analyze sandbox: Claude runs under bubblewrap with the whole filesystem (and so the project
 * and its .git) mounted read-only, so nothing it runs can change the repository, whatever gets
 * approved by mistake.
 *
 * Read-only mounts alone aren't enough: a process outside the sandbox could do the write for it.
 * Every such path is closed too: other processes are invisible (/proc/<pid>/root), setuid
 * binaries can't elevate (no_new_privs: sudo, crontab, at), and the control sockets of things that
 * run commands (tmux, pm2, docker, the user's systemd and D-Bus) are hidden, as are the git
 * credentials and ssh keys that could push. Everything else (logs, DB sockets, the network) works.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { log } from '../log.js';
import { run } from '../util/exec.js';

export interface SandboxSupport {
  available: boolean;
  /** Why it isn't (null when it is). */
  reason: string | null;
}

export interface SandboxSpec {
  /** Real path of the project; mounted read-only. */
  projectPath: string;
  /** Writable scratch directory for this chat (outside the project). */
  scratchDir: string;
  /** Running as root: drop all capabilities so root can't remount or reach around the sandbox. */
  isRoot: boolean;
  /** Writable CLAUDE_CONFIG_DIR for Analyze chats (the real ~/.claude stays read-only). */
  claudeConfigDir?: string;
  /** Directories Claude must not even read (niCode's data: other accounts' tokens, DB passwords). */
  hideDirs?: string[];
  /** Files inside hidden directories it still needs (its MCP config, the approve socket). */
  exposeFiles?: string[];
}

let support: SandboxSupport = { available: false, reason: 'Not probed yet' };

export function sandboxSupport(): SandboxSupport {
  return support;
}

/** Octal escapes in /proc/self/mountinfo ("\040" = space). */
function unescapeMount(s: string): string {
  return s.replace(/\\([0-7]{3})/g, (_m, o: string) => String.fromCharCode(parseInt(o, 8)));
}

interface MountEntry {
  dev: string;
  root: string;
  mountPoint: string;
}

export function parseMountInfo(text: string): MountEntry[] {
  const out: MountEntry[] = [];
  for (const line of text.split('\n')) {
    const f = line.split(' ');
    if (f.length < 5) continue;
    out.push({ dev: f[2]!, root: unescapeMount(f[3]!), mountPoint: unescapeMount(f[4]!) });
  }
  return out;
}

const under = (parent: string, child: string): boolean => child === parent || child.startsWith(parent.endsWith('/') ? parent : parent + '/');

/**
 * Every path where the project's files are visible: the project itself plus any other mount of
 * the same filesystem subtree (e.g. /var/www bind-mounted as ~/projects), so none stays writable.
 */
export function projectViews(projectPath: string, mounts: MountEntry[], exists: (p: string) => boolean = existsSync): string[] {
  // The mount the project lives on: the longest mount point containing it.
  let home: MountEntry | null = null;
  for (const m of mounts) if (under(m.mountPoint, projectPath) && (!home || m.mountPoint.length > home.mountPoint.length)) home = m;
  if (!home) return [projectPath];
  const rel = path.posix.relative(home.mountPoint, projectPath);
  const fsPath = path.posix.join(home.root, rel); // the project's path inside its filesystem
  const views = new Set([projectPath]);
  for (const m of mounts) {
    if (m.dev !== home.dev) continue;
    if (under(m.root, fsPath)) {
      // This mount shows a directory that contains the project.
      views.add(path.posix.join(m.mountPoint, path.posix.relative(m.root, fsPath)));
    } else if (under(fsPath, m.root)) {
      // This mount shows a directory inside the project.
      views.add(m.mountPoint);
    }
  }
  return [...views].filter((v) => exists(v)).sort();
}

const ENV_FILE = /^\.env(\..+)?$/;
const ENV_EXAMPLE = /\.(example|sample|template|dist)$/;
const SECRET_KEY = /(PASS|SECRET|KEY|TOKEN|PRIVATE|CREDENTIAL|SALT|AUTH|DSN|COOKIE|SESSION)/i;

/** Masks secrets in a .env file: sensitive keys entirely, and passwords inside URLs. */
export function redactEnv(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const m = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_.]*)(\s*=\s*)(.*)$/.exec(line);
      if (!m) return line;
      const [, pre, key, eq, value] = m as unknown as [string, string, string, string, string];
      if (!value.trim()) return line;
      if (SECRET_KEY.test(key)) return `${pre}${key}${eq}<redacted by niCode>`;
      return `${pre}${key}${eq}${value.replace(/(:\/\/[^:/@\s]*:)[^@\s]+@/g, '$1<redacted>@')}`;
    })
    .join('\n');
}

/** Writes redacted copies of the project's top-level .env files; returns [copy, original] pairs. */
async function redactedEnvFiles(projectPath: string, outDir: string): Promise<[string, string][]> {
  const pairs: [string, string][] = [];
  let names: string[] = [];
  try {
    names = await readdir(projectPath);
  } catch {
    return pairs;
  }
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  for (const name of names) {
    if (!ENV_FILE.test(name) || ENV_EXAMPLE.test(name)) continue;
    const original = path.join(projectPath, name);
    try {
      if (!statSync(original).isFile()) continue;
      const copy = path.join(outDir, name);
      await writeFile(copy, redactEnv(await readFile(original, 'utf8')), { mode: 0o600 });
      pairs.push([copy, original]);
    } catch {
      // unreadable: leave it as is (still read-only)
    }
  }
  return pairs;
}

/**
 * bwrap arguments (everything before `--`).
 *
 * The whole filesystem is read-only, not just the project: otherwise Claude could plant something
 * that runs later outside the sandbox (~/.bashrc, a pm2 ecosystem file, the daemon's config,
 * code or permission rules). Writable: a fresh /tmp, this chat's scratch directory, and the
 * Claude config directory used only by Analyze chats (transcripts, so chats can resume).
 */
export async function sandboxArgs(spec: SandboxSpec): Promise<string[]> {
  const home = os.homedir();
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const args = [
    '--die-with-parent',
    '--new-session',
    '--unshare-pid',
    '--unshare-ipc',
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    // Fresh /tmp: hides tmux sockets (/tmp/tmux-<uid>) and other processes' temp files.
    '--tmpfs', '/tmp',
  ];
  const hide = (p: string) => {
    if (!existsSync(p)) return;
    if (statSync(p).isDirectory()) args.push('--tmpfs', p);
    else args.push('--ro-bind', '/dev/null', p);
  };
  hide(`/run/user/${uid}`); // user systemd + D-Bus: systemd-run --user
  hide('/var/run/docker.sock');
  hide('/run/docker.sock');
  hide(path.join(home, '.ssh')); // ssh localhost / git push over ssh
  hide(path.join(home, '.config', 'gh')); // gh: pushing commits through the GitHub API
  hide(path.join(home, '.git-credentials'));
  const pm2Home = process.env.PM2_HOME || path.join(home, '.pm2');
  if (existsSync(pm2Home)) {
    // pm2's control socket would run any command outside; keep only its logs (read-only).
    args.push('--tmpfs', pm2Home);
    const logs = path.join(pm2Home, 'logs');
    if (existsSync(logs)) args.push('--ro-bind', logs, logs);
  }
  if (process.env.TMUX_TMPDIR) hide(process.env.TMUX_TMPDIR);
  for (const d of spec.hideDirs ?? []) hide(d);
  for (const f of spec.exposeFiles ?? []) if (existsSync(f)) args.push('--ro-bind', f, f);

  let mounts: MountEntry[] = [];
  try {
    mounts = parseMountInfo(readFileSync('/proc/self/mountinfo', 'utf8'));
  } catch {
    // no /proc: the project path alone
  }
  for (const view of projectViews(spec.projectPath, mounts)) args.push('--ro-bind', view, view);
  for (const [copy, original] of await redactedEnvFiles(spec.projectPath, path.join(spec.scratchDir, '.nicode-env'))) {
    args.push('--ro-bind', copy, original);
  }
  args.push('--bind', spec.scratchDir, spec.scratchDir);
  if (spec.claudeConfigDir) {
    args.push('--bind', spec.claudeConfigDir, spec.claudeConfigDir);
    // A `claude /login` made on the server: keep using (and refreshing) that login.
    const creds = path.join(home, '.claude', '.credentials.json');
    if (existsSync(creds)) args.push('--bind', creds, path.join(spec.claudeConfigDir, '.credentials.json'));
  }
  if (spec.isRoot) args.push('--cap-drop', 'ALL');
  args.push('--chdir', spec.projectPath);
  return args;
}

/** Environment for the sandboxed process: nothing that points outside at a command runner. */
export function sandboxEnv(env: NodeJS.ProcessEnv, spec: Pick<SandboxSpec, 'scratchDir' | 'claudeConfigDir'>): NodeJS.ProcessEnv {
  const s = spec.scratchDir;
  const out: NodeJS.ProcessEnv = {
    ...env,
    TMPDIR: s,
    NICODE_SCRATCH: s,
    GIT_OPTIONAL_LOCKS: '0',
    // Tools that cache in $HOME (read-only here) cache in the scratch directory instead.
    XDG_CACHE_HOME: path.join(s, '.cache'),
    npm_config_cache: path.join(s, '.npm'),
    COMPOSER_HOME: path.join(s, '.composer'),
    PIP_CACHE_DIR: path.join(s, '.cache', 'pip'),
  };
  if (spec.claudeConfigDir) out.CLAUDE_CONFIG_DIR = spec.claudeConfigDir;
  for (const k of ['TMUX', 'TMUX_PANE', 'TMUX_TMPDIR', 'SSH_AUTH_SOCK', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'DOCKER_HOST', 'GH_TOKEN', 'GITHUB_TOKEN']) delete out[k];
  return out;
}

/**
 * Checks that bubblewrap works here and really makes a directory read-only (a write must fail
 * and a read must succeed). Ubuntu 24.04 needs an AppArmor profile for it (the installer adds one).
 */
export async function probeSandbox(dataDir: string, isRoot: boolean): Promise<SandboxSupport> {
  if (process.env.NICODE_TEST_SANDBOX === 'off' || process.platform !== 'linux') {
    support = { available: false, reason: 'The read-only sandbox needs Linux with bubblewrap' };
    return support;
  }
  const dir = path.join(dataDir, 'tmp', 'sandbox-probe');
  const scratch = path.join(dataDir, 'tmp', 'sandbox-probe-scratch');
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    await writeFile(path.join(dir, 'probe.txt'), 'ok');
    const base = await sandboxArgs({ projectPath: dir, scratchDir: scratch, isRoot });
    const read = await run('bwrap', [...base, '--', 'cat', 'probe.txt'], { timeoutMs: 15_000 });
    if (read.code !== 0 || read.stdout.trim() !== 'ok') {
      const why = (read.stderr || read.stdout).trim().split('\n')[0] ?? '';
      support = { available: false, reason: `bubblewrap doesn't work here${why ? `: ${why}` : ''}. Run \`sudo nicode sandbox\`.` };
    } else {
      const write = await run('bwrap', [...base, '--', 'touch', 'written.txt'], { timeoutMs: 15_000 });
      support = write.code !== 0 && !existsSync(path.join(dir, 'written.txt'))
        ? { available: true, reason: null }
        : { available: false, reason: 'bubblewrap ran, but the project stayed writable' };
    }
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    support = { available: false, reason: missing ? 'bubblewrap is not installed. Run `sudo nicode sandbox`.' : `Sandbox check failed: ${(err as Error).message}` };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
  log.info({ sandbox: support }, 'analyze sandbox');
  return support;
}
