/**
 * niCode wire protocol — single source of truth for daemon (server/) and app (app/).
 * Human-readable spec: docs/05-PROTOCOL.md. Keep both in sync; bump PROTOCOL_VERSION on breaking changes.
 */

export const PROTOCOL_VERSION = 2;

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
  | 'dirty'            // git.pull / deploy.run: uncommitted changes on the server (data.dirty lists them)
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
  /** Modes the installed Claude CLI supports (and the daemon allows). Show only these. */
  permissionModes: PermissionMode[];
  /** The paired device this connection authenticated as. */
  device: DeviceInfo;
  /** 'production': Claude may only analyze (read-only); deploy actions ask for a fingerprint. */
  role: ServerRole;
  /** The daemon (and so anything the phone runs) runs as root. */
  isRoot: boolean;
  /**
   * How Analyze chats are kept read-only. 'kernel': Claude runs in a sandbox where the project
   * (including .git) is mounted read-only. 'soft': tool blocking and approvals only.
   */
  analyzeIsolation: 'kernel' | 'soft';
  /** Why Analyze can't run on this server right now (null when it can). */
  analyzeBlocked: string | null;
}

export type ServerRole = 'development' | 'production';

export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: string;
  /** 'key' = phone with a hardware key (signs every login); 'token' = expiring browser token. */
  kind: 'key' | 'token';
  /** Token devices only. */
  expiresAt?: string;
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
  /** Branch/tag names pointing at this commit ("HEAD -> main", "origin/main", "tag: v1"). */
  refs?: string[];
  /** On the upstream branch already (null: no upstream). */
  pushed?: boolean | null;
}

export interface GitCommitDetail extends GitCommit {
  email: string;
  body: string;
  parents: string[];
  files: TurnFileChange[];
}

/** What restoring to a commit would do (shown before asking for confirmation). */
export interface RestorePreview {
  hash: string;
  subject: string;
  /** Commits after it on the current branch. */
  commitsAfter: number;
  /** Files that would change (first 100) and the total. */
  files: TurnFileChange[];
  totalFiles: number;
  /** Uncommitted changes exist (they are backed up first). */
  dirty: boolean;
  /** The commit is on the current branch (needed for "reset"). */
  isAncestor: boolean;
  /** Commits that a reset would drop are already pushed (a force push would be needed). */
  pushedAfter: boolean;
  /** Claude is running in this project (restoring is refused until it stops). */
  busy: boolean;
}

export interface RestoreResult {
  backupRef: string;
  head: string;
  removedCommits: number;
  needsForcePush: boolean;
}

export interface GitBackup {
  ref: string;
  createdAt: string;
  /** HEAD at the time of the backup. */
  head: string;
  subject: string;
  hadUncommitted: boolean;
}

/** Proof that the phone's owner confirmed a destructive action with a fresh biometric unlock. */
export interface ConfirmProof {
  nonce: string;
  /** base64 signature over confirmMessage(nonce, action, fields) with the device key. */
  sig: string;
}

/** The exact string a device signs to confirm a destructive action (see auth.confirm). */
export function confirmMessage(nonce: string, action: string, fields: string[]): string {
  return `nicode-confirm:v1:${nonce}:${JSON.stringify([action, ...fields])}`;
}

/**
 * 'analyze' = read-only troubleshooting: Claude reads code, logs and (through a read-only DB user)
 * the database, but can't change the project or its git repository. The only mode on production servers.
 * 'default' = ask on the phone for anything risky. The daemon maps it to the CLI's own name
 * ('default' on older CLIs, 'manual' on newer ones). 'auto' lets the CLI decide routine actions
 * itself and only asks for risky ones (newer CLIs only).
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions' | 'analyze';

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

/** One file a Claude turn changed (paths relative to the project). */
export interface TurnFileChange {
  path: string;
  status: 'A' | 'M' | 'D' | 'R';
  add: number;
  del: number;
  binary: boolean;
}

/**
 * `nicode` marker `turn_summary`, recorded after each turn in a git project:
 * what changed since the checkpoint taken before the turn, and the last test run.
 */
export interface TurnSummary {
  turn: number;
  /** Checkpoint refs before / after the turn (for diffs and rewinds). */
  from: string;
  to: string;
  files: TurnFileChange[];
  totalFiles: number;
  add: number;
  del: number;
  tests?: { command: string; passed: boolean };
}

/**
 * `nicode` marker `repo_changed`, recorded after an Analyze turn when the repository differs from
 * before the turn (HEAD, refs, stashes or working tree). Analyze can't write, so this means
 * something else changed it (for example a deploy that ran meanwhile).
 */
export interface RepoChanged {
  turn: number;
  /** Human-readable differences, e.g. "HEAD 1a2b3c4 → 5d6e7f8", "working tree: M src/app.ts". */
  changes: string[];
}

/** An image attached to a chat message (max 4 per message, ≤ 5 MB each). Only `imageCount` is kept in history. */
export interface ImageInput {
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  /** base64, no data: prefix */
  data: string;
}

export interface Methods {
  'server.info': [Record<string, never>, ServerInfo];

  // Setup (allowed while Claude is not yet logged in)
  'setup.status': [Record<string, never>, SetupStatus];
  'setup.claudeLogin.start': [Record<string, never>, { loginId: string; url: string }];
  'setup.claudeLogin.submit': [{ loginId: string; code: string; label?: string; activate?: boolean }, { ok: true; accountId: string }];
  'setup.claudeLogin.setToken': [{ token: string; label?: string; activate?: boolean }, { ok: true; accountId: string }]; // manual fallback
  'setup.claudeAccounts.list': [Record<string, never>, { accounts: ClaudeAccount[] }];
  'setup.claudeAccounts.switch': [{ id: string }, { accounts: ClaudeAccount[] }];
  'setup.claudeAccounts.rename': [{ id: string; label: string }, { accounts: ClaudeAccount[] }];
  'setup.claudeAccounts.logout': [{ id: string }, { accounts: ClaudeAccount[]; switchedTo: string | null }];
  /** Usage per account id (refresh: ask Claude's usage endpoint again, at most once a minute per account). */
  'setup.claudeAccounts.usage': [{ refresh?: boolean }, { usage: Record<string, AccountUsage>; activeId: string | null }];
  'setup.github.start': [Record<string, never>, { loginId: string; userCode: string; verificationUrl: string }];
  'setup.github.poll': [{ loginId: string }, { state: 'pending' | 'done' | 'failed'; login?: string; error?: string }];
  'auth.devices': [Record<string, never>, (DeviceInfo & { current: boolean })[]];
  'auth.revoke': [{ id: string }, { ok: true }];
  'auth.renameDevice': [{ id: string; name: string }, { ok: true }];
  /** Switching to 'development' needs `proof` (action 'server.setRole', fields ['development']). */
  'server.setRole': [{ role: ServerRole; proof?: ConfirmProof }, { role: ServerRole }];

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
  /** `base`/`head`: checkpoint refs (refs/nicode/cp/…) to diff one turn's changes; `commit`: one commit's diff. */
  'git.diff': [{ projectPath: string; path?: string; staged?: boolean; base?: string; head?: string; commit?: string }, { diff: string }];
  'git.stage': [{ projectPath: string; paths: string[] }, { ok: true }];
  'git.unstage': [{ projectPath: string; paths: string[] }, { ok: true }];
  'git.discard': [{ projectPath: string; paths: string[] }, { ok: true }];
  'git.commit': [{ projectPath: string; message: string }, { hash: string }];
  'git.push': [{ projectPath: string }, { ok: true; output: string }];
  /**
   * Fast-forward pull. With uncommitted changes it fails with code 'dirty' unless `onDirty` says
   * what to do: 'stash' (kept, recoverable) or 'discard' (needs `proof` on production servers,
   * action 'git.pull', fields [projectPath, 'discard']).
   */
  'git.pull': [{ projectPath: string; onDirty?: 'stash' | 'discard'; proof?: ConfirmProof }, { ok: true; output: string; stash?: string }];
  /** What a pull would do: local changes, and the commits it would bring in (after a fetch). */
  'git.pullPreflight': [{ projectPath: string }, PullPreflight];
  'git.log': [{ projectPath: string; limit?: number; skip?: number }, GitCommit[]];
  'git.show': [{ projectPath: string; hash: string }, GitCommitDetail];
  'git.restorePreview': [{ projectPath: string; hash: string }, RestorePreview];
  /** commit = a new commit with the old code (history kept); reset = move the branch back (rewrites history). */
  'git.restoreTo': [{ projectPath: string; hash: string; mode: 'commit' | 'reset'; proof: ConfirmProof }, RestoreResult];
  'git.undoRestore': [{ projectPath: string; backupRef: string; proof: ConfirmProof }, { head: string }];
  'git.backups': [{ projectPath: string }, GitBackup[]];
  /** A nonce for a ConfirmProof (single use, 60 s). */
  'auth.confirmChallenge': [Record<string, never>, { nonce: string; expiresAt: string }];
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
  'claude.start': [{ projectPath: string; prompt: string; model?: string; permissionMode?: PermissionMode; images?: ImageInput[] }, ClaudeSessionSummary];
  'claude.send': [{ sessionId: string; text: string; images?: ImageInput[] }, { ok: true }];
  /** Rewind the project files to before a turn (`turn`) or back to an undo point (`ref` from a rewind). */
  'claude.rewind': [{ sessionId: string; turn?: number; ref?: string }, { changed: number; undoRef: string }];
  'claude.interrupt': [{ sessionId: string }, { ok: true }];
  'claude.setMode': [{ sessionId: string; permissionMode?: PermissionMode; model?: string }, ClaudeSessionSummary];
  'claude.list': [{ projectPath?: string }, ClaudeSessionSummary[]];
  'claude.history': [{ sessionId: string; sinceSeq?: number }, { events: SeqEvent[]; lastSeq: number }];
  'claude.permission.respond': [{ requestId: string; behavior: 'allow' | 'deny'; message?: string; updatedInput?: Record<string, unknown>; remember?: boolean }, { ok: true }];
  'claude.permission.pending': [Record<string, never>, PermissionRequest[]];

  // Push
  'push.register': [{ expoPushToken: string; platform: 'ios' | 'android'; prefs?: Partial<PushPrefs> }, { ok: true }];
  'push.test': [Record<string, never>, { sent: number }];

  // Websites & domains (nginx). See docs/05 "Sites".
  'sites.status': [Record<string, never>, SitesStatus];
  'sites.list': [Record<string, never>, Site[]];
  'sites.config': [{ name: string }, { text: string }];
  'sites.checkDns': [{ domain: string }, DnsCheck];
  'sites.detect': [{ projectPath: string }, SiteSuggestion];
  'sites.create': [SiteCreate, { site: Site; log: string[] }];
  'sites.setEnabled': [{ name: string; enabled: boolean }, Site];
  'sites.enableHttps': [{ name: string; email?: string; opId?: string }, { site: Site; log: string[] }];
  'sites.remove': [{ name: string; deleteFolder?: false }, { ok: true }];

  // Apps (pm2) & project tasks. See docs/05 "Apps & tasks".
  'apps.status': [Record<string, never>, AppsStatus];
  'apps.setup': [{ opId?: string }, AppsStatus];
  'apps.list': [Record<string, never>, AppProcess[]];
  'apps.create': [AppCreate, { app: AppProcess }];
  'apps.action': [{ name: string; action: 'start' | 'stop' | 'restart' | 'delete' }, { ok: true }];
  'apps.logs': [{ name: string; lines?: number }, { text: string }];
  'apps.deploy': [{ name: string; opId?: string }, { app: AppProcess; steps: TaskStepState[] }];
  'apps.startOptions': [{ projectPath: string }, AppStartOptions];
  'tasks.list': [{ projectPath: string }, ProjectTask[]];
  /** Migrate tasks on production servers need `proof` (action 'tasks.run', fields [projectPath, taskId]). */
  'tasks.run': [{ projectPath: string; taskId: string; opId?: string; proof?: ConfirmProof }, { code: number; output: string }];
  // Deploy (see docs/05 "Deploy")
  'deploy.plan': [{ projectPath: string }, DeployPlan];
  /**
   * Runs the chosen steps in order: pull → install → build → migrate → restart. Progress:
   * `tasks.step` / `tasks.output` with `opId`. On production, migrate and discard need `proof`
   * (action 'deploy.run', fields [projectPath, ...deployGuards(params)]).
   */
  'deploy.run': [{ projectPath: string; steps: DeploySteps; onDirty?: 'stash' | 'discard'; proof?: ConfirmProof; opId?: string }, DeployRecord];
  'deploy.history': [{ projectPath: string }, DeployRecord[]];
  // Analyze mode: read-only database access per project (see docs/05 "Analyze")
  'analyze.db.get': [{ projectPath: string }, AnalyzeDb | null];
  'analyze.db.suggest': [{ projectPath: string }, AnalyzeDbSuggestion];
  /** Tests the URL, verifies the user can't write, then saves it. The password never comes back. */
  'analyze.db.set': [{ projectPath: string; url: string }, AnalyzeDb];
  'analyze.db.clear': [{ projectPath: string }, { ok: true }];
  // Logs (see docs/05 "Logs")
  'logs.sources': [{ projectPath?: string }, LogSource[]];
  'logs.tail': [{ id: string; lines?: number; filter?: string }, { text: string }];
  'logs.follow': [{ id: string }, { followId: string }];
  'logs.unfollow': [{ followId: string }, { ok: true }];
  // Live preview (see docs/05 "Live preview")
  'preview.status': [Record<string, never>, PreviewStatus];
  'preview.open': [{ port: number; opId?: string }, PreviewLink];
  'preview.list': [Record<string, never>, PreviewSite[]];
  'preview.close': [{ port: number }, { ok: true }];
  'preview.devOptions': [{ projectPath: string }, DevOptions];
  'preview.devStart': [{ projectPath: string; opId?: string }, DevServer];
  'preview.devStop': [{ projectPath: string }, { ok: true }];
  'preview.devStatus': [{ projectPath: string }, { dev: DevServer | null; output: string }];
}

// ── Websites & domains ───────────────────────────────────────────────────────

/** static = plain files; spa = single-page app (unknown paths → index.html); php = php-fpm (e.g. Laravel); proxy = app on a local port. */
export type SiteKind = 'static' | 'spa' | 'php' | 'proxy';

export interface Site {
  /** nginx config file name in sites-available (e.g. "shop.example.com.conf"). */
  name: string;
  enabled: boolean;
  /** Created by niCode (only these can be removed from the app). */
  managed: boolean;
  /** niCode's own site, or one owned by a hosting panel; never changed from the app. */
  protected: boolean;
  /** Who writes this config: niCode, a hosting panel (`# managed-by: hostpanel`), or unknown. Older daemons omit it. */
  managedBy?: 'nicode' | 'panel' | null;
  /** The panel's id for the site (`site=<slug>` in its marker); null for the panel's own vhost. */
  panelSite?: string | null;
  domains: string[];
  kind: SiteKind | 'unknown';
  root: string | null;
  proxyPort: number | null;
  /** Project this site serves (its root is inside the project). */
  projectPath: string | null;
  https: boolean;
  certExpiresAt: string | null;
}

export interface SitesStatus {
  supported: boolean;
  webServer: 'nginx' | 'caddy' | 'none';
  /** Why domains can't be managed here (when !supported). */
  reason?: string;
  serverIp: string | null;
  certbot: boolean;
  /** Installed php-fpm versions, e.g. ["8.2", "8.1"]. */
  phpVersions: string[];
}

export interface DnsCheck {
  domain: string;
  addresses: string[];
  serverIp: string | null;
  pointsHere: boolean;
}

export interface SiteSuggestion {
  kind: SiteKind;
  /** Folder inside the project to serve ('' = project root). */
  webRoot: string;
  port: number | null;
  /** Human explanation, e.g. "Laravel app (artisan found) → serve public/ with PHP 8.2". */
  reason: string;
}

export interface SiteCreate {
  domain: string;
  /** Also serve www.<domain>. */
  includeWww: boolean;
  /** Existing project folder, or a new folder created under projectsRoot. */
  project: { path: string } | { newFolder: string };
  kind: SiteKind;
  webRoot: string;
  port?: number;
  phpVersion?: string;
  https: boolean;
  /** Let's Encrypt account email (optional). */
  email?: string;
  /** Echoed in sites.progress events. */
  opId?: string;
}

export type SiteStep = 'folder' | 'config' | 'enable' | 'test' | 'reload' | 'certbot';

// ── Apps (pm2) & tasks ───────────────────────────────────────────────────────

export interface AppsStatus {
  node: string | null;
  pm2: string | null;
  /** pm2 restores saved apps after a reboot. */
  startupEnabled: boolean;
}

export interface AppProcess {
  name: string;
  pmId: number;
  status: 'online' | 'stopped' | 'errored' | 'launching' | 'stopping' | 'one-launch-status' | string;
  cpu: number;
  memoryMb: number;
  uptimeSince: string | null;
  restarts: number;
  cwd: string;
  projectPath: string | null;
  /** What runs, e.g. "npm run start" or "node dist/main.js". */
  command: string;
  port: number | null;
  /** Something answers on the port (null when no port is known). */
  listening: boolean | null;
  /** Started by niCode (others are listed and controllable too). */
  managed: boolean;
}

export interface AppCreate {
  projectPath: string;
  name: string;
  start: { kind: 'script'; script: string } | { kind: 'command'; command: string };
  port?: number;
  env?: Record<string, string>;
  /** Run install + build before starting. */
  buildFirst?: boolean;
  opId?: string;
}

export interface AppStartOptions {
  /** package.json scripts suitable for running (start, serve, preview, …). */
  scripts: { name: string; command: string }[];
  suggested: { kind: 'script'; script: string } | { kind: 'command'; command: string } | null;
  port: number | null;
  hasBuild: boolean;
  reason: string;
}

export interface ProjectTask {
  id: string;
  label: string;
  /** The exact command that will run. */
  command: string;
  group: 'install' | 'build' | 'script' | 'php' | 'git' | 'migrate';
}

export interface PullPreflight {
  branch: string | null;
  upstream: string | null;
  /** `git status --porcelain` lines, e.g. " M src/app.ts", "?? notes.txt". Empty = clean. */
  dirty: string[];
  ahead: number;
  behind: number;
  /** Commits a pull would bring in (newest first, at most 50). */
  incoming: { hash: string; subject: string; author: string; date: string }[];
  /** Set when `git fetch` failed (the counts are then from the last fetch). */
  fetchError: string | null;
}

export interface DeploySteps {
  pull: boolean;
  install: boolean;
  build: boolean;
  migrate: boolean;
  /** Reload the project's pm2 apps. */
  restart: boolean;
}

/** The deploy choices that need a fingerprint on production servers, in signing order. */
export function deployGuards(p: { steps: DeploySteps; onDirty?: 'stash' | 'discard' }): string[] {
  const out: string[] = [];
  if (p.steps.pull && p.onDirty === 'discard') out.push('discard');
  if (p.steps.migrate) out.push('migrate');
  return out;
}

export interface DeployPlan {
  production: boolean;
  /** Null when the project isn't a git repository. */
  pull: PullPreflight | null;
  /** Commands each step would run (empty / null = the step doesn't apply). */
  install: string[];
  build: string | null;
  /** `status` is the framework's migration status output (pending ones), when it has one. */
  migrate: { taskId: string; command: string; status: string | null } | null;
  apps: AppProcess[];
  /** Suggested selection. */
  defaults: DeploySteps;
}

export interface DeployRecord {
  id: string;
  projectPath: string;
  device: string;
  startedAt: string;
  finishedAt: string;
  /** HEAD before and after (short hashes, null outside git). */
  before: string | null;
  after: string | null;
  steps: TaskStepState[];
  ok: boolean;
}

export interface AnalyzeDb {
  kind: 'postgres' | 'mysql';
  host: string;
  port: number;
  database: string;
  user: string;
  verifiedAt: string;
}

/** Ready-to-run SQL that creates a read-only user, guessed from the project's .env. */
export interface AnalyzeDbSuggestion {
  kind: 'postgres' | 'mysql' | null;
  /** Why nothing could be suggested (kind null). */
  reason?: string;
  host: string;
  port: number;
  database: string;
  user: string;
  /** Freshly generated; only part of `sql` and `url`. */
  password: string;
  sql: string;
  url: string;
}

/** A Claude subscription login on the server. The token itself never leaves the server. */
export interface ClaudeAccount {
  id: string;
  label: string;
  /** token = added through niCode (setup-token); cli = `claude /login` on the server itself. */
  kind: 'token' | 'cli';
  active: boolean;
  addedAt: string | null;
  lastUsedAt: string | null;
  /** Last 4 characters of the token, to tell accounts apart. */
  hint: string | null;
}

/** One usage window of a Claude subscription. */
export interface UsageWindow {
  /** 0–100 */
  usedPercent: number;
  resetsAt: string | null;
}

/** A Claude account's usage: the 5-hour session window and the weekly window. */
export interface AccountUsage {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  updatedAt: string;
  /** api = Claude's usage endpoint; chat = limits Claude Code reported while chatting. */
  source: 'api' | 'chat';
  /** From chats: allowed / allowed_warning (getting close) / rejected (limit reached). */
  status?: 'allowed' | 'allowed_warning' | 'rejected';
  error?: string;
}

/** Which notifications a phone wants (all on by default). */
export interface PushPrefs {
  approvals: boolean;
  finished: boolean;
  appCrashes: boolean;
  siteDown: boolean;
}

/** A log the server can show. Read by `id` only (the path is informational). */
export interface LogSource {
  id: string;
  label: string;
  group: 'nginx' | 'pm2' | 'project' | 'system';
  /** File path or command, for display. */
  detail: string;
  projectPath: string | null;
}

export interface PreviewStatus {
  /** Previews of ports need nginx + root/sudo (like Sites). Domain previews always work. */
  supported: boolean;
  reason?: string;
}

/** A one-time sign-in link for a preview host; opening it sets a 12 h cookie for that host. */
export interface PreviewLink {
  url: string;
  host: string;
  port: number;
  https: boolean;
}

export interface PreviewSite {
  port: number;
  host: string;
  https: boolean;
}

export interface DevOptions {
  available: boolean;
  /** e.g. "npm run dev -- --port <port> --host 127.0.0.1" */
  command: string | null;
  framework: string | null;
  reason?: string;
}

/** A temporary dev server (hot reload) the daemon runs for previews. Output: `tasks.output` with `opId`. */
export interface DevServer {
  projectPath: string;
  port: number;
  command: string;
  framework: string | null;
  state: 'starting' | 'running' | 'exited';
  startedAt: string;
  exitCode: number | null;
  opId: string;
}

export interface TaskStepState {
  step: string;
  label: string;
  status: 'running' | 'done' | 'failed' | 'skipped';
  detail?: string;
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
  /** False when "Always allow" isn't offered (production servers, command runners, chained commands). */
  canRemember?: boolean;
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
  /** Output of a running task / build / deploy step (matched by opId). */
  'tasks.output': { opId: string; chunk: string };
  'logs.data': { followId: string; chunk: string };
  'claude.usage': { accountId: string; usage: AccountUsage };
  /** Steps of apps.create / apps.deploy / apps.setup / deploy.run. */
  'tasks.step': { opId: string } & TaskStepState;
  /** The server's role changed (from a phone or `nicode role`): re-read server.info. */
  'server.role': { role: ServerRole };
  /** Live steps of sites.create / sites.enableHttps (matched by the opId the app sent). */
  'sites.progress': { opId: string; step: SiteStep; status: 'running' | 'done' | 'failed' | 'skipped'; detail?: string };
}

export type EventName = keyof Events;
export type EventData<E extends EventName> = Events[E];

// ─────────────────────────────────────────────────────────────────────────────
// Pairing & login (HTTP, before the WebSocket) — see docs/05-PROTOCOL.md "Authentication".
//
//   QR / link from `nicode pair`:
//     nicode://pair?h=<host>&p=<port>&s=<https|http>&c=<one-time code>&n=<server name>
//   1. POST {base}/pair            PairRequest → PairResponse   (code is single-use, 10 min)
//   2. GET  {base}/auth/challenge  → Challenge                   (nonce is single-use, 60 s)
//   3. WebSocket {base}/ws with
//        Authorization: Signature deviceId="<id>", nonce="<nonce>", sig="<base64 signature>"
//      signing the UTF-8 bytes of authMessage(nonce, deviceId).
// ─────────────────────────────────────────────────────────────────────────────

export type KeyAlg = 'RS256' | 'ES256' | 'Ed25519';

export interface PairRequest {
  code: string;
  deviceName: string;
  alg: KeyAlg;
  /** base64 DER (SPKI, or PKCS#1 for RSA), raw 32-byte Ed25519, raw 65-byte P-256, or PEM. */
  publicKey: string;
}

export interface PairResponse {
  deviceId: string;
  deviceName: string;
  hostname: string;
  publicHost: string | null;
}

export interface Challenge {
  nonce: string;
  expiresAt: string;
}

/** The exact string a device signs to log in (must match the daemon's server/src/auth.ts). */
export function authMessage(nonce: string, deviceId: string): string {
  return `nicode-auth:v1:${nonce}:${deviceId}`;
}

/**
 * A phone's device id is derived from its public key: "d_" + the first 8 hex chars of
 * sha256(publicKey) (the exact base64/PEM text sent to /pair or put in NICODE_DEVICE_PUBKEY).
 * The app computes it with expo-crypto; the daemon and installer derive the same value.
 */
export const DEVICE_ID_RULE = 'd_ + sha256hex(publicKey).slice(0, 8)';

export function signatureHeader(deviceId: string, nonce: string, sigBase64: string): string {
  return `Signature deviceId="${deviceId}", nonce="${nonce}", sig="${sigBase64}"`;
}

export interface PairingInfo {
  host: string;
  port: number;
  scheme: 'https' | 'http';
  /** One-time pairing code. */
  code: string;
  name: string;
}

export function parsePairingUri(uri: string): PairingInfo | null {
  const m = /^nicode:\/\/pair\?(.*)$/.exec(uri);
  if (!m) return null;
  const q = new Map<string, string>();
  for (const part of (m[1] ?? '').split('&')) {
    const [k = '', v = ''] = part.split('=');
    if (k) q.set(decodeURIComponent(k), decodeURIComponent(v));
  }
  const host = q.get('h');
  const code = q.get('c');
  if (!host || !code) return null;
  const scheme = q.get('s') === 'http' ? 'http' : 'https';
  return {
    host,
    code,
    scheme,
    port: Number(q.get('p') ?? (scheme === 'https' ? 443 : 7878)),
    name: q.get('n') ?? host,
  };
}

/** https://host[:port] — base for /pair, /auth/challenge, /health. */
export function baseUrl(p: Pick<PairingInfo, 'host' | 'port' | 'scheme'>): string {
  const defaultPort = p.scheme === 'https' ? 443 : 80;
  return `${p.scheme}://${p.host}${p.port === defaultPort ? '' : `:${p.port}`}`;
}

/** Builds the WebSocket URL for a paired host. */
export function wsUrl(p: Pick<PairingInfo, 'host' | 'port' | 'scheme'>): string {
  const ws = p.scheme === 'https' ? 'wss' : 'ws';
  const defaultPort = p.scheme === 'https' ? 443 : 80;
  return `${ws}://${p.host}${p.port === defaultPort ? '' : `:${p.port}`}/ws`;
}
