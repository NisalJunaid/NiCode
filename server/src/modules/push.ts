import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { app } from '../app.js';
import { writeFileAtomic } from '../config.js';
import { log } from '../log.js';
import { register } from '../rpc.js';

interface PushToken {
  token: string;
  platform: 'ios' | 'android';
  addedAt: string;
}

const file = () => path.join(app.config.dataDir, 'push.json');

async function readTokens(): Promise<PushToken[]> {
  try {
    return JSON.parse(await readFile(file(), 'utf8')) as PushToken[];
  } catch {
    return [];
  }
}

/** Sends to every registered phone through Expo's push service. Never throws. */
export async function sendPush(title: string, body: string, data: Record<string, unknown>, channelId = 'agent'): Promise<void> {
  const tokens = await readTokens();
  if (tokens.length === 0) return;
  try {
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(tokens.map((t) => ({ to: t.token, title, body, data, sound: 'default', channelId, priority: 'high' }))),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json()) as { data?: { status: string; details?: { error?: string } }[] };
    const dead = new Set<string>();
    json.data?.forEach((ticket, i) => {
      if (ticket.details?.error === 'DeviceNotRegistered') dead.add(tokens[i]!.token);
    });
    if (dead.size) await writeFileAtomic(file(), JSON.stringify(tokens.filter((t) => !dead.has(t.token))));
  } catch (err) {
    log.warn({ err }, 'push send failed');
  }
}

export function registerPushModule(): void {
  register('push.register', z.object({ expoPushToken: z.string().min(10).max(300), platform: z.enum(['ios', 'android']) }), async ({ expoPushToken, platform }) => {
    const tokens = (await readTokens()).filter((t) => t.token !== expoPushToken);
    tokens.push({ token: expoPushToken, platform, addedAt: new Date().toISOString() });
    await writeFileAtomic(file(), JSON.stringify(tokens));
    return { ok: true as const };
  });
}
