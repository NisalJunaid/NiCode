import { readFileSync } from 'node:fs';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { z } from 'zod';

/** Schema of $NICODE_CONFIG, written by the installer (installer/lib/templates.sh → tmpl_daemon_config). */
export const DeviceTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  sha256: z.string(),
  createdAt: z.string(),
});
export type DeviceToken = z.infer<typeof DeviceTokenSchema>;

export const ConfigSchema = z.object({
  version: z.literal(1),
  bindHost: z.string(),
  port: z.number().int(),
  tokens: z.array(DeviceTokenSchema).default([]),
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

export function configPath(): string {
  const p = process.env.NICODE_CONFIG;
  if (!p) throw new Error('NICODE_CONFIG is not set (path to config.json)');
  return p;
}

export function loadConfig(path = configPath()): Config {
  return ConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** Atomic write keeping mode 600 (we run as the file's owner, so ownership is preserved). */
export async function writeFileAtomic(path: string, content: string, mode = 0o600): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, { mode });
  await chmod(tmp, mode);
  await rename(tmp, path);
}

/** Read-modify-write of the device token list, always against the latest file on disk. */
export async function updateTokens(mutate: (tokens: DeviceToken[]) => DeviceToken[], path = configPath()): Promise<DeviceToken[]> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  const current = z.array(DeviceTokenSchema).parse(raw.tokens ?? []);
  const next = mutate(current);
  raw.tokens = next;
  await writeFileAtomic(path, JSON.stringify(raw, null, 2) + '\n');
  return next;
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
