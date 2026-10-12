import { createHash, createPublicKey, type KeyObject, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import type { Device, PairingCode } from './config.js';

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function newDeviceId(): string {
  return `d_${randomBytes(4).toString('hex')}`;
}

/**
 * Key devices get an id derived from their public key, so a phone knows its id on a droplet it
 * pre-paired through cloud-init without ever talking to the server first. Must match the
 * installer (08-daemon.sh) and the app: "d_" + first 8 hex chars of sha256(publicKey text).
 */
export function keyDeviceId(publicKey: string): string {
  return `d_${sha256Hex(publicKey).slice(0, 8)}`;
}

function hexEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

// ── Token devices (browser test console only; must expire) ────────────────────

export function isTokenDevice(d: Device): boolean {
  return Boolean(d.sha256 && d.expiresAt);
}

export function isKeyDevice(d: Device): boolean {
  return Boolean(d.alg && d.publicKey);
}

export function isExpired(d: Device, now = Date.now()): boolean {
  return Boolean(d.expiresAt && Date.parse(d.expiresAt) <= now);
}

/** Bearer-token check. Legacy tokens without an expiry are never accepted. */
export function findTokenDevice(devices: Device[], presented: string | undefined, now = Date.now()): Device | null {
  if (!presented) return null;
  const h = sha256Hex(presented);
  let match: Device | null = null;
  for (const d of devices) {
    if (isTokenDevice(d) && hexEqual(d.sha256!, h) && !isExpired(d, now)) match = d;
  }
  return match;
}

// ── Key devices (phones): challenge → signature on every connection ──────────

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const P256_SPKI_PREFIX = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');

/**
 * Accepts the formats phones hand out: base64 SPKI DER (Android Keystore), PKCS#1 DER (iOS RSA),
 * raw 32-byte Ed25519 keys, raw 65-byte P-256 points, or PEM.
 */
export function publicKeyFrom(alg: NonNullable<Device['alg']>, encoded: string): KeyObject {
  if (encoded.includes('-----BEGIN')) return createPublicKey(encoded);
  const der = Buffer.from(encoded, 'base64');
  const attempts: (() => KeyObject)[] = [];
  if (alg === 'Ed25519' && der.length === 32) attempts.push(() => createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, der]), format: 'der', type: 'spki' }));
  if (alg === 'ES256' && der.length === 65) attempts.push(() => createPublicKey({ key: Buffer.concat([P256_SPKI_PREFIX, der]), format: 'der', type: 'spki' }));
  attempts.push(() => createPublicKey({ key: der, format: 'der', type: 'spki' }));
  if (alg === 'RS256') attempts.push(() => createPublicKey({ key: der, format: 'der', type: 'pkcs1' }));
  for (const a of attempts) {
    try {
      const k = a();
      const type = k.asymmetricKeyType;
      const ok = (alg === 'RS256' && type === 'rsa') || (alg === 'ES256' && type === 'ec') || (alg === 'Ed25519' && type === 'ed25519');
      if (ok) return k;
    } catch {
      // try next format
    }
  }
  throw new Error(`Not a valid ${alg} public key`);
}

/** The exact bytes a phone signs to log in (shared with the app via the protocol package). */
export { authMessage } from '../../protocol/types.js';

export function verifyDeviceSignature(d: Device, message: string, signatureB64: string): boolean {
  if (!isKeyDevice(d)) return false;
  let key: KeyObject;
  try {
    key = publicKeyFrom(d.alg!, d.publicKey!);
  } catch {
    return false;
  }
  const data = Buffer.from(message, 'utf8');
  const sig = Buffer.from(signatureB64, 'base64');
  try {
    if (d.alg === 'Ed25519') return verify(null, data, key, sig);
    if (d.alg === 'ES256') {
      return verify('sha256', data, { key, dsaEncoding: 'der' }, sig) || verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig);
    }
    return verify('sha256', data, key, sig);
  } catch {
    return false;
  }
}

/** One-time login challenges: 60 s lifetime, single use, bounded memory. */
export class ChallengeStore {
  private nonces = new Map<string, number>();
  constructor(
    private readonly ttlMs = 60_000,
    private readonly max = 5000,
  ) {}

  issue(now = Date.now()): { nonce: string; expiresAt: string } {
    for (const [n, exp] of this.nonces) if (exp <= now) this.nonces.delete(n);
    while (this.nonces.size >= this.max) this.nonces.delete(this.nonces.keys().next().value!);
    const nonce = randomBytes(32).toString('base64url');
    this.nonces.set(nonce, now + this.ttlMs);
    return { nonce, expiresAt: new Date(now + this.ttlMs).toISOString() };
  }

  /** True once per nonce, and only before it expires. */
  consume(nonce: string, now = Date.now()): boolean {
    const exp = this.nonces.get(nonce);
    if (exp === undefined) return false;
    this.nonces.delete(nonce);
    return exp > now;
  }
}

// ── Pairing codes ──────────────────────────────────────────────────────────

/** "abcde-fghjk" / "ABCDE FGHJK" → "ABCDEFGHJK" (codes are typed by hand sometimes). */
export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

export function findPairingCode(codes: PairingCode[], presented: string, now = Date.now()): PairingCode | null {
  const h = sha256Hex(normalizeCode(presented));
  return codes.find((c) => hexEqual(c.sha256, h) && Date.parse(c.expiresAt) > now) ?? null;
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
