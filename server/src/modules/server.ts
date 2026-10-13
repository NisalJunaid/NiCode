import os from 'node:os';
import { z } from 'zod';
import { type DeviceInfo, PROTOCOL_VERSION } from '../../../protocol/types.js';
import { app } from '../app.js';
import { issueConfirmNonce } from '../auth/confirm.js';
import { isExpired, isKeyDevice, isTokenDevice } from '../auth.js';
import { type Device, updateDevices } from '../config.js';
import { applyDeviceChange } from '../http.js';
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
    };
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
