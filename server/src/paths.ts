import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { RpcError } from './rpc.js';

function within(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

async function real(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    throw new RpcError('not_found', `${p} does not exist`);
  }
}

/** A project (or terminal cwd) must resolve — after following symlinks — inside projectsRoot. */
export async function resolveProject(projectsRoot: string, projectPath: string): Promise<string> {
  if (!path.isAbsolute(projectPath)) throw new RpcError('bad_request', 'projectPath must be absolute');
  const root = await real(projectsRoot);
  const p = await real(projectPath);
  if (!within(root, p)) throw new RpcError('forbidden', 'Path is outside the projects folder');
  return p;
}

/**
 * Resolves a project-relative path. Rejects absolute paths and `..` escapes, then re-checks the
 * real location of the nearest existing ancestor so symlinks can't point outside the project.
 */
export async function resolveInProject(projectReal: string, rel: string): Promise<string> {
  const clean = rel.replace(/\\/g, '/');
  if (path.isAbsolute(clean) || /^[A-Za-z]:/.test(clean)) throw new RpcError('forbidden', 'Path must be relative to the project');
  const target = path.resolve(projectReal, clean);
  if (!within(projectReal, target)) throw new RpcError('forbidden', 'Path escapes the project');
  let probe = target;
  for (;;) {
    try {
      const r = await realpath(probe);
      if (!within(projectReal, r)) throw new RpcError('forbidden', 'Path escapes the project (symlink)');
      break;
    } catch (err) {
      if (err instanceof RpcError) throw err;
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return target;
}

/** Project-relative path with forward slashes, as the protocol expects. */
export function toRel(projectReal: string, abs: string): string {
  return path.relative(projectReal, abs).split(path.sep).join('/');
}
