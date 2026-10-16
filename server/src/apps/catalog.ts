/**
 * What can be run in a project: one-tap tasks (install, build, scripts, artisan, migrations, git pull) and
 * how to start it as a long-running app. Pure apart from reading project files.
 * Tasks are fixed argument lists — never shell strings — and run only by id.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { AppStartOptions, ProjectTask } from '../../../protocol/types.js';

export interface TaskSpec extends ProjectTask {
  file: string;
  args: string[];
}

function readJson(p: string): Record<string, any> | null {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Record<string, any>;
  } catch {
    return null;
  }
}

export function envPort(dir: string): number | null {
  try {
    const m = /^PORT\s*=\s*["']?(\d{2,5})["']?\s*$/m.exec(readFileSync(path.join(dir, '.env'), 'utf8'));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn';

export function packageManager(dir: string): PackageManager {
  if (existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function task(id: string, label: string, group: ProjectTask['group'], file: string, args: string[]): TaskSpec {
  return { id, label, group, file, args, command: [file, ...args].join(' ') };
}

/** Install step for this project (null if nothing to install). */
export function installTasks(dir: string): TaskSpec[] {
  const out: TaskSpec[] = [];
  if (existsSync(path.join(dir, 'package.json'))) {
    const pm = packageManager(dir);
    if (pm === 'pnpm') out.push(task('install', 'Install dependencies', 'install', 'pnpm', ['install', '--frozen-lockfile']));
    else if (pm === 'yarn') out.push(task('install', 'Install dependencies', 'install', 'yarn', ['install', '--frozen-lockfile']));
    else if (existsSync(path.join(dir, 'package-lock.json'))) out.push(task('install', 'Install dependencies', 'install', 'npm', ['ci']));
    else out.push(task('install', 'Install dependencies', 'install', 'npm', ['install']));
  }
  if (existsSync(path.join(dir, 'composer.json'))) {
    out.push(task('composer-install', 'Composer install', 'install', 'composer', ['install', '--no-interaction', '--prefer-dist', '--optimize-autoloader']));
  }
  return out;
}

const SCRIPT_ORDER = ['build', 'start', 'start:prod', 'test', 'lint', 'typecheck', 'migrate', 'seed'];

export function listTasks(dir: string): TaskSpec[] {
  const tasks: TaskSpec[] = [];
  if (existsSync(path.join(dir, '.git'))) tasks.push(task('git-pull', 'Pull latest code', 'git', 'git', ['pull', '--ff-only']));
  tasks.push(...installTasks(dir));
  const pkg = readJson(path.join(dir, 'package.json'));
  if (pkg?.scripts && typeof pkg.scripts === 'object') {
    const pm = packageManager(dir);
    const names = Object.keys(pkg.scripts as Record<string, string>).filter((n) => /^[\w:.-]{1,60}$/.test(n) && !/^(pre|post)/.test(n));
    names.sort((a, b) => {
      const ia = SCRIPT_ORDER.indexOf(a);
      const ib = SCRIPT_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });
    for (const n of names) {
      // Long-running dev servers belong in Apps, not one-off tasks.
      if (/^(dev|watch|serve|start|preview)$/.test(n) || /:(dev|watch)$/.test(n)) continue;
      const group = n === 'build' ? 'build' : MIGRATE_SCRIPTS.has(n) ? 'migrate' : 'script';
      tasks.push(task(`script:${n}`, n === 'build' ? 'Build' : n, group, pm, ['run', n]));
    }
  }
  if (existsSync(path.join(dir, 'artisan'))) {
    tasks.push(
      task('artisan-migrate', 'Run migrations', 'migrate', 'php', ['artisan', 'migrate', '--force']),
      task('artisan-optimize', 'Optimize (cache config & routes)', 'php', 'php', ['artisan', 'optimize']),
      task('artisan-clear', 'Clear caches', 'php', 'php', ['artisan', 'optimize:clear']),
      task('artisan-storage-link', 'Link storage', 'php', 'php', ['artisan', 'storage:link']),
    );
  }
  for (const m of migrations(dir)) if (!tasks.some((t) => t.id === m.run.id)) tasks.push(m.run);
  return tasks;
}

const MIGRATE_SCRIPTS = new Set(['migrate', 'db:migrate', 'migrate:deploy', 'migration:run']);

/** Python in the project's virtualenv when it has one. */
function python(dir: string): string {
  for (const v of ['.venv', 'venv', 'env']) {
    const p = path.join(dir, v, 'bin', 'python');
    if (existsSync(p)) return p;
  }
  return 'python3';
}

export interface Migrations {
  framework: string;
  /** Applies pending migrations. */
  run: TaskSpec;
  /** Read-only: lists migrations and which are pending (null when the tool has none). */
  status: TaskSpec | null;
  /** Counts pending migrations in the status output (null: can't tell). */
  pending(statusOutput: string): number | null;
}

/** How this project applies database migrations (empty when it has none we know). */
export function migrations(dir: string): Migrations[] {
  const out: Migrations[] = [];
  const has = (f: string) => existsSync(path.join(dir, f));
  if (has('artisan')) {
    out.push({
      framework: 'Laravel',
      run: task('artisan-migrate', 'Run migrations', 'migrate', 'php', ['artisan', 'migrate', '--force']),
      status: task('artisan-migrate-status', 'Migration status', 'migrate', 'php', ['artisan', 'migrate:status']),
      pending: (o) => (o.match(/\bPending\b/g) ?? []).length,
    });
  }
  if (has('prisma/schema.prisma')) {
    out.push({
      framework: 'Prisma',
      run: task('prisma-migrate', 'Run migrations (Prisma)', 'migrate', 'npx', ['prisma', 'migrate', 'deploy']),
      status: task('prisma-migrate-status', 'Migration status (Prisma)', 'migrate', 'npx', ['prisma', 'migrate', 'status']),
      pending: (o) => (/Database schema is up to date/i.test(o) ? 0 : Number(/(\d+) migrations? (?:found in prisma\/migrations )?(?:have|has) not yet been applied/i.exec(o)?.[1] ?? NaN) || null),
    });
  }
  if (has('manage.py')) {
    const py = python(dir);
    out.push({
      framework: 'Django',
      run: task('django-migrate', 'Run migrations (Django)', 'migrate', py, ['manage.py', 'migrate', '--noinput']),
      status: task('django-showmigrations', 'Migration status (Django)', 'migrate', py, ['manage.py', 'showmigrations', '--plan']),
      pending: (o) => (o.match(/^\[ \]/gm) ?? []).length,
    });
  }
  if (has('bin/rails') && has('db/migrate')) {
    out.push({
      framework: 'Rails',
      run: task('rails-migrate', 'Run migrations (Rails)', 'migrate', 'bin/rails', ['db:migrate']),
      status: task('rails-migrate-status', 'Migration status (Rails)', 'migrate', 'bin/rails', ['db:migrate:status']),
      pending: (o) => (o.match(/^\s*down\s/gm) ?? []).length,
    });
  }
  const pkg = readJson(path.join(dir, 'package.json'));
  const script = Object.keys((pkg?.scripts as Record<string, string> | undefined) ?? {}).find((n) => MIGRATE_SCRIPTS.has(n));
  if (script && !out.length) {
    out.push({ framework: 'npm script', run: task(`script:${script}`, script, 'migrate', packageManager(dir), ['run', script]), status: null, pending: () => null });
  }
  return out;
}

export function hasBuildScript(dir: string): boolean {
  return !!readJson(path.join(dir, 'package.json'))?.scripts?.build;
}

const RUNNABLE = ['start:prod', 'start', 'serve', 'preview', 'prod', 'production'];

/** How to run this project as a long-running app. */
export function startOptions(dir: string): AppStartOptions {
  const pkg = readJson(path.join(dir, 'package.json'));
  const scripts = Object.entries((pkg?.scripts ?? {}) as Record<string, string>)
    .filter(([n]) => RUNNABLE.includes(n) || /^start[:\-]/.test(n))
    .map(([name, command]) => ({ name, command }));
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) } as Record<string, string>;
  const hasBuild = hasBuildScript(dir);
  let port = envPort(dir);
  const best = RUNNABLE.find((r) => scripts.some((s) => s.name === r));
  if (best) {
    port ??= deps.next || deps.nuxt || deps.express || deps.fastify || deps['@nestjs/core'] ? 3000 : null;
    const why = deps.next ? 'Next.js' : deps.nuxt ? 'Nuxt' : deps['@nestjs/core'] ? 'NestJS' : 'Node';
    return { scripts, suggested: { kind: 'script', script: best }, port, hasBuild, reason: `${why} app: runs \`${packageManager(dir)} run ${best}\`${hasBuild ? ' after building' : ''}` };
  }
  for (const f of ['dist/main.js', 'dist/index.js', 'build/index.js', 'server.js', 'index.js', 'app.js', 'main.js']) {
    if (existsSync(path.join(dir, f))) {
      return { scripts, suggested: { kind: 'command', command: `node ${f}` }, port: port ?? 3000, hasBuild, reason: `Runs ${f} with Node` };
    }
  }
  const req = (() => {
    try {
      return readFileSync(path.join(dir, 'requirements.txt'), 'utf8');
    } catch {
      return '';
    }
  })();
  if (/fastapi|uvicorn/i.test(req)) {
    const p = port ?? 8000;
    return { scripts, suggested: { kind: 'command', command: `python3 -m uvicorn main:app --host 127.0.0.1 --port ${p}` }, port: p, hasBuild, reason: 'FastAPI app: runs with uvicorn' };
  }
  if (existsSync(path.join(dir, 'artisan'))) {
    return { scripts, suggested: null, port: null, hasBuild, reason: 'Laravel is served by nginx + PHP (add a domain); use Apps only for queue workers, e.g. `php artisan queue:work`' };
  }
  return { scripts, suggested: null, port, hasBuild, reason: 'No start script found. Enter the command that starts your app.' };
}

/** "node dist/main.js --x 'a b'" → ["node","dist/main.js","--x","a b"] (no shell features). */
export function splitCommand(cmd: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

export interface DevCommand {
  file: string;
  args: string[];
  command: string;
  framework: string | null;
}

const DEV_SCRIPTS = ['dev', 'develop', 'start:dev', 'serve', 'start'];

/**
 * How to run this project's dev server (hot reload) on `port`, bound to 127.0.0.1.
 * Adds the framework's own port/host flags where `PORT` alone isn't honoured.
 */
export function devCommand(dir: string, port: number): DevCommand | null {
  const pkg = readJson(path.join(dir, 'package.json'));
  const scripts = (pkg?.scripts ?? {}) as Record<string, string>;
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) } as Record<string, string>;
  const laravel = existsSync(path.join(dir, 'artisan'));
  const script = laravel ? undefined : DEV_SCRIPTS.find((s) => typeof scripts[s] === 'string' && /^[\w:.-]+$/.test(s));
  if (script) {
    const body = scripts[script]!;
    const p = String(port);
    // Flags go after `--` so the package manager passes them to the framework's CLI.
    let framework: string | null = null;
    let extra: string[] = [];
    if (deps.next || /\bnext\b/.test(body)) [framework, extra] = ['Next.js', ['-p', p, '-H', '127.0.0.1']];
    else if (deps.nuxt || /\bnuxi?\b/.test(body)) [framework, extra] = ['Nuxt', ['--port', p, '--host', '127.0.0.1']];
    else if (deps.astro || /\bastro\b/.test(body)) [framework, extra] = ['Astro', ['--port', p, '--host', '127.0.0.1']];
    else if (deps['@angular/cli'] || /\bng serve\b/.test(body)) [framework, extra] = ['Angular', ['--port', p, '--host', '127.0.0.1']];
    else if (deps.vite || /\bvite\b/.test(body)) [framework, extra] = ['Vite', ['--port', p, '--host', '127.0.0.1', '--strictPort']];
    const pm = packageManager(dir);
    const args = ['run', script, ...(extra.length ? (pm === 'npm' ? ['--', ...extra] : extra) : [])];
    return { file: pm, args, command: [pm, ...args].join(' '), framework };
  }
  if (laravel) {
    const args = ['artisan', 'serve', '--host=127.0.0.1', `--port=${port}`];
    return { file: 'php', args, command: ['php', ...args].join(' '), framework: 'Laravel' };
  }
  return null;
}
