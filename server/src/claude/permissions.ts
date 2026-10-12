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
  projectPath: string;
  resolve: (d: Decision) => void;
  timer: NodeJS.Timeout;
}

interface Rules {
  [projectPath: string]: { tools: string[]; bashPrefixes: string[] };
}

export interface PermissionHooks {
  /** sessionId → its project, or undefined if unknown. */
  projectOf(sessionId: string): string | undefined;
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
    if (d.behavior === 'allow' && d.remember) void this.remember(p.projectPath, p.req.toolName, p.req.input);
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
    const projectPath = this.hooks.projectOf(sessionId) ?? '';
    if (await this.isRemembered(projectPath, toolName, input)) return reply(200, { behavior: 'allow', updatedInput: input });

    const decision = await new Promise<Decision>((resolve) => {
      const now = Date.now();
      const pr: PermissionRequest = {
        requestId: randomUUID(),
        sessionId,
        toolName,
        input,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + TIMEOUT_MS).toISOString(),
      };
      const p: Pending = {
        req: pr,
        projectPath,
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
    try {
      return JSON.parse(await readFile(this.rulesPath, 'utf8')) as Rules;
    } catch {
      return {};
    }
  }

  private async isRemembered(projectPath: string, tool: string, input: Record<string, unknown>): Promise<boolean> {
    const r = (await this.rules())[projectPath];
    if (!r) return false;
    if (tool === 'Bash') {
      const cmd = typeof input.command === 'string' ? input.command.trim() : '';
      // Only simple commands match a prefix rule; chained/piped commands always ask.
      if (/[;&|`$<>]/.test(cmd)) return false;
      return r.bashPrefixes.includes(cmd.split(/\s+/)[0] ?? '');
    }
    return r.tools.includes(tool);
  }

  private async remember(projectPath: string, tool: string, input: Record<string, unknown>): Promise<void> {
    if (!projectPath) return;
    const rules = await this.rules();
    const r = (rules[projectPath] ??= { tools: [], bashPrefixes: [] });
    if (tool === 'Bash') {
      const first = typeof input.command === 'string' ? input.command.trim().split(/\s+/)[0] : '';
      if (first && !r.bashPrefixes.includes(first)) r.bashPrefixes.push(first);
    } else if (!r.tools.includes(tool)) {
      r.tools.push(tool);
    }
    await writeFileAtomic(this.rulesPath, JSON.stringify(rules, null, 2)).catch((err) => log.warn({ err }, 'could not save permission rules'));
  }
}
