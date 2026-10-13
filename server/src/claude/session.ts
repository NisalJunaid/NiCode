import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClaudeSessionState, ClaudeSessionSummary, ClaudeStreamEvent, ImageInput } from '../../../protocol/types.js';
import { app } from '../app.js';
import { writeFileAtomic } from '../config.js';
import { events } from '../events.js';
import { log, maskSecrets } from '../log.js';
import { RpcError } from '../rpc.js';
import { LineSplitter } from '../util/exec.js';
import { changes, CP_PREFIX, isGitRepo, prune, resolveRef, restoreFiles, saveRef, snapshot } from './checkpoints.js';
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
  const { claudeSessionId: _ignored, turns: _turns, ...rest } = s;
  return rest;
}

/** Bash commands that run a test suite (for the "what changed" card). */
const TEST_RE = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bvitest\b|\bjest\b|\bpytest\b|\bphpunit\b|\bartisan\s+test\b|\bgo\s+test\b|\bcargo\s+test\b|\bmocha\b/;

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
  /** The checkpoint of the turn in progress (ref is null when the project isn't a git repo). */
  private turn: { n: number; ref: string | null } | null = null;
  private testCalls = new Map<string, string>();
  private lastTest: { command: string; passed: boolean } | null = null;
  private summarizing: Promise<void> = Promise.resolve();
  /** Told to Claude with the next message (e.g. after files were rewound). */
  private pendingNote: string | null = null;
  private isRepo: boolean | null = null;

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
    this.watchTests(event);
    if (event.type === 'result') {
      this.busy = false;
      this.setState('idle');
      this.deps.onResult(this.s, event);
      const turn = this.turn;
      const tests = this.lastTest;
      this.turn = null;
      this.lastTest = null;
      this.testCalls.clear();
      if (turn?.ref) this.summarizing = this.summarize(turn.n, turn.ref, tests).catch((err) => log.warn({ err }, 'turn summary failed'));
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

  /** Remembers test commands Claude runs and whether they passed. */
  private watchTests(event: ClaudeStreamEvent): void {
    const blocks = (event as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(blocks)) return;
    for (const b of blocks as { type?: string; id?: string; name?: string; input?: { command?: unknown }; tool_use_id?: string; is_error?: boolean }[]) {
      if (event.type === 'assistant' && b.type === 'tool_use' && b.name === 'Bash' && b.id && typeof b.input?.command === 'string' && TEST_RE.test(b.input.command)) {
        this.testCalls.set(b.id, b.input.command);
      } else if (event.type === 'user' && b.type === 'tool_result' && b.tool_use_id && this.testCalls.has(b.tool_use_id)) {
        this.lastTest = { command: this.testCalls.get(b.tool_use_id)!, passed: !b.is_error };
      }
    }
  }

  /** Snapshot of the files before a turn (git repos only). Never fails the turn. */
  private async checkpoint(n: number): Promise<string | null> {
    try {
      this.isRepo ??= await isGitRepo(this.s.projectPath);
      if (!this.isRepo) return null;
      const ref = `${CP_PREFIX}${this.id}/${n}`;
      await saveRef(this.s.projectPath, ref, await snapshot(this.s.projectPath));
      return ref;
    } catch (err) {
      log.warn({ err, sessionId: this.id }, 'checkpoint failed');
      return null;
    }
  }

  /** After a turn: which files changed since its checkpoint, and whether tests passed. */
  private async summarize(n: number, ref: string, tests: { command: string; passed: boolean } | null): Promise<void> {
    const dir = this.s.projectPath;
    const before = await resolveRef(dir, ref);
    if (!before) return;
    const after = await snapshot(dir);
    const afterRef = `${ref}-after`;
    await saveRef(dir, afterRef, after);
    const files = await changes(dir, before, after);
    this.record({
      type: 'nicode',
      subtype: 'turn_summary',
      turn: n,
      from: ref,
      to: afterRef,
      files: files.slice(0, 200),
      totalFiles: files.length,
      add: files.reduce((a, f) => a + f.add, 0),
      del: files.reduce((a, f) => a + f.del, 0),
      ...(tests ? { tests } : {}),
    });
    void prune(dir).catch(() => undefined);
  }

  /** Rewinds the project files to a checkpoint (a turn's "before", or an undo point). */
  async rewind(target: { turn: number } | { ref: string }): Promise<{ changed: number; undoRef: string }> {
    if (this.busy) throw new RpcError('busy', 'Stop Claude first, then rewind');
    await this.summarizing;
    const ref = 'turn' in target ? `${CP_PREFIX}${this.id}/${target.turn}` : target.ref;
    if (!ref.startsWith(`${CP_PREFIX}${this.id}/`)) throw new RpcError('forbidden', 'That checkpoint belongs to another chat');
    const sha = await resolveRef(this.s.projectPath, ref);
    if (!sha) throw new RpcError('not_found', 'That checkpoint no longer exists');
    const { changed, before } = await restoreFiles(this.s.projectPath, sha);
    const undoRef = `${CP_PREFIX}${this.id}/undo-${Date.now()}`;
    await saveRef(this.s.projectPath, undoRef, before);
    const what = 'turn' in target ? `how they were before message #${target.turn + 1} of this chat` : 'how they were before the last rewind';
    this.record({ type: 'nicode', subtype: 'rewind', ...('turn' in target ? { turn: target.turn } : { ref }), undoRef, changed });
    this.pendingNote = `[niCode note: the user rewound the project files to ${what}. Files may differ from what you saw earlier; re-read them before editing.]`;
    return { changed, undoRef };
  }

  async send(text: string, images: ImageInput[] = []): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.busy = true;
    this.stderrTail = '';
    this.setState('running');
    await this.summarizing;
    if (this.s.turns === undefined) {
      const past = await this.deps.store.history(this.id).catch(() => []);
      this.s.turns = past.filter((e) => e.event.type === 'nicode' && e.event.subtype === 'user_turn').length;
    }
    const n = this.s.turns++;
    this.deps.store.upsert(this.s);
    const ref = await this.checkpoint(n);
    this.turn = { n, ref };
    this.record({ type: 'nicode', subtype: 'user_turn', text, turn: n, checkpoint: ref, ...(images.length ? { imageCount: images.length } : {}) });
    const note = this.pendingNote;
    this.pendingNote = null;
    try {
      if (!this.proc || this.proc.exitCode !== null) this.proc = await this.spawnProcess();
    } catch (err) {
      this.busy = false;
      this.setState('error', (err as Error).message);
      throw err;
    }
    const msg = {
      type: 'user',
      message: {
        role: 'user',
        content: [...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })), { type: 'text', text: note ? `${note}

${text}` : text }],
      },
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

  /** After a Claude account switch: the next turn starts a fresh CLI process with the new login. */
  restartForNewLogin(): void {
    if (this.busy) this.respawnAfterTurn = true;
    else this.stopProcess();
  }

  shutdown(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.proc?.kill('SIGINT');
  }
}
