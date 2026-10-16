import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import type { PermissionRequest } from '../../../protocol/types.js';
import { writeFileAtomic } from '../config.js';
import { events } from '../events.js';
import { log } from '../log.js';
import { RpcError } from '../rpc.js';

export interface Decision {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  message?: string;
}

interface Pending {
  req: PermissionRequest;
  /** Where "always allow" rules for this request live (null: never remembered). */
  ruleKey: string | null;
  resolve: (d: Decision) => void;
  timer: NodeJS.Timeout;
}

interface Rules {
  [projectPath: string]: { tools: string[]; bashPrefixes: string[] };
}

/** How a session's tool requests are treated. */
export interface SessionPolicy {
  projectPath: string;
  /** Analyze (read-only) chat: writing tools and git writes are refused outright. */
  analyze: boolean;
  /** False on production servers: every request asks the phone. */
  allowRemember: boolean;
}

export interface PermissionHooks {
  /** sessionId → how to treat its requests, or undefined if unknown. */
  policyOf(sessionId: string): SessionPolicy | undefined;
  onWaiting(sessionId: string, waiting: boolean): void;
  notify(req: PermissionRequest): void;
}

const TIMEOUT_MS = Number(process.env.NICODE_PERMISSION_TIMEOUT_MS ?? 10 * 60_000);

/**
 * The phone side of Claude's permission prompts. Claude calls the MCP tool `approve`
 * (mcp/approve-server.ts), which POSTs here over a unix socket and waits for the phone's answer.
 */
export class PermissionBroker {
  readonly secret = randomBytes(24).toString('hex');
  readonly socketPath: string;
  private pending = new Map<string, Pending>();
  private rulesPath: string;
  private server: http.Server | null = null;

  constructor(
    private readonly dataDir: string,
    private readonly hooks: PermissionHooks,
  ) {
    // Unix socket on Linux; Windows (local development only) needs a named pipe.
    this.socketPath = process.platform === 'win32' ? String.raw`\\.\pipe\nicode-` + process.pid : path.join(dataDir, 'internal.sock');
    this.rulesPath = path.join(dataDir, 'permissions.json');
  }

  async start(): Promise<void> {
    if (process.platform !== 'win32') await rm(this.socketPath, { force: true });
    this.server = http.createServer((req, res) => void this.handle(req, res));
    // The approve tool may wait up to TIMEOUT_MS for the phone; don't let Node cut it off.
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 60_000;
    await new Promise<void>((resolve) => this.server!.listen(this.socketPath, resolve));
    if (process.platform !== 'win32') await chmod(this.socketPath, 0o600);
  }

  stop(): void {
    for (const p of this.pending.values()) this.finish(p, { behavior: 'deny', message: 'niCode daemon is restarting' }, 'timeout');
    this.server?.close();
  }

  list(): PermissionRequest[] {
    return [...this.pending.values()].map((p) => p.req);
  }

  respond(requestId: string, d: Decision & { remember?: boolean }): void {
    const p = this.pending.get(requestId);
    if (!p) throw new RpcError('not_found', 'This request was already answered or has expired');
    if (d.behavior === 'allow' && d.remember && p.ruleKey) void this.remember(p.ruleKey, p.req.toolName, p.req.input);
    this.finish(p, { behavior: d.behavior, updatedInput: d.updatedInput ?? p.req.input, message: d.message }, d.behavior);
  }

  /** Denies everything still pending for a session (e.g. after interrupt). */
  cancelSession(sessionId: string): void {
    for (const p of this.pending.values()) {
      if (p.req.sessionId === sessionId) this.finish(p, { behavior: 'deny', message: 'Interrupted from niCode' }, 'timeout');
    }
  }

  private finish(p: Pending, d: Decision, outcome: 'allow' | 'deny' | 'timeout'): void {
    if (!this.pending.delete(p.req.requestId)) return;
    clearTimeout(p.timer);
    p.resolve(d);
    events.emit('claude.permission.resolved', { requestId: p.req.requestId, behavior: outcome });
    if (![...this.pending.values()].some((x) => x.req.sessionId === p.req.sessionId)) this.hooks.onWaiting(p.req.sessionId, false);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || req.url !== '/permission' || req.headers['x-nicode-internal'] !== this.secret) {
      return reply(403, { error: 'forbidden' });
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed: { sessionId?: string; toolName?: string; input?: Record<string, unknown> };
    try {
      parsed = JSON.parse(body);
    } catch {
      return reply(400, { error: 'bad json' });
    }
    const { sessionId = '', toolName = '', input = {} } = parsed;
    const policy = this.hooks.policyOf(sessionId);
    if (policy?.analyze) {
      const refusal = analyzeRefusal(toolName, input);
      if (refusal) return reply(200, { behavior: 'deny', message: refusal });
    }
    const ruleKey = !policy?.projectPath || !policy.allowRemember ? null : policy.analyze ? `analyze:${policy.projectPath}` : policy.projectPath;
    if (ruleKey && (await this.isRemembered(ruleKey, toolName, input))) return reply(200, { behavior: 'allow', updatedInput: input });

    const decision = await new Promise<Decision>((resolve) => {
      const now = Date.now();
      const pr: PermissionRequest = {
        requestId: randomUUID(),
        sessionId,
        toolName,
        input,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + TIMEOUT_MS).toISOString(),
        canRemember: ruleKey !== null && (toolName !== 'Bash' || bashRulePrefix(String(input.command ?? '')) !== null),
      };
      const p: Pending = {
        req: pr,
        ruleKey,
        resolve,
        timer: setTimeout(() => this.finish(p, { behavior: 'deny', message: 'No answer from the niCode app in time' }, 'timeout'), TIMEOUT_MS),
      };
      this.pending.set(pr.requestId, p);
      // Claude gave up (process killed): drop the request.
      req.socket.on('close', () => {
        if (this.pending.has(pr.requestId)) this.finish(p, { behavior: 'deny' }, 'timeout');
      });
      this.hooks.onWaiting(sessionId, true);
      events.emit('claude.permission.request', pr);
      this.hooks.notify(pr);
    });
    if (!res.writableEnded && !res.destroyed) reply(200, decision);
  }

  private async rules(): Promise<Rules> {
    let rules: Rules;
    try {
      rules = JSON.parse(await readFile(this.rulesPath, 'utf8')) as Rules;
    } catch {
      return {};
    }
    // Rules saved before 0.9 stored one word for every command ("git"), which allowed any git
    // subcommand. Drop those; the phone is asked once more and saves a two-word rule.
    for (const r of Object.values(rules)) r.bashPrefixes = (r.bashPrefixes ?? []).filter((p) => !TWO_WORD.has(p) && !NEVER_REMEMBER.has(p));
    return rules;
  }

  private async isRemembered(ruleKey: string, tool: string, input: Record<string, unknown>): Promise<boolean> {
    const r = (await this.rules())[ruleKey];
    if (!r) return false;
    if (tool === 'Bash') {
      const prefix = bashRulePrefix(typeof input.command === 'string' ? input.command : '');
      return prefix !== null && r.bashPrefixes.includes(prefix);
    }
    return r.tools.includes(tool);
  }

  private async remember(ruleKey: string, tool: string, input: Record<string, unknown>): Promise<void> {
    if (!ruleKey) return;
    const rules = await this.rules();
    const r = (rules[ruleKey] ??= { tools: [], bashPrefixes: [] });
    if (tool === 'Bash') {
      const prefix = bashRulePrefix(typeof input.command === 'string' ? input.command : '');
      if (prefix && !r.bashPrefixes.includes(prefix)) r.bashPrefixes.push(prefix);
    } else if (!r.tools.includes(tool)) {
      r.tools.push(tool);
    }
    await writeFileAtomic(this.rulesPath, JSON.stringify(rules, null, 2)).catch((err) => log.warn({ err }, 'could not save permission rules'));
  }
}

// ── Rule matching ────────────────────────────────────────────────────────────

/** Commands that run other commands: "always allow sudo" would allow everything. */
const NEVER_REMEMBER = new Set(['sudo', 'su', 'doas', 'bash', 'sh', 'zsh', 'dash', 'env', 'xargs', 'eval', 'exec', 'nohup', 'timeout', 'nice', 'ionice', 'time', 'watch', 'command', 'builtin', 'source', '.', 'ssh', 'parallel', 'find', 'awk']);
/** Tools whose first word says little: rules keep the subcommand too ("git status", "npm test"). */
const TWO_WORD = new Set(['git', 'npm', 'pnpm', 'yarn', 'bun', 'npx', 'composer', 'php', 'docker', 'pm2', 'systemctl', 'kubectl', 'cargo', 'go', 'python', 'python3', 'node', 'gh', 'apt', 'apt-get']);

/**
 * The rule a Bash command matches ("ls", "git status"), or null when it may never be
 * auto-allowed: chained, piped, substituted or multi-line commands, and command runners.
 */
export function bashRulePrefix(command: string): string | null {
  const cmd = command.trim();
  if (!cmd || /[;&|`$<>()\n\r\\]/.test(cmd)) return null;
  const words = cmd.split(/\s+/);
  const first = words[0]!;
  if (NEVER_REMEMBER.has(first) || first.includes('/') || /^\w+=/.test(first)) return null;
  if (!TWO_WORD.has(first)) return first;
  const sub = words[1];
  if (!sub || sub.startsWith('-')) return null;
  return `${first} ${sub}`;
}

/** Tools that write files. Analyze chats never get them (also blocked by --disallowedTools). */
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const GIT_WRITE =
  /(^|[\s;&|(`])git\s+(?:-[Cc]\s+\S+\s+|-\S+\s+)*(commit|add|rm|mv|checkout|switch|reset|stash|pull|merge|rebase|cherry-pick|revert|restore|clean|push|apply|am|tag|branch\s+-[dDmMf]|fetch|gc|prune|update-ref|update-index|config|init|worktree|submodule)\b/;

/** Why an Analyze chat may not do this (null: ask the phone as usual). */
export function analyzeRefusal(tool: string, input: Record<string, unknown>): string | null {
  if (WRITE_TOOLS.has(tool)) return 'Analyze mode is read-only: editing files is not allowed. Describe the change instead.';
  if (tool === 'Bash' && typeof input.command === 'string' && GIT_WRITE.test(input.command)) {
    return 'Analyze mode is read-only: git commands that change the repository are not allowed. Use git log, show, diff, status or blame.';
  }
  return null;
}
