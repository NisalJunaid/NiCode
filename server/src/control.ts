/**
 * Local control socket for tools on the same server (the `nicode` CLI, a hosting panel).
 *
 * `POST /rpc {method, params}` on `<dataDir>/control.sock` (mode 600, so only the daemon's user
 * and root can connect). Only the methods in ALLOWED are reachable, and callers act as a
 * local, non-key device: anything that needs a phone's fingerprint (production guards) is
 * refused, exactly as for a browser token.
 */
import { chmod, rm } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import type { Device } from './config.js';
import { log } from './log.js';
import { dispatch } from './rpc.js';

const ALLOWED = new Set(['server.info', 'deploy.plan', 'deploy.run', 'deploy.history']);
const MAX_BODY = 64 * 1024;

export function controlSocketPath(dataDir: string): string {
  // Windows (local development only) needs a named pipe.
  return process.platform === 'win32' ? String.raw`\\.\pipe\nicode-control-` + process.pid : path.join(dataDir, 'control.sock');
}

export async function startControlServer(dataDir: string): Promise<http.Server> {
  const socketPath = controlSocketPath(dataDir);
  if (process.platform !== 'win32') await rm(socketPath, { force: true });

  const server = http.createServer((req, res) => void handle(req, res));
  // Deploys can take many minutes; the caller decides how long to wait.
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  if (process.platform !== 'win32') await chmod(socketPath, 0o600);
  log.info({ socketPath }, 'control socket listening');
  return server;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method !== 'POST' || req.url !== '/rpc') return reply(404, { error: { code: 'not_found', message: 'POST /rpc only' } });

  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) return reply(413, { error: { code: 'bad_request', message: 'Request too large' } });
  }
  let frame: { method?: unknown; params?: unknown };
  try {
    frame = JSON.parse(body);
  } catch {
    return reply(400, { error: { code: 'bad_request', message: 'Invalid JSON' } });
  }
  if (typeof frame.method !== 'string' || !ALLOWED.has(frame.method)) {
    return reply(403, { error: { code: 'forbidden', message: `Not available on the control socket: ${String(frame.method)}` } });
  }

  // Who asked, for deploy history ("panel", "cli"…). Display only; never used for authorization.
  const actor = String(req.headers['x-nicode-actor'] ?? 'local').replace(/[^\w .-]/g, '').slice(0, 40) || 'local';
  const device: Device = { id: 'local', name: actor, createdAt: new Date(0).toISOString() };

  const out = await dispatch({ id: 1, method: frame.method, params: frame.params ?? {} }, { clientId: `control:${actor}`, device });
  if (!out) return reply(400, { error: { code: 'bad_request', message: 'Invalid request' } });
  log.info({ method: frame.method, actor, ok: !('error' in out) }, 'control request');
  reply('error' in out ? 422 : 200, out);
}
