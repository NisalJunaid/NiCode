import os from 'node:os';
import { z } from 'zod';
import { type DeviceInfo, PROTOCOL_VERSION, type ServerRole } from '../../../protocol/types.js';
import { app } from '../app.js';
import { issueConfirmNonce, requireConfirmation } from '../auth/confirm.js';
import { isExpired, isKeyDevice, isTokenDevice } from '../auth.js';
import { type Device, updateConfigField, updateDevices } from '../config.js';
import { events } from '../events.js';
import { log } from '../log.js';
import { applyDeviceChange } from '../http.js';
import { NoParams, register, RpcError } from '../rpc.js';
import { run } from '../util/exec.js';
import { onRoleChanged } from './claude.js';

const Proof = z.object({ nonce: z.string().min(16).max(100), sig: z.string().min(16).max(2000) });

/** Applies a role change to the running daemon (from the app, or `nicode role` editing the config). */
export function applyRole(role: ServerRole): void {
  if (app.config.role === role) return;
  app.config.role = role;
  log.info({ role }, 'server role changed');
  onRoleChanged();
  events.emit('server.role', { role });
}

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

/** Applies a device-list change to the running daemon immediately (the file watcher would too). */
async function saveDevices(mutate: (devices: Device[]) => Device[]): Promise<void> {
  const next = await updateDevices(({ devices, pairingCodes }) => ({ devices: mutate(devices), pairingCodes }));
  app.config.devices = next.devices;
  applyDeviceChange();
}

export function deviceInfo(d: Device): DeviceInfo {
  return {
    id: d.id,
    name: d.name,
    createdAt: d.createdAt,
    kind: isKeyDevice(d) ? 'key' : 'token',
    ...(d.expiresAt ? { expiresAt: d.expiresAt } : {}),
  };
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
      device: deviceInfo(ctx.device),
      role: app.config.role,
      isRoot: app.isRoot,
      analyzeIsolation: app.analyzeIsolation(),
      analyzeBlocked: app.analyzeBlocked(),
    };
  });

  register('server.setRole', z.object({ role: z.enum(['development', 'production']), proof: Proof.optional() }), async ({ role, proof }, ctx) => {
    // Lifting production restrictions is what a thief with an unlocked phone would do: fingerprint first.
    if (role === 'development' && app.production) requireConfirmation(ctx, 'server.setRole', ['development'], proof);
    await updateConfigField('role', role);
    applyRole(role);
    return { role };
  });

  register('auth.confirmChallenge', NoParams, () => issueConfirmNonce());

  register('auth.devices', NoParams, (_p, ctx) =>
    app.config.devices
      .filter((d) => isKeyDevice(d) || (isTokenDevice(d) && !isExpired(d)))
      .map((d) => ({ ...deviceInfo(d), current: d.id === ctx.device.id })),
  );

  register('auth.revoke', z.object({ id: z.string() }), async ({ id }) => {
    if (!app.config.devices.some((d) => d.id === id)) throw new RpcError('not_found', 'No such device');
    await saveDevices((devices) => devices.filter((d) => d.id !== id));
    return { ok: true as const };
  });

  register('auth.renameDevice', z.object({ id: z.string(), name: z.string().min(1).max(64) }), async ({ id, name }) => {
    if (!app.config.devices.some((d) => d.id === id)) throw new RpcError('not_found', 'No such device');
    await saveDevices((devices) => devices.map((d) => (d.id === id ? { ...d, name } : d)));
    return { ok: true as const };
  });
}
