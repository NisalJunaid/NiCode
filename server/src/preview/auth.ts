/**
 * Preview links: `https://p<port>.<ip-dashed>.sslip.io` serves 127.0.0.1:<port> through the daemon.
 *
 * The app gets a one-time link `/__nicode/auth?t=<token>` (HMAC, 2 minutes, single use) from
 * `preview.open` over its authenticated connection. Opening it sets an HttpOnly cookie
 * (HMAC, 12 hours) that is only valid for that one preview host and only while the device that
 * opened it is still paired. Without it, nothing is proxied.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const COOKIE = 'nicode_preview';
const TOKEN_TTL_MS = 2 * 60_000;
export const COOKIE_TTL_MS = 12 * 3600_000;

let key: Buffer | null = null;
const usedNonces = new Map<string, number>();

/** Per-server secret kept in dataDir (created on first use). */
export function initPreviewKey(dataDir: string): void {
  const file = path.join(dataDir, 'preview.key');
  try {
    key = Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
    if (key.length === 32) return;
  } catch {
    // create below
  }
  key = randomBytes(32);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, key.toString('hex') + '\n', { mode: 0o600 });
}

function mac(data: string): string {
  if (!key) throw new Error('preview key not initialised');
  return createHmac('sha256', key).update(data).digest('base64url');
}

function seal(kind: 't' | 'c', payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${mac(`${kind}.${body}`)}`;
}

function open(kind: 't' | 'c', value: string): Record<string, unknown> | null {
  const [body, sig] = value.split('.');
  if (!body || !sig) return null;
  const want = Buffer.from(mac(`${kind}.${body}`));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function issueOpenToken(port: number, deviceId: string, now = Date.now()): string {
  return seal('t', { p: port, d: deviceId, e: now + TOKEN_TTL_MS, n: randomBytes(12).toString('base64url') });
}

/** Valid, unexpired, for this port, and not used before (single use). Returns the device it was issued to. */
export function redeemOpenToken(token: string, port: number, now = Date.now()): string | null {
  const t = open('t', token);
  if (!t || t.p !== port || typeof t.e !== 'number' || t.e < now || typeof t.n !== 'string' || typeof t.d !== 'string') return null;
  for (const [n, exp] of usedNonces) if (exp < now) usedNonces.delete(n);
  if (usedNonces.has(t.n)) return null;
  usedNonces.set(t.n, t.e);
  return t.d;
}

export function issueCookie(port: number, deviceId: string, now = Date.now()): string {
  return seal('c', { p: port, d: deviceId, e: now + COOKIE_TTL_MS });
}

/** Valid for this port, unexpired, and its device is still allowed (`deviceOk`), so revoking a phone ends its previews. */
export function cookieValid(value: string | undefined, port: number, deviceOk: (deviceId: string) => boolean, now = Date.now()): boolean {
  if (!value) return false;
  const c = open('c', value);
  return !!c && c.p === port && typeof c.e === 'number' && c.e > now && typeof c.d === 'string' && deviceOk(c.d);
}

/** `p3000.203-0-113-7.sslip.io` → 3000 (null for any other host). */
export function previewPortOf(host: string | undefined): number | null {
  const m = /^p(\d{4,5})\.\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3}\.sslip\.io(?::\d+)?$/i.exec(host ?? '');
  if (!m) return null;
  const port = Number(m[1]);
  return port >= 1024 && port <= 65535 ? port : null;
}

export function previewHost(port: number, ip: string): string {
  return `p${port}.${ip.replaceAll('.', '-')}.sslip.io`;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** The request's Cookie header without our cookie (the previewed app never sees it). */
export function stripCookie(header: string | undefined, name: string): string | undefined {
  const rest = (header ?? '')
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith(`${name}=`));
  return rest.length ? rest.join('; ') : undefined;
}
