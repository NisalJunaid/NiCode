/**
 * Push notifications through Expo's push service: Claude needs approval / finished, an app
 * crashed, a site is down. Each phone registers its token with which kinds it wants.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { PushPrefs } from '../../../protocol/types.js';
import { app } from '../app.js';
import { writeFileAtomic } from '../config.js';
import { log } from '../log.js';
import { register, RpcError } from '../rpc.js';

interface PushToken {
  token: string;
  platform: 'ios' | 'android';
  addedAt: string;
  prefs?: Partial<PushPrefs>;
}

/** Which preference switches each notification `data.kind`. */
const PREF_OF: Record<string, keyof PushPrefs | null> = {
  permission: 'approvals',
  result: 'finished',
  app: 'appCrashes',
  site: 'siteDown',
  test: null, // always delivered
};

const PUSH_URL = process.env.NICODE_PUSH_URL ?? 'https://exp.host/--/api/v2/push/send';
const file = () => path.join(app.config.dataDir, 'push.json');

export async function readTokens(): Promise<PushToken[]> {
  try {
    return JSON.parse(await readFile(file(), 'utf8')) as PushToken[];
  } catch {
    return [];
  }
}

export function wants(t: PushToken, kind: unknown): boolean {
  const pref = typeof kind === 'string' ? PREF_OF[kind] : undefined;
  return !pref || t.prefs?.[pref] !== false;
}

/** Sends to every registered phone that wants this kind (`data.kind`). Never throws. */
export async function sendPush(title: string, body: string, data: Record<string, unknown>, channelId = 'agent'): Promise<{ sent: number; error?: string }> {
  const tokens = (await readTokens()).filter((t) => wants(t, data.kind));
  if (tokens.length === 0) return { sent: 0 };
  try {
    const res = await fetch(PUSH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(tokens.map((t) => ({ to: t.token, title, body, data: { host: app.config.publicHost, ...data }, sound: 'default', channelId, priority: 'high' }))),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json()) as { data?: { status: string; message?: string; details?: { error?: string } }[] };
    const dead = new Set<string>();
    let error: string | undefined;
    json.data?.forEach((ticket, i) => {
      if (ticket.details?.error === 'DeviceNotRegistered') dead.add(tokens[i]!.token);
      if (ticket.status === 'error') error ??= ticket.message ?? ticket.details?.error ?? 'push failed';
    });
    if (dead.size) await writeFileAtomic(file(), JSON.stringify((await readTokens()).filter((t) => !dead.has(t.token))));
    return { sent: tokens.length - (error ? 1 : 0), ...(error ? { error } : {}) };
  } catch (err) {
    log.warn({ err }, 'push send failed');
    return { sent: 0, error: err instanceof Error ? err.message : 'push failed' };
  }
}

const Prefs = z.object({ approvals: z.boolean(), finished: z.boolean(), appCrashes: z.boolean(), siteDown: z.boolean() }).partial();

export function registerPushModule(): void {
  register(
    'push.register',
    z.object({ expoPushToken: z.string().min(10).max(300), platform: z.enum(['ios', 'android']), prefs: Prefs.optional() }),
    async ({ expoPushToken, platform, prefs }) => {
      const tokens = (await readTokens()).filter((t) => t.token !== expoPushToken);
      tokens.push({ token: expoPushToken, platform, addedAt: new Date().toISOString(), ...(prefs ? { prefs } : {}) });
      await writeFileAtomic(file(), JSON.stringify(tokens));
      return { ok: true as const };
    },
  );

  register('push.test', z.object({}).passthrough(), async () => {
    if ((await readTokens()).length === 0) throw new RpcError('bad_request', 'No phone is registered for notifications on this server yet');
    const r = await sendPush('🔔 niCode', 'Notifications from this server work.', { kind: 'test' });
    if (r.error) throw new RpcError('internal', `Expo push: ${r.error}`);
    return { sent: r.sent };
  });
}
