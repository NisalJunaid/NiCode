import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DeviceToken } from './config.js';

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function newToken(): string {
  return randomBytes(32).toString('hex');
}

export function newDeviceId(): string {
  return `d_${randomBytes(4).toString('hex')}`;
}

/** Device-token check. Compares hashes in constant time against every paired device. */
export function findDevice(tokens: DeviceToken[], presented: string | undefined): DeviceToken | null {
  if (!presented) return null;
  const h = Buffer.from(sha256Hex(presented), 'hex');
  let match: DeviceToken | null = null;
  for (const t of tokens) {
    const candidate = Buffer.from(t.sha256, 'hex');
    if (candidate.length === h.length && timingSafeEqual(candidate, h)) match = t;
  }
  return match;
}

/** Per-IP exponential backoff after repeated failures: 5 free tries, then 1s → 5min. */
export class Backoff {
  private state = new Map<string, { fails: number; until: number }>();

  blockedFor(ip: string, now = Date.now()): number {
    const s = this.state.get(ip);
    return s && s.until > now ? s.until - now : 0;
  }

  fail(ip: string, now = Date.now()): void {
    const s = this.state.get(ip) ?? { fails: 0, until: 0 };
    s.fails += 1;
    if (s.fails > 5) s.until = now + Math.min(300_000, 1000 * 2 ** (s.fails - 6));
    this.state.set(ip, s);
  }

  succeed(ip: string): void {
    this.state.delete(ip);
  }
}
