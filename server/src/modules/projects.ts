import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Project } from '../../../protocol/types.js';
import { app } from '../app.js';
import { writeFileAtomic } from '../config.js';
import { resolveProject } from '../paths.js';
import { register, RpcError } from '../rpc.js';
import { run, runOk } from '../util/exec.js';
import { githubLoggedIn } from './server.js';

const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

function recentFile(): string {
  return path.join(app.config.dataDir, 'projects.json');
}

async function readRecent(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(recentFile(), 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Remembers when a project was last used (sorts the app's project list). */
export async function touchProject(projectPath: string): Promise<void> {
  const recent = await readRecent();
  recent[projectPath] = new Date().toISOString();
  await writeFileAtomic(recentFile(), JSON.stringify(recent), 0o600).catch(() => undefined);
}

async function describe(p: string, recent: Record<string, string>): Promise<Project> {
  const isGit = existsSync(path.join(p, '.git'));
  let branch: string | null = null;
  if (isGit) {
    const r = await run('git', ['-C', p, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 10_000 }).catch(() => null);
    branch = r && r.code === 0 ? r.stdout.trim() : null;
  }
  return { name: path.basename(p), path: p, isGit, branch, lastOpenedAt: recent[p] ?? null };
}

export function registerProjectsModule(): void {
  register('projects.list', z.object({}).passthrough(), async () => {
    const root = app.config.projectsRoot;
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const recent = await readRecent();
    const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => path.join(root, e.name));
    const projects = await Promise.all(dirs.map((d) => describe(d, recent)));
    return projects.sort((a, b) => (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? '') || a.name.localeCompare(b.name));
  });

  register('projects.create', z.object({ name: z.string().regex(NAME_RE), gitInit: z.boolean().optional() }), async ({ name, gitInit }) => {
    const p = path.join(app.config.projectsRoot, name);
    if (existsSync(p)) throw new RpcError('conflict', `${name} already exists`);
    await mkdir(p);
    if (gitInit) await runOk('git', ['init'], { cwd: p });
    return describe(p, await readRecent());
  });

  register('projects.clone', z.object({ url: z.string().min(3).max(500), name: z.string().regex(NAME_RE).optional() }), async ({ url, name }) => {
    // Accept https/ssh URLs or owner/repo; reject anything that looks like an option.
    if (url.startsWith('-') || !/^(https:\/\/|git@|ssh:\/\/|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$)/.test(url)) {
      throw new RpcError('bad_request', 'Use an https/ssh git URL or owner/repo');
    }
    const derived = (name ?? url.split('/').pop() ?? '').replace(/\.git$/, '');
    if (!NAME_RE.test(derived)) throw new RpcError('bad_request', 'Could not derive a folder name; pass name');
    const target = path.join(app.config.projectsRoot, derived);
    if (existsSync(target)) throw new RpcError('conflict', `${derived} already exists`);
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    const ownerRepo = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(url);
    if (ownerRepo || (await githubLoggedIn())) {
      await runOk('gh', ['repo', 'clone', url, target], { env, timeoutMs: 10 * 60_000 });
    } else {
      await runOk('git', ['clone', '--', url, target], { env, timeoutMs: 10 * 60_000 });
    }
    await touchProject(target);
    return describe(target, await readRecent());
  });

  register('projects.githubRepos', z.object({ limit: z.number().int().min(1).max(1000).optional() }), async ({ limit }) => {
    if (!(await githubLoggedIn())) throw new RpcError('setup_required', 'GitHub is not logged in on this server');
    const r = await runOk('gh', ['repo', 'list', '--json', 'nameWithOwner,url,isPrivate,updatedAt', '--limit', String(limit ?? 100)], {
      timeoutMs: 60_000,
    });
    return JSON.parse(r.stdout) as { nameWithOwner: string; url: string; isPrivate: boolean; updatedAt: string }[];
  });
}

/** Shared by fs/git/term/claude: validates a projectPath param. */
export function projectOf(projectPath: string): Promise<string> {
  return resolveProject(app.config.projectsRoot, projectPath);
}

export async function isDir(p: string): Promise<boolean> {
  return (await stat(p).catch(() => null))?.isDirectory() ?? false;
}
