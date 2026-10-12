import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { PermissionRequest } from '../../../protocol/types.js';
import { app } from '../app.js';
import { PermissionBroker } from '../claude/permissions.js';
import { ClaudeSession, publicSummary } from '../claude/session.js';
import { SessionStore, type StoredSession } from '../claude/store.js';
import { NoParams, register, RpcError } from '../rpc.js';
import { projectOf, touchProject } from './projects.js';
import { sendPush } from './push.js';

const Mode = z.enum(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
/** Up to 4 images per message, ≤ 5 MB each (base64 is 4/3 larger). */
const Images = z
  .array(z.object({ mediaType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif']), data: z.string().min(16).max(7_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/) }))
  .max(4)
  .optional();

const sessions = new Map<string, ClaudeSession>();

/** Called when the active Claude account changes. */
export function restartClaudeProcesses(): void {
  for (const s of sessions.values()) s.restartForNewLogin();
}
let store: SessionStore;
let broker: PermissionBroker;
const lastResultPush = new Map<string, number>();

function get(id: string): ClaudeSession {
  const s = sessions.get(id);
  if (!s) throw new RpcError('not_found', 'No such session');
  return s;
}

function runningCount(): number {
  return [...sessions.values()].filter((s) => s.busy).length;
}

function ensureCapacity(): void {
  if (runningCount() >= app.config.maxRunningSessions) {
    throw new RpcError('busy', `Already running ${app.config.maxRunningSessions} sessions; wait for one to finish or stop it`);
  }
}

function describeTool(req: PermissionRequest): string {
  const i = req.input;
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  const detail = s(i.command) || s(i.file_path) || s(i.path) || s(i.url) || s(i.pattern) || '';
  return detail.length > 120 ? detail.slice(0, 117) + '…' : detail;
}

function onResult(s: StoredSession, event: Record<string, unknown>): void {
  const now = Date.now();
  if (now - (lastResultPush.get(s.sessionId) ?? 0) < 30_000) return;
  lastResultPush.set(s.sessionId, now);
  const ok = event.subtype === 'success' && !event.is_error;
  const text = typeof event.result === 'string' ? event.result.replace(/\s+/g, ' ').trim() : '';
  void sendPush(`${ok ? '✅' : '⚠️'} ${path.basename(s.projectPath)}`, (text || (ok ? 'Finished' : 'Stopped with an error')).slice(0, 120), {
    kind: 'result',
    sessionId: s.sessionId,
    projectPath: s.projectPath,
    host: app.config.publicHost,
  });
}

export async function initClaudeModule(): Promise<void> {
  store = new SessionStore(app.config.dataDir);
  broker = new PermissionBroker(app.config.dataDir, {
    projectOf: (id) => sessions.get(id)?.s.projectPath,
    onWaiting: (id, waiting) => sessions.get(id)?.setWaiting(waiting),
    notify: (req) => {
      const d = describeTool(req);
      void sendPush(`🔐 Approve ${req.toolName}?`, d || 'Claude needs your approval', { kind: 'permission', sessionId: req.sessionId, requestId: req.requestId, projectPath: sessions.get(req.sessionId)?.s.projectPath, host: app.config.publicHost }, 'approvals');
    },
  });
  await broker.start();
  for (const s of await store.load()) sessions.set(s.sessionId, new ClaudeSession(s, { store, broker, onResult }));
}

export function shutdownClaude(): void {
  broker?.stop();
  for (const s of sessions.values()) s.shutdown();
}

export function registerClaudeModule(): void {
  register(
    'claude.start',
    z.object({ projectPath: z.string(), prompt: z.string().min(1).max(200_000), model: z.string().max(100).optional(), permissionMode: Mode.optional(), images: Images }),
    async ({ projectPath, prompt, model, permissionMode, images }) => {
      const project = await projectOf(projectPath);
      ensureCapacity();
      const mode = permissionMode ?? 'default';
      app.cliPermissionMode(mode); // validates against the installed CLI
      const now = new Date().toISOString();
      const s: StoredSession = {
        sessionId: randomUUID(),
        projectPath: project,
        title: prompt.replace(/\s+/g, ' ').trim().slice(0, 80),
        state: 'idle',
        model: model ?? null,
        permissionMode: mode,
        createdAt: now,
        updatedAt: now,
        lastSeq: 0,
        claudeSessionId: null,
      };
      store.upsert(s);
      const session = new ClaudeSession(s, { store, broker, onResult });
      sessions.set(s.sessionId, session);
      await session.send(prompt, images);
      void touchProject(project);
      return publicSummary(s);
    },
  );

  register('claude.send', z.object({ sessionId: z.string(), text: z.string().min(1).max(200_000), images: Images }), async ({ sessionId, text, images }) => {
    const s = get(sessionId);
    if (s.busy) throw new RpcError('busy', 'Claude is still working on the previous message');
    ensureCapacity();
    await s.send(text, images);
    return { ok: true as const };
  });

  register('claude.interrupt', z.object({ sessionId: z.string() }), ({ sessionId }) => {
    get(sessionId).interrupt();
    return { ok: true as const };
  });

  register('claude.setMode', z.object({ sessionId: z.string(), permissionMode: Mode.optional(), model: z.string().max(100).optional() }), ({ sessionId, permissionMode, model }) => {
    const s = get(sessionId);
    if (permissionMode) app.cliPermissionMode(permissionMode);
    s.updateSettings({ ...(permissionMode ? { permissionMode } : {}), ...(model !== undefined ? { model } : {}) });
    return publicSummary(s.s);
  });

  register('claude.list', z.object({ projectPath: z.string().optional() }), async ({ projectPath }) => {
    const project = projectPath ? await projectOf(projectPath) : null;
    return store
      .list()
      .filter((s) => !project || s.projectPath === project)
      .map(publicSummary);
  });

  register('claude.history', z.object({ sessionId: z.string(), sinceSeq: z.number().int().min(0).optional() }), async ({ sessionId, sinceSeq }) => {
    const s = get(sessionId);
    const evs = await store.history(sessionId, sinceSeq ?? 0);
    return { events: evs, lastSeq: s.s.lastSeq };
  });

  register(
    'claude.permission.respond',
    z.object({
      requestId: z.string(),
      behavior: z.enum(['allow', 'deny']),
      message: z.string().max(2000).optional(),
      updatedInput: z.record(z.string(), z.unknown()).optional(),
      remember: z.boolean().optional(),
    }),
    ({ requestId, behavior, message, updatedInput, remember }) => {
      broker.respond(requestId, { behavior, message, updatedInput, remember });
      return { ok: true as const };
    },
  );

  register('claude.permission.pending', NoParams, () => broker.list());
}
