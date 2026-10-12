import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClaudeSessionState, ClaudeSessionSummary, ClaudeStreamEvent } from '../../../protocol/types.js';
import { app } from '../app.js';
import { writeFileAtomic } from '../config.js';
import { events } from '../events.js';
import { log, maskSecrets } from '../log.js';
import { LineSplitter } from '../util/exec.js';
import type { PermissionBroker } from './permissions.js';
import type { SessionStore, StoredSession } from './store.js';

const IDLE_KILL_MS = 30 * 60_000;
const here = path.dirname(fileURLToPath(import.meta.url));

/** How to start the approve MCP server: compiled JS in production, via tsx in `npm run dev`. */
function approveServerCommand(): { command: string; args: string[] } {
  const js = path.join(here, '..', 'mcp', 'approve-server.js');
  if (import.meta.url.endsWith('.ts')) {
    return { command: 'npx', args: ['tsx', path.join(here, '..', 'mcp', 'approve-server.ts')] };
  }
  return { command: process.execPath, args: [js] };
}

export interface SessionDeps {
  store: SessionStore;
  broker: PermissionBroker;
  onResult(s: StoredSession, event: ClaudeStreamEvent): void;
}

export function publicSummary(s: StoredSession): ClaudeSessionSummary {
  const { claudeSessionId: _ignored, ...rest } = s;
  return rest;
}

/**
 * One Claude Code conversation. Owns at most one `claude -p --input-format stream-json` process,
 * which stays alive between turns and is respawned with --resume after an idle kill or crash.
 */
export class ClaudeSession {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private stderrTail = '';
  private idleTimer: NodeJS.Timeout | null = null;
  private respawnAfterTurn = false;
  busy = false;

  constructor(
    readonly s: StoredSession,
    private readonly deps: SessionDeps,
  ) {}

  get id(): string {
    return this.s.sessionId;
  }

  private setState(state: ClaudeSessionState, error?: string): void {
    this.s.state = state;
    this.s.updatedAt = new Date().toISOString();
    this.deps.store.upsert(this.s);
    events.emit('claude.status', { sessionId: this.id, state, ...(error ? { error } : {}) });
  }

  setWaiting(waiting: boolean): void {
    if (waiting) this.setState('awaiting_permission');
    else if (this.busy) this.setState('running');
  }

  private record(event: ClaudeStreamEvent): void {
    const rec = this.deps.store.append(this.id, event);
    events.emit('claude.event', { sessionId: this.id, ...rec });
  }

  private async spawnProcess(): Promise<ChildProcessWithoutNullStreams> {
    const tmpDir = path.join(app.config.dataDir, 'tmp');
    await mkdir(tmpDir, { recursive: true, mode: 0o700 });
    const mcpPath = path.join(tmpDir, `mcp-${this.id}.json`);
    const approve = approveServerCommand();
    await writeFileAtomic(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          nicode: {
            type: 'stdio',
            command: approve.command,
            args: approve.args,
            env: { NICODE_SOCKET: this.deps.broker.socketPath, NICODE_SECRET: this.deps.broker.secret, NICODE_SESSION_ID: this.id },
          },
        },
      }),
    );

    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
    args.push('--permission-mode', app.cliPermissionMode(this.s.permissionMode));
    if (this.s.model) args.push('--model', this.s.model);
    if (this.s.claudeSessionId) args.push('--resume', this.s.claudeSessionId);
    else if (app.caps.sessionIdFlag) args.push('--session-id', this.id);
    args.push('--mcp-config', mcpPath, '--permission-prompt-tool', 'mcp__nicode__approve');
    if (app.caps.permissionPromptsFlag) args.push('--permission-prompts', 'host');

    log.info({ sessionId: this.id, cwd: this.s.projectPath, resume: Boolean(this.s.claudeSessionId) }, 'starting claude');
    // Tests substitute a fake CLI (test/fake-claude.mjs) that speaks the same stream-json protocol.
    const shim = process.env.NICODE_TEST_CLAUDE_SHIM;
    const opts = { cwd: this.s.projectPath, env: app.claudeEnv(), stdio: 'pipe' as const };
    const proc = shim ? spawn(process.execPath, [shim, ...args], opts) : spawn(app.config.claudeBin, args, opts);
    const lines = new LineSplitter();
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      for (const line of lines.push(chunk)) this.onLine(line);
    });
    proc.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });
    proc.on('error', (err) => {
      log.error({ err }, 'claude failed to start');
      this.stderrTail += `\n${err.message}`;
    });
    proc.on('exit', (code, signal) => {
      for (const line of lines.flush()) this.onLine(line);
      void rm(mcpPath, { force: true });
      if (this.proc === proc) this.proc = null;
      log.info({ sessionId: this.id, code, signal }, 'claude exited');
      if (this.busy) {
        this.busy = false;
        const msg = maskSecrets(this.stderrTail.trim().split('\n').slice(-5).join('\n')) || `claude exited (${signal ?? code})`;
        this.record({ type: 'nicode', subtype: 'process_exit', code, signal, text: msg });
        this.setState('error', msg);
      }
    });
    return proc;
  }

  private onLine(line: string): void {
    let event: ClaudeStreamEvent;
    try {
      event = JSON.parse(line) as ClaudeStreamEvent;
    } catch {
      event = { type: 'nicode', subtype: 'stderr', text: maskSecrets(line) };
    }
    if (event.type === 'system' && event.subtype === 'init' && typeof event.session_id === 'string') {
      this.s.claudeSessionId = event.session_id;
      if (typeof event.model === 'string' && !this.s.model) this.s.model = event.model;
    }
    this.record(event);
    if (event.type === 'result') {
      this.busy = false;
      this.setState('idle');
      this.deps.onResult(this.s, event);
      if (this.respawnAfterTurn) {
        this.respawnAfterTurn = false;
        this.stopProcess();
      }
      this.armIdleKill();
    }
  }

  private armIdleKill(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stopProcess(), IDLE_KILL_MS);
    this.idleTimer.unref();
  }

  /** Ends the CLI gracefully (closing stdin ends a stream-json session). */
  stopProcess(): void {
    const p = this.proc;
    if (!p) return;
    this.proc = null;
    p.stdin.end();
    setTimeout(() => p.exitCode === null && p.kill('SIGTERM'), 5000).unref();
  }

  async send(text: string): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.busy = true;
    this.stderrTail = '';
    this.setState('running');
    this.record({ type: 'nicode', subtype: 'user_turn', text });
    try {
      if (!this.proc || this.proc.exitCode !== null) this.proc = await this.spawnProcess();
    } catch (err) {
      this.busy = false;
      this.setState('error', (err as Error).message);
      throw err;
    }
    const msg = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: this.s.claudeSessionId ?? this.id,
    };
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  interrupt(): void {
    this.deps.broker.cancelSession(this.id);
    const p = this.proc;
    if (p) {
      // Detach first so the next send() starts a fresh (resumed) process instead of
      // writing into one that is shutting down.
      this.proc = null;
      p.kill('SIGINT');
      setTimeout(() => p.exitCode === null && p.kill('SIGTERM'), 5000).unref();
    }
    if (this.busy) {
      this.busy = false;
      this.record({ type: 'nicode', subtype: 'interrupted' });
    }
    this.setState('idle');
  }

  /** New mode/model take effect on the next turn (the CLI is restarted with --resume). */
  updateSettings(patch: { permissionMode?: StoredSession['permissionMode']; model?: string }): void {
    if (patch.permissionMode) this.s.permissionMode = patch.permissionMode;
    if (patch.model !== undefined) this.s.model = patch.model || null;
    this.deps.store.upsert(this.s);
    if (this.busy) this.respawnAfterTurn = true;
    else this.stopProcess();
  }

  shutdown(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.proc?.kill('SIGINT');
  }
}
