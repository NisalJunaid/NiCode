/**
 * Deploying a project on this server, step by step: pull → install → build → migrate → restart.
 *
 * - The pull is fast-forward only and never runs over local changes (stash or discard first).
 * - Migrations show their status first; on production servers they (and discarding local
 *   changes) need a fresh fingerprint. Laravel apps go into maintenance mode while migrating.
 * - Every run is kept in <dataDir>/deploys.json (last 50 per project) for the app and for
 *   Analyze chats ("it broke after deploy X").
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { type DeployPlan, type DeployRecord, deployGuards } from '../../../protocol/types.js';
import { app } from '../app.js';
import { requireConfirmation } from '../auth/confirm.js';
import { hasBuildScript, installTasks, migrations, packageManager } from '../apps/catalog.js';
import { isGitRepo } from '../claude/checkpoints.js';
import { writeFileAtomic } from '../config.js';
import { dirtyFiles, pullPreflight, shortHead } from '../git/pull.js';
import { log } from '../log.js';
import { register, RpcError } from '../rpc.js';
import { waitForPort } from '../util/net.js';
import { Steps } from '../util/steps.js';
import { cleanEnv, runStreaming } from '../util/stream.js';
import { installAndBuild, listApps, pm2, pullStep } from './apps.js';
import { projectBusy } from './claude.js';
import { projectOf } from './projects.js';
import { sendPush } from './push.js';

const KEEP = 50;
const running = new Set<string>();
const file = () => path.join(app.config.dataDir, 'deploys.json');
let writing: Promise<unknown> = Promise.resolve();

async function loadHistory(): Promise<DeployRecord[]> {
  try {
    return JSON.parse(await readFile(file(), 'utf8')) as DeployRecord[];
  } catch {
    return [];
  }
}

function saveRecord(rec: DeployRecord): Promise<void> {
  const step = async () => {
    const all = [rec, ...(await loadHistory())];
    const perProject = new Map<string, number>();
    const kept = all.filter((r) => {
      const n = (perProject.get(r.projectPath) ?? 0) + 1;
      perProject.set(r.projectPath, n);
      return n <= KEEP;
    });
    await writeFileAtomic(file(), JSON.stringify(kept, null, 2));
  };
  const p = writing.then(step, step);
  writing = p.catch(() => undefined);
  return p;
}

const isLaravel = (dir: string) => existsSync(path.join(dir, 'artisan'));

async function migrationStatus(dir: string): Promise<DeployPlan['migrate']> {
  const m = migrations(dir)[0];
  if (!m) return null;
  let status: string | null = null;
  if (m.status) {
    const r = await runStreaming(m.status.file, m.status.args, { cwd: dir, env: cleanEnv({}), timeoutMs: 90_000 }).catch((err: Error) => ({ code: 1, output: err.message }));
    status = r.output.trim().slice(-3000) || (r.code === 0 ? 'No output' : `exit code ${r.code}`);
  }
  return { taskId: m.run.id, command: m.run.command, status };
}

export async function deployPlan(dir: string): Promise<DeployPlan> {
  const [pull, migrate, apps] = await Promise.all([
    isGitRepo(dir).then((g) => (g ? pullPreflight(dir) : null)),
    migrationStatus(dir),
    listApps().then((all) => all.filter((a) => a.projectPath === dir)),
  ]);
  const build = hasBuildScript(dir) ? `${packageManager(dir)} run build` : null;
  const m = migrations(dir)[0];
  const pending = migrate?.status && m ? m.pending(migrate.status) : null;
  const install = installTasks(dir).map((t) => t.command);
  return {
    production: app.production,
    pull,
    install,
    build: [build, isLaravel(dir) ? 'php artisan optimize' : null].filter(Boolean).join(' && ') || null,
    migrate,
    apps,
    defaults: {
      pull: !!pull,
      install: install.length > 0,
      build: !!build || isLaravel(dir),
      migrate: !!migrate && (pending ?? 0) > 0,
      restart: apps.length > 0,
    },
  };
}

const Steps_ = z.object({ pull: z.boolean(), install: z.boolean(), build: z.boolean(), migrate: z.boolean(), restart: z.boolean() });
const Proof = z.object({ nonce: z.string().min(16).max(100), sig: z.string().min(16).max(2000) });

export function registerDeployModule(): void {
  register('deploy.plan', z.object({ projectPath: z.string() }), async ({ projectPath }) => deployPlan(await projectOf(projectPath)));

  register('deploy.history', z.object({ projectPath: z.string() }), async ({ projectPath }) => {
    const dir = await projectOf(projectPath);
    return (await loadHistory()).filter((r) => r.projectPath === dir);
  });

  register(
    'deploy.run',
    z.object({ projectPath: z.string(), steps: Steps_, onDirty: z.enum(['stash', 'discard']).optional(), proof: Proof.optional(), opId: z.string().max(64).optional() }),
    async ({ projectPath, steps: want, onDirty, proof, opId }, ctx) => {
      const dir = await projectOf(projectPath);
      const guards = deployGuards({ steps: want, onDirty });
      if (app.production && guards.length) requireConfirmation(ctx, 'deploy.run', [projectPath, ...guards], proof);
      if (!Object.values(want).some(Boolean)) throw new RpcError('bad_request', 'Choose at least one step');
      if (projectBusy(dir)) throw new RpcError('busy', 'Claude is changing this project right now. Stop it first.');
      if (running.has(dir)) throw new RpcError('busy', 'A deploy is already running for this project');
      // Refuse up front (before anything runs) so the app can offer stash / discard.
      if (want.pull && !onDirty && (await isGitRepo(dir))) {
        const dirty = await dirtyFiles(dir);
        if (dirty.length) throw new RpcError('dirty', `There are ${dirty.length} uncommitted change(s) on this server. Stash or discard them first.`, { dirty: dirty.slice(0, 200) });
      }

      running.add(dir);
      const steps = new Steps(opId);
      const startedAt = new Date().toISOString();
      const before = await shortHead(dir);
      let ok = true;
      try {
        if (want.pull) await pullStep(steps, dir, onDirty);
        if (want.install || want.build) {
          if (want.install && want.build) await installAndBuild(steps, dir);
          else if (want.install) for (const t of installTasks(dir)) await steps.exec(t.id, t.label, dir, t.file, t.args, cleanEnv({ NODE_ENV: 'development' }));
          else if (hasBuildScript(dir)) await steps.exec('build', 'Build', dir, packageManager(dir), ['run', 'build'], cleanEnv({ NODE_ENV: 'production' }));
          if (want.build && isLaravel(dir)) await steps.exec('optimize', 'Cache config & routes', dir, 'php', ['artisan', 'optimize'], cleanEnv({}));
        }
        if (want.migrate) await migrateStep(steps, dir);
        if (want.restart) await restartStep(steps, dir);
      } catch (err) {
        ok = false;
        if (!(err instanceof RpcError)) log.warn({ err, project: dir }, 'deploy step crashed');
      } finally {
        running.delete(dir);
      }
      const rec: DeployRecord = {
        id: randomUUID(),
        projectPath: dir,
        device: ctx.device.name,
        startedAt,
        finishedAt: new Date().toISOString(),
        before,
        after: await shortHead(dir),
        steps: steps.list,
        ok,
      };
      await saveRecord(rec).catch((err) => log.warn({ err }, 'could not save deploy history'));
      log.info({ project: dir, ok, before: rec.before, after: rec.after, device: rec.device }, 'deploy finished');
      void sendPush(`${ok ? '🚀' : '❌'} ${path.basename(dir)}`, ok ? `Deployed${rec.after && rec.after !== rec.before ? ` ${rec.after}` : ''}` : `Deploy failed: ${steps.list.find((s) => s.status === 'failed')?.label ?? 'see the app'}`, {
        kind: 'result',
        projectPath: dir,
        host: app.config.publicHost,
      });
      return rec;
    },
  );
}

async function migrateStep(steps: Steps, dir: string): Promise<void> {
  const m = migrations(dir)[0];
  if (!m) {
    steps.set('migrate', 'Run migrations', 'skipped', 'No migrations found for this project');
    return;
  }
  const env = cleanEnv({});
  if (!isLaravel(dir)) {
    await steps.exec('migrate', m.run.label, dir, m.run.file, m.run.args, env);
    return;
  }
  // Laravel: maintenance mode while the schema changes, and always back up afterwards.
  await steps.exec('down', 'Maintenance mode on', dir, 'php', ['artisan', 'down', '--retry=15'], env);
  try {
    await steps.exec('migrate', m.run.label, dir, m.run.file, m.run.args, env);
  } finally {
    await steps.exec('up', 'Maintenance mode off', dir, 'php', ['artisan', 'up'], env);
  }
}

async function restartStep(steps: Steps, dir: string): Promise<void> {
  const apps = (await listApps()).filter((a) => a.projectPath === dir);
  if (!apps.length) {
    steps.set('restart', 'Restart', 'skipped', 'No pm2 apps for this project');
    return;
  }
  let failed = false;
  for (const a of apps) {
    const id = `restart:${a.name}`;
    const label = `Restart ${a.name}`;
    steps.set(id, label, 'running', a.status === 'online' ? 'pm2 reload (zero downtime)' : 'pm2 start');
    const r = await pm2([a.status === 'online' ? 'reload' : 'restart', a.name], 120_000);
    if (r.code !== 0) {
      failed = true;
      steps.set(id, label, 'failed', (r.stderr || r.stdout).trim().split('\n').slice(-2).join('\n'));
      continue;
    }
    if (a.port) {
      const up = await waitForPort(a.port, 25_000);
      steps.set(id, label, up ? 'done' : 'failed', up ? `Answering on port ${a.port}` : `Not answering on port ${a.port}. See the logs.`);
      failed ||= !up;
    } else {
      steps.set(id, label, 'done');
    }
  }
  await pm2(['save']);
  if (failed) throw new RpcError('bad_request', 'Restart failed');
}
