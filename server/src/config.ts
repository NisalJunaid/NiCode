import { readFileSync } from 'node:fs';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { z } from 'zod';

/**
 * A paired device. Phones are `key` devices: a public key from the phone's secure hardware,
 * used to verify a fresh signature on every connection. `token` devices are short-lived bearer
 * tokens for the browser test console (`nicode token add --expires`). Token entries without an
 * expiry are legacy permanent tokens and are ignored.
 */
export const DeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  // key devices
  alg: z.enum(['RS256', 'ES256', 'Ed25519']).optional(),
  publicKey: z.string().optional(),
  // token devices
  sha256: z.string().optional(),
  expiresAt: z.string().optional(),
});
export type Device = z.infer<typeof DeviceSchema>;

/** One-time pairing codes created by `nicode pair` (stored hashed, consumed on use). */
export const PairingCodeSchema = z.object({
  sha256: z.string(),
  name: z.string().default(''),
  expiresAt: z.string(),
});
export type PairingCode = z.infer<typeof PairingCodeSchema>;

export const ConfigSchema = z.object({
  version: z.literal(1),
  bindHost: z.string(),
  port: z.number().int(),
  devices: z.array(DeviceSchema).default([]),
  pairingCodes: z.array(PairingCodeSchema).default([]),
  transport: z.enum(['https', 'tailscale', 'local']),
  publicHost: z.string().default(''),
  user: z.string(),
  projectsRoot: z.string(),
  dataDir: z.string(),
  envFile: z.string(),
  statusFile: z.string(),
  claudeBin: z.string().default('claude'),
  appDir: z.string().default(''),
  maxRunningSessions: z.number().int().positive().default(3),
});
export type Config = z.infer<typeof ConfigSchema>;

/** Older configs called the device list `tokens`. */
function migrate(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw.devices === undefined && Array.isArray(raw.tokens)) {
    raw.devices = raw.tokens;
  }
  delete raw.tokens;
  return raw;
}

export function configPath(): string {
  const p = process.env.NICODE_CONFIG;
  if (!p) throw new Error('NICODE_CONFIG is not set (path to config.json)');
  return p;
}

export function loadConfig(path = configPath()): Config {
  return ConfigSchema.parse(migrate(JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>));
}

/** Atomic write keeping mode 600 (we run as the file's owner, so ownership is preserved). */
export async function writeFileAtomic(path: string, content: string, mode = 0o600): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, { mode });
  await chmod(tmp, mode);
  await rename(tmp, path);
}

let configWrite: Promise<unknown> = Promise.resolve();

/**
 * Read-modify-write of the device list and pairing codes, always against the latest file on
 * disk (the `nicode` CLI edits it too). Writes are serialized within the daemon.
 */
export function updateDevices(
  mutate: (state: { devices: Device[]; pairingCodes: PairingCode[] }) => { devices: Device[]; pairingCodes: PairingCode[] },
  path = configPath(),
): Promise<{ devices: Device[]; pairingCodes: PairingCode[] }> {
  const run = async () => {
    const raw = migrate(JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>);
    const current = {
      devices: z.array(DeviceSchema).parse(raw.devices ?? []),
      pairingCodes: z.array(PairingCodeSchema).parse(raw.pairingCodes ?? []),
    };
    const next = mutate(current);
    raw.devices = next.devices;
    raw.pairingCodes = next.pairingCodes;
    await writeFileAtomic(path, JSON.stringify(raw, null, 2) + '\n');
    return next;
  };
  const p = configWrite.then(run, run);
  configWrite = p.catch(() => undefined);
  return p;
}

// ── env file (KEY=VALUE lines; holds CLAUDE_CODE_OAUTH_TOKEN) ──────────────────

export function readEnvFile(path: string): Record<string, string> {
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

export async function setEnvVar(path: string, key: string, value: string): Promise<void> {
  let lines: string[] = [];
  try {
    lines = (await readFile(path, 'utf8')).split('\n').filter((l) => l !== '');
  } catch {
    lines = ['# niCode daemon environment'];
  }
  lines = lines.filter((l) => !l.startsWith(`${key}=`));
  lines.push(`${key}=${value}`);
  await writeFileAtomic(path, lines.join('\n') + '\n');
  process.env[key] = value;
}
