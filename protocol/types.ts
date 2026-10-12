/**
 * niCode wire protocol — single source of truth for daemon (server/) and app (app/).
 * Human-readable spec: docs/05-PROTOCOL.md. Keep both in sync; bump PROTOCOL_VERSION on breaking changes.
 */

export const PROTOCOL_VERSION = 1;

// ─────────────────────────────────────────────────────────────────────────────
// Frames
// ─────────────────────────────────────────────────────────────────────────────

export interface RequestFrame<M extends MethodName = MethodName> {
  id: number;
  method: M;
  params: MethodParams<M>;
}

export interface ResponseOk<M extends MethodName = MethodName> {
  id: number;
  result: MethodResult<M>;
}

export interface ResponseErr {
  id: number;
  error: RpcError;
}

export type ResponseFrame = ResponseOk | ResponseErr;

export interface EventFrame<E extends EventName = EventName> {
  event: E;
  data: EventData<E>;
}

export type ServerFrame = ResponseFrame | EventFrame;

export interface RpcError {
  code: ErrorCode;
  message: string;
  data?: unknown;
}

export type ErrorCode =
  | 'bad_request'      // params failed validation
  | 'unauthorized'     // missing/invalid token
  | 'forbidden'        // path outside projectsRoot, method not allowed in current setup state
  | 'not_found'
  | 'conflict'         // e.g. fs.write mtime mismatch
  | 'busy'             // e.g. claude session already running a turn
  | 'setup_required'   // Claude not logged in yet
  | 'internal';

// ─────────────────────────────────────────────────────────────────────────────
// Shared models
// ─────────────────────────────────────────────────────────────────────────────

/** Mirrors /var/lib/nicode/public/status.json written by the installer and daemon. */
export interface SetupStatus {
  version: 1;
  state: SetupState;
  step: InstallStepId | null;
  steps: InstallStep[];
  host: string | null;          // e.g. "203-0-113-7.sslip.io"
  transport: Transport;
  updatedAt: string;            // ISO 8601
  error: string | null;
}

export type SetupState =
  | 'installing'
  | 'base_ready'               // stage=base finished, no daemon
  | 'needs_claude_login'       // daemon up, Claude token missing
  | 'ready'
  | 'error';

export type Transport = 'https' | 'tailscale' | 'local';

export type InstallStepId =
  | 'detect' | 'system' | 'user' | 'harden' | 'edge'
  | 'node' | 'claude' | 'git' | 'daemon' | 'finish';

export interface InstallStep {
  id: InstallStepId;
  title: string;
  status: 'pending' | 'running' | 'done' | 'skipped' | 'failed';
  detail: string;
}

export interface ServerInfo {
  protocolVersion: number;
  daemonVersion: string;
  claudeVersion: string | null;
  hostname: string;
  publicHost: string | null;
  projectsRoot: string;
  user: string;
  /** claude = logged in via `claude /login` (~/.claude/.credentials.json) OR a setup-token in the env file. */
  setup: { claude: boolean; github: boolean };
  /** False when the daemon runs as root (Claude Code refuses bypassPermissions there). */
  bypassAvailable: boolean;
  /** The paired device this connection authenticated as. */
  device: DeviceInfo;
}

export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: string;
}

export interface Project {
  name: string;
  path: string;                 // absolute, under projectsRoot
  isGit: boolean;
  branch: string | null;
  lastOpenedAt: string | null;
}

export interface FsEntry {
  name: string;
  path: string;                 // relative to project root, '/' separated
  type: 'file' | 'dir' | 'symlink';
  size: number;
  mtimeMs: number;
  ignored: boolean;             // matched by .gitignore
}

export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  preview: string;
}

export interface GitFileStatus {
  path: string;
  index: string;                // porcelain X
  workingDir: string;           // porcelain Y
  renamedFrom?: string;
}

export interface GitStatus {
  branch: string | null;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
}

export interface GitCommit {
  hash: string;
  author: string;
  date: string;
  message: string;
}

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

export interface ClaudeSessionSummary {
  sessionId: string;
  projectPath: string;
  title: string;                // first user prompt, truncated
  state: ClaudeSessionState;
  model: string | null;
  permissionMode: PermissionMode;
  createdAt: string;
  updatedAt: string;
  lastSeq: number;
}

export type ClaudeSessionState = 'idle' | 'running' | 'awaiting_permission' | 'error';

/**
 * Raw Claude Code stream-json event, passed through untouched (shape varies by CLI version).
 * Known `type`s: 'system' (subtype 'init'), 'assistant', 'user', 'result'.
 * The daemon additionally emits type 'nicode' for its own markers (e.g. user turn echo, interrupt).
 */
export interface ClaudeStreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  [key: string]: unknown;
}

export interface TermInfo {
  termId: string;
  name: string;
  cwd: string;
  cols: number;
  rows: number;
  attached: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Methods: name → [params, result]
// ─────────────────────────────────────────────────────────────────────────────

export interface Methods {
  'server.info': [Record<string, never>, ServerInfo];

  // Setup (allowed while Claude is not yet logged in)
  'setup.status': [Record<string, never>, SetupStatus];
  'setup.claudeLogin.start': [Record<string, never>, { loginId: string; url: string }];
  'setup.claudeLogin.submit': [{ loginId: string; code: string }, { ok: true }];
  'setup.claudeLogin.setToken': [{ token: string }, { ok: true }];   // manual fallback
  'setup.github.start': [Record<string, never>, { loginId: string; userCode: string; verificationUrl: string }];
  'setup.github.poll': [{ loginId: string }, { state: 'pending' | 'done' | 'failed'; login?: string; error?: string }];
  /** Replaces the CALLING device's token only; other paired devices keep working. */
  'auth.rotate': [Record<string, never>, { token: string }];
  'auth.devices': [Record<string, never>, (DeviceInfo & { current: boolean })[]];
  'auth.revoke': [{ id: string }, { ok: true }];
  'auth.renameDevice': [{ id: string; name: string }, { ok: true }];

  // Projects
  'projects.list': [Record<string, never>, Project[]];
  'projects.clone': [{ url: string; name?: string }, Project];
  'projects.create': [{ name: string; gitInit?: boolean }, Project];
  'projects.githubRepos': [{ limit?: number }, { nameWithOwner: string; url: string; isPrivate: boolean; updatedAt: string }[]];

  // File system (paths relative to projectPath)
  'fs.list': [{ projectPath: string; dir: string }, FsEntry[]];
  'fs.read': [{ projectPath: string; path: string }, { content: string; encoding: 'utf8' | 'base64'; mtimeMs: number; size: number; truncated: boolean }];
  'fs.write': [{ projectPath: string; path: string; content: string; expectedMtimeMs?: number }, { mtimeMs: number }];
  'fs.rename': [{ projectPath: string; from: string; to: string }, { ok: true }];
  'fs.delete': [{ projectPath: string; path: string }, { ok: true }];
  'fs.search': [{ projectPath: string; query: string; regex?: boolean; glob?: string; maxResults?: number }, SearchMatch[]];

  // Git
  'git.status': [{ projectPath: string }, GitStatus];
  'git.diff': [{ projectPath: string; path?: string; staged?: boolean }, { diff: string }];
  'git.stage': [{ projectPath: string; paths: string[] }, { ok: true }];
  'git.unstage': [{ projectPath: string; paths: string[] }, { ok: true }];
  'git.discard': [{ projectPath: string; paths: string[] }, { ok: true }];
  'git.commit': [{ projectPath: string; message: string }, { hash: string }];
  'git.push': [{ projectPath: string }, { ok: true; output: string }];
  'git.pull': [{ projectPath: string }, { ok: true; output: string }];
  'git.log': [{ projectPath: string; limit?: number }, GitCommit[]];
  'git.branches': [{ projectPath: string }, { current: string | null; all: string[] }];
  'git.checkout': [{ projectPath: string; branch: string; create?: boolean }, { ok: true }];

  // Terminals (tmux-backed)
  'term.open': [{ cwd: string; name?: string; cols: number; rows: number }, TermInfo];
  'term.attach': [{ termId: string; cols: number; rows: number }, { info: TermInfo; replay: string /* base64 */ }];
  'term.write': [{ termId: string; data: string /* base64 */ }, { ok: true }];
  'term.resize': [{ termId: string; cols: number; rows: number }, { ok: true }];
  'term.close': [{ termId: string; kill?: boolean }, { ok: true }];
  'term.list': [Record<string, never>, TermInfo[]];

  // Claude Code sessions
  'claude.start': [{ projectPath: string; prompt: string; model?: string; permissionMode?: PermissionMode }, ClaudeSessionSummary];
  'claude.send': [{ sessionId: string; text: string }, { ok: true }];
  'claude.interrupt': [{ sessionId: string }, { ok: true }];
  'claude.setMode': [{ sessionId: string; permissionMode?: PermissionMode; model?: string }, ClaudeSessionSummary];
  'claude.list': [{ projectPath?: string }, ClaudeSessionSummary[]];
  'claude.history': [{ sessionId: string; sinceSeq?: number }, { events: SeqEvent[]; lastSeq: number }];
  'claude.permission.respond': [{ requestId: string; behavior: 'allow' | 'deny'; message?: string; updatedInput?: Record<string, unknown>; remember?: boolean }, { ok: true }];
  'claude.permission.pending': [Record<string, never>, PermissionRequest[]];

  // Push
  'push.register': [{ expoPushToken: string; platform: 'ios' | 'android' }, { ok: true }];
}

export interface SeqEvent {
  seq: number;
  ts: string;
  event: ClaudeStreamEvent;
}

export interface PermissionRequest {
  requestId: string;
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
}

export type MethodName = keyof Methods;
export type MethodParams<M extends MethodName> = Methods[M][0];
export type MethodResult<M extends MethodName> = Methods[M][1];

// ─────────────────────────────────────────────────────────────────────────────
// Events: name → data
// ─────────────────────────────────────────────────────────────────────────────

export interface Events {
  'setup.progress': SetupStatus;
  'term.data': { termId: string; data: string /* base64 */ };
  'term.exit': { termId: string; code: number | null };
  'claude.event': { sessionId: string } & SeqEvent;
  'claude.status': { sessionId: string; state: ClaudeSessionState; error?: string };
  'claude.permission.request': PermissionRequest;
  'claude.permission.resolved': { requestId: string; behavior: 'allow' | 'deny' | 'timeout' };
  'fs.changed': { projectPath: string; paths: string[] };
}

export type EventName = keyof Events;
export type EventData<E extends EventName> = Events[E];

// ─────────────────────────────────────────────────────────────────────────────
// Pairing URI (installer QR / `nicode pair`):
//   nicode://pair?h=<host>&p=<port>&s=<https|http>&t=<token>&n=<display name>
// ─────────────────────────────────────────────────────────────────────────────

export interface PairingInfo {
  host: string;
  port: number;
  scheme: 'https' | 'http';
  token: string;
  name: string;
}

export function parsePairingUri(uri: string): PairingInfo | null {
  const m = /^nicode:\/\/pair\?(.*)$/.exec(uri);
  if (!m) return null;
  const q = new Map<string, string>();
  for (const part of m[1].split('&')) {
    const [k, v = ''] = part.split('=');
    q.set(decodeURIComponent(k), decodeURIComponent(v));
  }
  const host = q.get('h');
  const token = q.get('t');
  if (!host || !token) return null;
  const scheme = q.get('s') === 'http' ? 'http' : 'https';
  return {
    host,
    token,
    scheme,
    port: Number(q.get('p') ?? (scheme === 'https' ? 443 : 7878)),
    name: q.get('n') ?? host,
  };
}

/** Builds the WebSocket URL for a paired host. */
export function wsUrl(p: Pick<PairingInfo, 'host' | 'port' | 'scheme'>): string {
  const ws = p.scheme === 'https' ? 'wss' : 'ws';
  const defaultPort = p.scheme === 'https' ? 443 : 80;
  return `${ws}://${p.host}${p.port === defaultPort ? '' : `:${p.port}`}/ws`;
}
