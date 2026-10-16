/**
 * Long-running apps with pm2, plus one-tap project tasks.
 *
 * - pm2 keeps apps running (restart on crash) and, after `apps.setup`, restores them on boot.
 * - Apps get a clean environment (never the daemon's tokens) plus the user's variables.
 * - Tasks and builds run by id from a fixed catalog (no shell strings).
 */
import path from 'node:path';
import { z } from 'zod';
import type { AppProcess, AppsStatus } from '../../../protocol/types.js';
import { app } from '../app.js';
import { hasBuildScript, installTasks, listTasks, packageManager, splitCommand, startOptions } from '../apps/catalog.js';
import { requireConfirmation } from '../auth/confirm.js';
import { isGitRepo } from '../claude/checkpoints.js';
import { dirtyFiles, safePull } from '../git/pull.js';
import { log } from '../log.js';
import { register, RpcError } from '../rpc.js';
import { run } from '../util/exec.js';
import { portListening, waitForPort } from '../util/net.js';
import { Steps } from '../util/steps.js';
import { priv } from '../util/priv.js';
import { cleanEnv, runStreaming } from '../util/stream.js';
import { projectOf } from './projects.js';

const NAME_RE = /^[A-Za-z0-9._-]{1,60}$/;

// ── pm2 helpers ──────────────────────────────────────────────────────────────

export async function pm2(args: string[], timeoutMs = 60_000) {
  return run('pm2', args, { timeoutMs, env: cleanEnv({ PM2_HOME: process.env.PM2_HOME ?? path.join(app.home, '.pm2') }) }).catch(() => ({ code: 127, stdout: '', stderr: 'pm2 is not installed' }));
}

async function pm2Version(): Promise<string | null> {
  const r = await pm2(['--version'], 20_000);
  return r.code === 0 ? r.stdout.trim().split('\n').pop() ?? null : null;
}

function projectFor(cwd: string, hinted?: string): string | null {
  const root = app.config.projectsRoot.replace(/[\\/]+$/, '');
  const p = hinted || cwd;
  if (!p.startsWith(root + '/') && !p.startsWith(root + '\\')) return null;
  const name = p.slice(root.length + 1).split(/[\\/]/)[0];
  return name ? path.join(root, name) : null;
}

interface Pm2Proc {
  name: string;
  pm_id: number;
  monit?: { cpu?: number; memory?: number };
  pm2_env?: Record<string, any> & { env?: Record<string, string> };
}

export async function listApps(): Promise<AppProcess[]> {
  const r = await pm2(['jlist']);
  if (r.code !== 0) return [];
  let procs: Pm2Proc[] = [];
  try {
    // pm2 may print warnings before the JSON array.
    procs = JSON.parse(r.stdout.slice(r.stdout.indexOf('['))) as Pm2Proc[];
  } catch {
    return [];
  }
  return Promise.all(
    procs.map(async (p): Promise<AppProcess> => {
      const env = p.pm2_env ?? {};
      const inner = (env.env ?? {}) as Record<string, string>;
      const portStr = env.PORT ?? inner.PORT;
      const port = portStr && /^\d{2,5}$/.test(String(portStr)) ? Number(portStr) : null;
      const cwd = String(env.pm_cwd ?? '');
      const exec = String(env.pm_exec_path ?? '');
      const args = Array.isArray(env.args) ? (env.args as string[]) : [];
      const isNpm = /npm(-cli)?(\.js)?$/.test(exec) || /[\\/](npm|pnpm|yarn)$/.test(exec);
      const command = isNpm ? `${path.basename(exec).replace(/-cli\.js$/, '')} ${args.join(' ')}` : `${path.relative(cwd, exec) || exec} ${args.join(' ')}`.trim();
      return {
        name: p.name,
        pmId: p.pm_id,
        status: String(env.status ?? 'unknown'),
        cpu: p.monit?.cpu ?? 0,
        memoryMb: Math.round((p.monit?.memory ?? 0) / 1024 / 1024),
        uptimeSince: env.status === 'online' && env.pm_uptime ? new Date(Number(env.pm_uptime)).toISOString() : null,
        restarts: Number(env.restart_time ?? 0),
        cwd,
        projectPath: projectFor(cwd, inner.NICODE_PROJECT ?? env.NICODE_PROJECT),
        command,
        port,
        listening: port && env.status === 'online' ? await portListening(port) : port ? false : null,
        managed: (inner.NICODE_MANAGED ?? env.NICODE_MANAGED) === '1',
      };
    }),
  );
}

async function getApp(name: string): Promise<AppProcess> {
  const a = (await listApps()).find((x) => x.name === name);
  if (!a) throw new RpcError('not_found', `No app named ${name}`);
  return a;
}

async function status(): Promise<AppsStatus> {
  const [node, pm] = await Promise.all([run('node', ['-v'], { timeoutMs: 10_000 }).catch(() => null), pm2Version()]);
  const user = process.env.USER || (app.isRoot ? 'root' : '');
  const startup = user ? await run('systemctl', ['is-enabled', `pm2-${user}`], { timeoutMs: 10_000 }).catch(() => null) : null;
  return { node: node?.code === 0 ? node.stdout.trim() : null, pm2: pm, startupEnabled: startup?.code === 0 };
}

// ── step reporting ───────────────────────────────────────────────────────────

const Proof = z.object({ nonce: z.string().min(16).max(100), sig: z.string().min(16).max(2000) });

/** Fast-forward pull as a step; stops on uncommitted changes unless told to stash or discard them. */
export async function pullStep(steps: Steps, dir: string, onDirty?: 'stash' | 'discard'): Promise<void> {
  const label = 'Pull latest code';
  if (!(await isGitRepo(dir))) {
    steps.set('pull', label, 'skipped', 'Not a git repository');
    return;
  }
  steps.set('pull', label, 'running', onDirty ? `git pull --ff-only (${onDirty} local changes first)` : 'git pull --ff-only');
  try {
    const r = await safePull(dir, onDirty);
    steps.set('pull', label, 'done', r.stash ? `Local changes stashed as "${r.stash}"` : r.output.split('\n').pop());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    steps.set('pull', label, 'failed', msg);
    throw err;
  }
}

export async function installAndBuild(steps: Steps, dir: string): Promise<void> {
  const env = cleanEnv({ NODE_ENV: 'development' }); // dev deps are needed to build
  for (const t of installTasks(dir)) await steps.exec(t.id, t.label, dir, t.file, t.args, env);
  if (hasBuildScript(dir)) await steps.exec('build', 'Build', dir, packageManager(dir), ['run', 'build'], cleanEnv({ NODE_ENV: 'production' }));
  else steps.set('build', 'Build', 'skipped', 'No build script');
}

// ── API ──────────────────────────────────────────────────────────────────────

const CreateSchema = z.object({
  projectPath: z.string(),
  name: z.string().regex(NAME_RE),
  start: z.union([
    z.object({ kind: z.literal('script'), script: z.string().regex(/^[\w:.-]{1,60}$/) }),
    z.object({ kind: z.literal('command'), command: z.string().min(1).max(500) }),
  ]),
  port: z.number().int().min(1).max(65535).optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.string().max(4000)).optional(),
  buildFirst: z.boolean().optional(),
  opId: z.string().max(64).optional(),
});

export function registerAppsModule(): void {
  register('apps.status', z.object({}).passthrough(), status);

  register('apps.setup', z.object({ opId: z.string().max(64).optional() }), async ({ opId }) => {
    const steps = new Steps(opId);
    if (!(await pm2Version())) {
      steps.set('pm2', 'Install pm2', 'running', 'npm install -g pm2');
      const r = await priv('npm', ['install', '-g', 'pm2'], 600_000);
      if (r.code !== 0) {
        steps.set('pm2', 'Install pm2', 'failed', r.stderr.trim().split('\n').slice(-3).join('\n'));
        throw new RpcError('internal', 'Could not install pm2');
      }
      steps.set('pm2', 'Install pm2', 'done');
    } else steps.set('pm2', 'Install pm2', 'skipped', 'already installed');
    steps.set('startup', 'Start apps on boot', 'running');
    const user = process.env.USER || (app.isRoot ? 'root' : '');
    const which = await run('sh', ['-c', 'command -v pm2'], { timeoutMs: 10_000 }).catch(() => null);
    const pm2Bin = which?.stdout.trim() || 'pm2';
    const r = await priv('env', [`PATH=${process.env.PATH ?? ''}`, pm2Bin, 'startup', 'systemd', '-u', user, '--hp', app.home], 120_000);
    if (r.code !== 0) steps.set('startup', 'Start apps on boot', 'failed', (r.stderr || r.stdout).trim().split('\n').slice(-2).join('\n'));
    else steps.set('startup', 'Start apps on boot', 'done');
    await pm2(['save']);
    return status();
  });

  register('apps.list', z.object({}).passthrough(), listApps);

  register('apps.startOptions', z.object({ projectPath: z.string() }), async ({ projectPath }) => startOptions(await projectOf(projectPath)));

  register('apps.create', CreateSchema, async (p) => {
    if (!(await pm2Version())) throw new RpcError('setup_required', 'pm2 is not installed yet. Set it up first.');
    const dir = await projectOf(p.projectPath);
    if ((await listApps()).some((a) => a.name === p.name)) throw new RpcError('conflict', `An app named ${p.name} already exists`);
    const steps = new Steps(p.opId);
    if (p.buildFirst) await installAndBuild(steps, dir);

    const env = cleanEnv({
      NODE_ENV: 'production',
      ...(p.env ?? {}),
      ...(p.port ? { PORT: String(p.port) } : {}),
      NICODE_PROJECT: dir,
      NICODE_MANAGED: '1',
      PM2_HOME: process.env.PM2_HOME ?? path.join(app.home, '.pm2'),
    });
    let args: string[];
    if (p.start.kind === 'script') {
      args = ['start', packageManager(dir), '--name', p.name, '--cwd', dir, '--time', '--', 'run', p.start.script];
    } else {
      const [bin, ...rest] = splitCommand(p.start.command);
      if (!bin) throw new RpcError('bad_request', 'Enter a command');
      args = ['start', bin, '--name', p.name, '--cwd', dir, '--time', ...(bin === 'node' ? [] : ['--interpreter', 'none']), ...(rest.length ? ['--', ...rest] : [])];
      if (bin === 'node' && rest[0]) args = ['start', rest[0], '--name', p.name, '--cwd', dir, '--time', ...(rest.length > 1 ? ['--', ...rest.slice(1)] : [])];
    }
    steps.set('start', 'Start with pm2', 'running', `pm2 ${args.join(' ')}`);
    const r = await runStreaming('pm2', args, { cwd: dir, env, opId: p.opId, timeoutMs: 120_000 });
    if (r.code !== 0) {
      steps.set('start', 'Start with pm2', 'failed', r.output.trim().split('\n').slice(-3).join('\n'));
      throw new RpcError('bad_request', 'pm2 could not start the app', { output: r.output.slice(-4000) });
    }
    steps.set('start', 'Start with pm2', 'done');
    await pm2(['save']);
    if (p.port) {
      steps.set('health', `Wait for port ${p.port}`, 'running');
      const ok = await waitForPort(p.port, 25_000);
      steps.set('health', `Wait for port ${p.port}`, ok ? 'done' : 'failed', ok ? 'Answering' : 'Nothing answers yet. Check the logs (wrong port, crash, or slow start).');
    }
    log.info({ name: p.name, dir }, 'app started');
    return { app: await getApp(p.name) };
  });

  register('apps.action', z.object({ name: z.string().regex(NAME_RE), action: z.enum(['start', 'stop', 'restart', 'delete']) }), async ({ name, action }) => {
    await getApp(name);
    const r = await pm2([action, name], 60_000);
    if (r.code !== 0) throw new RpcError('bad_request', (r.stderr || r.stdout).trim().split('\n').slice(-2).join('\n') || `pm2 ${action} failed`);
    await pm2(['save']);
    return { ok: true as const };
  });

  register('apps.logs', z.object({ name: z.string().regex(NAME_RE), lines: z.number().int().min(10).max(2000).optional() }), async ({ name, lines }) => {
    await getApp(name);
    const r = await pm2(['logs', name, '--lines', String(lines ?? 200), '--nostream', '--raw'], 20_000);
    return { text: (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, '') };
  });

  register('apps.deploy', z.object({ name: z.string().regex(NAME_RE), opId: z.string().max(64).optional() }), async ({ name, opId }) => {
    const current = await getApp(name);
    const dir = current.cwd;
    if (!current.projectPath) throw new RpcError('forbidden', 'Only apps inside the projects folder can be deployed from niCode');
    const steps = new Steps(opId);
    await pullStep(steps, dir);
    await installAndBuild(steps, dir);
    steps.set('restart', 'Restart (zero-downtime reload)', 'running');
    const r = await pm2(['reload', name], 120_000);
    if (r.code !== 0) {
      steps.set('restart', 'Restart (zero-downtime reload)', 'failed', (r.stderr || r.stdout).trim().split('\n').slice(-2).join('\n'));
      throw new RpcError('bad_request', 'pm2 reload failed');
    }
    steps.set('restart', 'Restart (zero-downtime reload)', 'done');
    if (current.port) {
      steps.set('health', `Check port ${current.port}`, 'running');
      const ok = await waitForPort(current.port, 25_000);
      steps.set('health', `Check port ${current.port}`, ok ? 'done' : 'failed', ok ? 'Answering' : 'Not answering. See the logs.');
    }
    return { app: await getApp(name), steps: steps.list };
  });

  register('tasks.list', z.object({ projectPath: z.string() }), async ({ projectPath }) =>
    listTasks(await projectOf(projectPath)).map(({ id, label, command, group }) => ({ id, label, command, group })),
  );

  register('tasks.run', z.object({ projectPath: z.string(), taskId: z.string().max(80), opId: z.string().max(64).optional(), proof: Proof.optional() }), async ({ projectPath, taskId, opId, proof }, ctx) => {
    const dir = await projectOf(projectPath);
    const t = listTasks(dir).find((x) => x.id === taskId);
    if (!t) throw new RpcError('not_found', 'That task is not available in this project');
    // Migrations change the production database: fingerprint first.
    if (t.group === 'migrate' && app.production) requireConfirmation(ctx, 'tasks.run', [projectPath, taskId], proof);
    if (t.group === 'git') {
      // Same rule as git.pull: never pull over local changes (the app offers stash / discard).
      const dirty = await dirtyFiles(dir);
      if (dirty.length) throw new RpcError('dirty', `There are ${dirty.length} uncommitted change(s) on this server. Stash or discard them first.`, { dirty: dirty.slice(0, 200) });
    }
    const env = cleanEnv({ GIT_TERMINAL_PROMPT: '0', ...(t.group === 'build' ? { NODE_ENV: 'production' } : {}) });
    return runStreaming(t.file, t.args, { cwd: dir, env, opId, timeoutMs: 30 * 60_000 });
  });
}
