import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PermissionMode } from '../../protocol/types.js';
import { type Config, readEnvFile } from './config.js';
import { log } from './log.js';
import { RpcError } from './rpc.js';
import { StatusFile } from './status.js';
import { run } from './util/exec.js';

/** Capabilities of the installed Claude CLI, probed from `claude --help` at startup. */
export interface ClaudeCaps {
  version: string | null;
  permissionModes: string[]; // the CLI's own names
  sessionIdFlag: boolean;
  permissionPromptsFlag: boolean;
}

class AppState {
  config!: Config;
  status!: StatusFile;
  caps: ClaudeCaps = { version: null, permissionModes: [], sessionIdFlag: false, permissionPromptsFlag: false };
  readonly home = os.homedir();
  readonly isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  readonly daemonVersion: string = readDaemonVersion();

  init(config: Config): void {
    this.config = config;
    this.status = new StatusFile(config.statusFile, { host: config.publicHost || null, transport: config.transport });
  }

  /** Env for anything that runs Claude: process env + the env file (setup-token lives there). */
  claudeEnv(): NodeJS.ProcessEnv {
    return { ...process.env, ...readEnvFile(this.config.envFile) };
  }

  /** Logged in = a normal `claude` /login (credentials file) or a setup-token in the env file. */
  claudeLoggedIn(): boolean {
    if (existsSync(path.join(this.home, '.claude', '.credentials.json'))) return true;
    return Boolean(this.claudeEnv().CLAUDE_CODE_OAUTH_TOKEN);
  }

  async probeClaude(): Promise<void> {
    const bin = this.config.claudeBin;
    try {
      const [v, h] = await Promise.all([
        run(bin, ['--version'], { timeoutMs: 30_000, env: this.claudeEnv() }),
        run(bin, ['--help'], { timeoutMs: 30_000, env: this.claudeEnv() }),
      ]);
      const help = h.stdout + h.stderr;
      const modes = /--permission-mode[\s\S]*?\(choices:([^)]*)\)/.exec(help)?.[1] ?? '';
      this.caps = {
        version: v.stdout.trim().split('\n')[0] || null,
        permissionModes: [...modes.matchAll(/"([^"]+)"/g)].map((m) => m[1]!),
        sessionIdFlag: help.includes('--session-id'),
        permissionPromptsFlag: help.includes('--permission-prompts'),
      };
      log.info({ caps: this.caps }, 'claude CLI detected');
    } catch (err) {
      log.warn({ err, bin }, 'could not run the claude CLI');
    }
  }

  /** Modes the app may offer, in protocol terms. */
  permissionModes(): PermissionMode[] {
    const cli = this.caps.permissionModes;
    const out: PermissionMode[] = ['default'];
    for (const m of ['acceptEdits', 'plan', 'auto'] as const) if (cli.length === 0 || cli.includes(m)) out.push(m);
    // Claude Code refuses to bypass permissions as root.
    if (!this.isRoot && (cli.length === 0 || cli.includes('bypassPermissions'))) out.push('bypassPermissions');
    return out;
  }

  /** Protocol mode → the installed CLI's name for it. */
  cliPermissionMode(mode: PermissionMode): string {
    if (!this.permissionModes().includes(mode)) {
      throw new RpcError('bad_request', `Permission mode "${mode}" is not available on this server`);
    }
    const cli = this.caps.permissionModes;
    if (mode === 'default' && cli.length > 0 && !cli.includes('default')) {
      return cli.includes('manual') ? 'manual' : 'default';
    }
    return mode;
  }
}

function readDaemonVersion(): string {
  // dist/server/src/app.js → ../../../package.json ; src/app.ts (tsx) → ../package.json
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../../../package.json', '../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(here, rel), 'utf8')) as { name?: string; version?: string };
      if (pkg.name === 'nicode-server' && pkg.version) return pkg.version;
    } catch {
      // try next
    }
  }
  return '0.0.0';
}

export const app = new AppState();
