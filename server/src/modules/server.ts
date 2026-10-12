import os from 'node:os';
import { z } from 'zod';
import { PROTOCOL_VERSION } from '../../../protocol/types.js';
import { app } from '../app.js';
import { newToken, sha256Hex } from '../auth.js';
import { updateTokens } from '../config.js';
import { applyTokenChange } from '../http.js';
import { NoParams, register, RpcError } from '../rpc.js';
import { run } from '../util/exec.js';

let ghCache: { at: number; ok: boolean } = { at: 0, ok: false };

export async function githubLoggedIn(force = false): Promise<boolean> {
  if (!force && Date.now() - ghCache.at < 60_000) return ghCache.ok;
  let ok = false;
  try {
    ok = (await run('gh', ['auth', 'status'], { timeoutMs: 15_000 })).code === 0;
  } catch {
    ok = false; // gh not installed
  }
  ghCache = { at: Date.now(), ok };
  return ok;
}

/** Applies a token-list change to the running daemon immediately (the file watcher would too). */
async function saveTokens(mutate: Parameters<typeof updateTokens>[0]): Promise<void> {
  app.config.tokens = await updateTokens(mutate);
  applyTokenChange();
}

export function registerServerModule(): void {
  register('server.info', NoParams, async (_p, ctx) => {
    const claude = app.claudeLoggedIn();
    // Re-check: the user may have logged in over SSH since the daemon started.
    if (claude && app.status.read().state === 'needs_claude_login') await app.status.setState('ready');
    return {
      protocolVersion: PROTOCOL_VERSION,
      daemonVersion: app.daemonVersion,
      claudeVersion: app.caps.version,
      hostname: os.hostname(),
      publicHost: app.config.publicHost || null,
      projectsRoot: app.config.projectsRoot,
      user: os.userInfo().username,
      setup: { claude, github: await githubLoggedIn() },
      bypassAvailable: app.permissionModes().includes('bypassPermissions'),
      permissionModes: app.permissionModes(),
      device: { id: ctx.device.id, name: ctx.device.name, createdAt: ctx.device.createdAt },
    };
  });

  register('auth.rotate', NoParams, async (_p, ctx) => {
    const token = newToken();
    await saveTokens((tokens) => tokens.map((t) => (t.id === ctx.device.id ? { ...t, sha256: sha256Hex(token) } : t)));
    return { token };
  });

  register('auth.devices', NoParams, (_p, ctx) =>
    app.config.tokens.map((t) => ({ id: t.id, name: t.name, createdAt: t.createdAt, current: t.id === ctx.device.id })),
  );

  register('auth.revoke', z.object({ id: z.string() }), async ({ id }) => {
    if (!app.config.tokens.some((t) => t.id === id)) throw new RpcError('not_found', 'No such device');
    await saveTokens((tokens) => tokens.filter((t) => t.id !== id));
    return { ok: true as const };
  });

  register('auth.renameDevice', z.object({ id: z.string(), name: z.string().min(1).max(64) }), async ({ id, name }) => {
    if (!app.config.tokens.some((t) => t.id === id)) throw new RpcError('not_found', 'No such device');
    await saveTokens((tokens) => tokens.map((t) => (t.id === id ? { ...t, name } : t)));
    return { ok: true as const };
  });
}
