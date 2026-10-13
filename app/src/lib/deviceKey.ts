/**
 * This phone's login key.
 *
 * - One Ed25519 key pair per install. The private key is kept in SecureStore with
 *   `requireAuthentication`: the OS keystore encrypts it with a hardware key that only releases
 *   it after a fingerprint/face check (and destroys it if biometrics change). Devices without
 *   biometrics fall back to a device-passcode check before reading.
 * - After unlocking, the private key stays in memory for the grace period (settings, default 5 min)
 *   so reconnects don't prompt every time; it's wiped when the period ends.
 * - Servers only ever see the public key. Device id = "d_" + sha256hex(publicKey)[0..8]
 *   (same rule as the daemon and installer).
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import * as Crypto from 'expo-crypto';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { AppState } from 'react-native';
import { useSettings } from '@/state/settings';
import { base64ToBytes, bytesToBase64 } from './util';

const SK = 'nicode.device.sk';
const PK = 'nicode.device.pk';
const GATE = 'nicode.device.gate'; // 'biometric' | 'passcode'

export class KeyLockedError extends Error {
  constructor(message = 'Unlock cancelled') {
    super(message);
  }
}
export class KeyLostError extends Error {
  constructor() {
    super('This phone\'s key was reset (biometrics changed). Pair the server again.');
  }
}

let unlocked: { sk: Uint8Array; until: number } | null = null;
let unlocking: Promise<Uint8Array> | null = null;

function graceMs(): number {
  return Math.max(0, useSettings.getState().graceSeconds) * 1000;
}

/** Wipe the in-memory key when the app has been away longer than the grace period. */
let backgroundedAt = 0;
AppState.addEventListener('change', (s) => {
  if (s === 'background') backgroundedAt = Date.now();
  if (s === 'active' && backgroundedAt && Date.now() - backgroundedAt > graceMs()) lock();
});

export function lock(): void {
  unlocked?.sk.fill(0);
  unlocked = null;
}

export function isUnlocked(): boolean {
  return !!unlocked && unlocked.until > Date.now();
}

export async function getPublicKey(): Promise<string | null> {
  return SecureStore.getItemAsync(PK);
}

/** Creates the key pair on first use. Returns the public key (base64, raw 32 bytes). */
export async function ensureKey(): Promise<{ alg: 'Ed25519'; publicKey: string }> {
  const existing = await SecureStore.getItemAsync(PK);
  if (existing) return { alg: 'Ed25519', publicKey: existing };
  const sk = Crypto.getRandomBytes(32);
  const pk = bytesToBase64(ed25519.getPublicKey(sk));
  const biometric = SecureStore.canUseBiometricAuthentication();
  await SecureStore.setItemAsync(SK, bytesToBase64(sk), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    ...(biometric ? { requireAuthentication: true, authenticationPrompt: 'Protect your niCode key' } : {}),
  });
  await SecureStore.setItemAsync(GATE, biometric ? 'biometric' : 'passcode');
  await SecureStore.setItemAsync(PK, pk);
  unlocked = { sk, until: Date.now() + graceMs() };
  return { alg: 'Ed25519', publicKey: pk };
}

export async function deviceIdFor(publicKey: string): Promise<string> {
  const hex = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, publicKey);
  return `d_${hex.slice(0, 8)}`;
}

async function readKey(reason: string): Promise<Uint8Array> {
  const gate = await SecureStore.getItemAsync(GATE);
  let b64: string | null;
  if (gate === 'biometric') {
    try {
      b64 = await SecureStore.getItemAsync(SK, { requireAuthentication: true, authenticationPrompt: reason });
    } catch (err) {
      // Cancelled / failed biometric prompt.
      throw new KeyLockedError(String((err as Error)?.message ?? 'Unlock cancelled'));
    }
    if (b64 === null) throw new KeyLostError();
  } else {
    const r = await LocalAuthentication.authenticateAsync({ promptMessage: reason, cancelLabel: 'Cancel' });
    // A phone with no screen lock at all has nothing stronger to offer; don't lock the user out.
    const noLock = !r.success && (r.error === 'not_enrolled' || r.error === 'passcode_not_set' || r.error === 'not_available');
    if (!r.success && !noLock) throw new KeyLockedError();
    b64 = await SecureStore.getItemAsync(SK);
    if (b64 === null) throw new KeyLostError();
  }
  return base64ToBytes(b64);
}

/** Returns the private key, prompting for biometrics if the grace period has passed. */
export async function unlock(reason = 'Unlock niCode'): Promise<Uint8Array> {
  if (unlocked && unlocked.until > Date.now()) return unlocked.sk;
  // Several hosts reconnecting at once share one prompt.
  unlocking ??= readKey(reason)
    .then((sk) => {
      unlocked = { sk, until: Date.now() + Math.max(graceMs(), 15_000) };
      return sk;
    })
    .finally(() => {
      unlocking = null;
    });
  return unlocking;
}

export async function sign(message: string, reason?: string): Promise<string> {
  const sk = await unlock(reason);
  const sig = ed25519.sign(new TextEncoder().encode(message), sk);
  if (graceMs() === 0) lock(); // "ask every time"
  return bytesToBase64(sig);
}

/**
 * Signs with a fresh fingerprint/face check, ignoring the grace period. Used to prove to the
 * server that the owner confirmed a destructive action (see auth.confirmChallenge).
 */
export async function signFresh(message: string, reason: string): Promise<string> {
  const sk = await readKey(reason);
  return bytesToBase64(ed25519.sign(new TextEncoder().encode(message), sk));
}

/**
 * Always asks for fingerprint/face (or device passcode), regardless of the grace period.
 * Used for sensitive one-off actions like pairing a new server.
 */
export async function confirmOwner(reason: string): Promise<void> {
  const r = await LocalAuthentication.authenticateAsync({ promptMessage: reason, cancelLabel: 'Cancel' });
  if (!r.success) {
    // No biometrics or passcode set up on this phone: nothing stronger to ask for.
    if (r.error === 'not_enrolled' || r.error === 'passcode_not_set' || r.error === 'not_available') return;
    throw new KeyLockedError();
  }
}

/** Forget the key entirely (every server must be paired again). */
export async function resetKey(): Promise<void> {
  lock();
  await SecureStore.deleteItemAsync(SK);
  await SecureStore.deleteItemAsync(PK);
  await SecureStore.deleteItemAsync(GATE);
}
