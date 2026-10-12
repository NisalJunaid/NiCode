import { watch, type FSWatcher } from 'chokidar';
import { existsSync } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { FsEntry, SearchMatch } from '../../../protocol/types.js';
import { events } from '../events.js';
import { log } from '../log.js';
import { resolveInProject, toRel } from '../paths.js';
import { register, RpcError } from '../rpc.js';
import { run } from '../util/exec.js';
import { projectOf } from './projects.js';

const MAX_READ = 1024 * 1024;
const IGNORED_DIRS = ['.git', 'node_modules', 'vendor', '.next', '.nuxt', 'dist', 'build', '.cache', '.turbo', 'storage/framework', 'storage/logs'];

// ── file watching: one chokidar watcher per project, shared by the sockets viewing it ──
const watchers = new Map<string, { watcher: FSWatcher; clients: Set<string>; pending: Set<string>; timer: NodeJS.Timeout | null }>();

function subscribe(projectReal: string, clientId: string): void {
  let w = watchers.get(projectReal);
  if (!w) {
    const ignoredRe = new RegExp(`(^|/)(${IGNORED_DIRS.map((d) => d.replace(/[.]/g, '\\.')).join('|')})(/|$)`);
    const watcher = watch(projectReal, {
      ignoreInitial: true,
      depth: 12,
      ignored: (p: string) => ignoredRe.test(toRel(projectReal, p)),
    });
    const entry = { watcher, clients: new Set<string>(), pending: new Set<string>(), timer: null as NodeJS.Timeout | null };
    const flush = () => {
      entry.timer = null;
      const paths = [...entry.pending];
      entry.pending.clear();
      if (paths.length) events.emit('fs.changed', { projectPath: projectReal, paths });
    };
    watcher.on('all', (_evt, p) => {
      entry.pending.add(toRel(projectReal, p));
      entry.timer ??= setTimeout(flush, 300);
    });
    watcher.on('error', (err) => log.warn({ err, projectReal }, 'watcher error'));
    watchers.set(projectReal, entry);
    w = entry;
  }
  w.clients.add(clientId);
}

events.onClientClosed((clientId) => {
  for (const [p, w] of watchers) {
    w.clients.delete(clientId);
    if (w.clients.size === 0) {
      void w.watcher.close();
      if (w.timer) clearTimeout(w.timer);
      watchers.delete(p);
    }
  }
});

async function ignoredSet(projectReal: string, rels: string[]): Promise<Set<string>> {
  if (rels.length === 0 || !existsSync(path.join(projectReal, '.git'))) return new Set();
  const r = await run('git', ['check-ignore', '--stdin', '-z'], { cwd: projectReal, input: rels.join('\0') + '\0', timeoutMs: 15_000, okCodes: [0, 1] }).catch(() => null);
  return new Set((r?.stdout ?? '').split('\0').filter(Boolean));
}

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

const P = { projectPath: z.string() };

export function registerFsModule(): void {
  register('fs.list', z.object({ ...P, dir: z.string() }), async ({ projectPath, dir }, ctx) => {
    const project = await projectOf(projectPath);
    const abs = await resolveInProject(project, dir || '.');
    const dirents = await readdir(abs, { withFileTypes: true }).catch(() => {
      throw new RpcError('not_found', `${dir} is not a directory`);
    });
    const items = dirents.filter((d) => d.name !== '.git');
    const rels = items.map((d) => toRel(project, path.join(abs, d.name)));
    const ignored = await ignoredSet(project, rels);
    const entries: FsEntry[] = await Promise.all(
      items.map(async (d, i) => {
        const full = path.join(abs, d.name);
        const st = await lstat(full).catch(() => null);
        const type: FsEntry['type'] = st?.isSymbolicLink() ? 'symlink' : st?.isDirectory() ? 'dir' : 'file';
        return { name: d.name, path: rels[i]!, type, size: st?.size ?? 0, mtimeMs: st?.mtimeMs ?? 0, ignored: ignored.has(rels[i]!) };
      }),
    );
    subscribe(project, ctx.clientId);
    return entries.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));
  });

  register('fs.read', z.object({ ...P, path: z.string() }), async ({ projectPath, path: rel }) => {
    const project = await projectOf(projectPath);
    const abs = await resolveInProject(project, rel);
    const st = await stat(abs).catch(() => null);
    if (!st || !st.isFile()) throw new RpcError('not_found', `${rel} is not a file`);
    const fh = await open(abs, 'r');
    try {
      const len = Math.min(st.size, MAX_READ);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, 0);
      const binary = isBinary(buf);
      return {
        content: buf.toString(binary ? 'base64' : 'utf8'),
        encoding: binary ? ('base64' as const) : ('utf8' as const),
        mtimeMs: st.mtimeMs,
        size: st.size,
        truncated: st.size > MAX_READ,
      };
    } finally {
      await fh.close();
    }
  });

  register(
    'fs.write',
    z.object({ ...P, path: z.string().min(1), content: z.string(), expectedMtimeMs: z.number().optional() }),
    async ({ projectPath, path: rel, content, expectedMtimeMs }) => {
      const project = await projectOf(projectPath);
      const abs = await resolveInProject(project, rel);
      const st = await stat(abs).catch(() => null);
      if (st?.isDirectory()) throw new RpcError('bad_request', `${rel} is a directory`);
      if (expectedMtimeMs !== undefined && st && Math.abs(st.mtimeMs - expectedMtimeMs) > 1) {
        throw new RpcError('conflict', `${rel} changed on the server since you opened it`, { mtimeMs: st.mtimeMs });
      }
      await mkdir(path.dirname(abs), { recursive: true });
      const tmp = `${abs}.nicode-${process.pid}-${Date.now()}.tmp`;
      await writeFile(tmp, content, { mode: st ? st.mode & 0o7777 : 0o644 });
      await rename(tmp, abs);
      return { mtimeMs: (await stat(abs)).mtimeMs };
    },
  );

  register('fs.rename', z.object({ ...P, from: z.string().min(1), to: z.string().min(1) }), async ({ projectPath, from, to }) => {
    const project = await projectOf(projectPath);
    const a = await resolveInProject(project, from);
    const b = await resolveInProject(project, to);
    if (a === project) throw new RpcError('forbidden', 'Cannot rename the project folder');
    if (existsSync(b)) throw new RpcError('conflict', `${to} already exists`);
    await mkdir(path.dirname(b), { recursive: true });
    await rename(a, b);
    return { ok: true as const };
  });

  register('fs.delete', z.object({ ...P, path: z.string().min(1) }), async ({ projectPath, path: rel }) => {
    const project = await projectOf(projectPath);
    const abs = await resolveInProject(project, rel);
    if (abs === project) throw new RpcError('forbidden', 'Cannot delete the project folder');
    await rm(abs, { recursive: true, force: false });
    return { ok: true as const };
  });

  register(
    'fs.search',
    z.object({ ...P, query: z.string().min(1).max(500), regex: z.boolean().optional(), glob: z.string().max(200).optional(), maxResults: z.number().int().min(1).max(2000).optional() }),
    async ({ projectPath, query, regex, glob, maxResults }) => {
      const project = await projectOf(projectPath);
      const max = maxResults ?? 200;
      const args = ['--json', '--max-count', '5', '--max-columns', '300', '--max-filesize', '2M'];
      if (!regex) args.push('-F');
      if (glob) args.push('-g', glob);
      args.push('--', query, '.');
      const r = await run('rg', args, { cwd: project, timeoutMs: 30_000, okCodes: [0, 1] }).catch(() => {
        throw new RpcError('internal', 'ripgrep (rg) is not installed on the server');
      });
      const out: SearchMatch[] = [];
      for (const line of r.stdout.split('\n')) {
        if (out.length >= max) break;
        if (!line.startsWith('{"type":"match"')) continue;
        const m = JSON.parse(line) as {
          data: { path: { text?: string }; line_number: number; lines: { text?: string }; submatches: { start: number }[] };
        };
        out.push({
          path: (m.data.path.text ?? '').replace(/^\.\//, ''),
          line: m.data.line_number,
          column: (m.data.submatches[0]?.start ?? 0) + 1,
          preview: (m.data.lines.text ?? '').replace(/\r?\n$/, '').slice(0, 300),
        });
      }
      return out;
    },
  );
}
