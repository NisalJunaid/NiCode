import { randomUUID } from 'node:crypto';
import http, { type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { app } from './app.js';
import { Backoff, findDevice } from './auth.js';
import type { DeviceToken } from './config.js';
import { events } from './events.js';
import { log } from './log.js';
import { dispatch } from './rpc.js';

const WS_SUBPROTOCOL_PREFIX = 'nicode.';
const backoff = new Backoff();

interface Client {
  ws: WebSocket;
  device: DeviceToken;
  alive: boolean;
}
const clients = new Map<string, Client>();

function clientIp(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? 'unknown';
  // Trust X-Forwarded-For only from the local reverse proxy (Caddy/nginx).
  if (peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1') {
    const xff = req.headers['x-forwarded-for'];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return peer;
}

function presentedToken(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  // Browser fallback (test client): Sec-WebSocket-Protocol: nicode.<token>
  const protos = req.headers['sec-websocket-protocol']?.split(',').map((s) => s.trim()) ?? [];
  return protos.find((p) => p.startsWith(WS_SUBPROTOCOL_PREFIX))?.slice(WS_SUBPROTOCOL_PREFIX.length);
}

function reject(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function startHttpServer(): http.Server {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024 * 1024,
    // Browsers offer ['nicode', 'nicode.<token>'] and require us to pick one they offered.
    // Pick plain 'nicode' so the token is never echoed back in a response header.
    handleProtocols: (protocols) => (protocols.has('nicode') ? 'nicode' : false),
  });

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url?.split('?')[0] === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, version: app.daemonVersion, state: app.status.read().state }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  server.on('upgrade', (req, socket, head) => {
    const ip = clientIp(req);
    if (req.url?.split('?')[0] !== '/ws') return reject(socket, 404, 'Not Found');
    const wait = backoff.blockedFor(ip);
    if (wait > 0) return reject(socket, 429, 'Too Many Requests');
    const device = findDevice(app.config.tokens, presentedToken(req));
    if (!device) {
      backoff.fail(ip);
      log.warn({ ip }, 'rejected websocket: bad token');
      return reject(socket, 401, 'Unauthorized');
    }
    backoff.succeed(ip);
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, device, ip));
  });

  const heartbeat = setInterval(() => {
    for (const [id, c] of clients) {
      if (!c.alive) {
        c.ws.terminate();
        clients.delete(id);
        events.remove(id);
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }, 25_000);
  server.on('close', () => clearInterval(heartbeat));

  server.listen(app.config.port, app.config.bindHost, () => {
    log.info({ host: app.config.bindHost, port: app.config.port }, 'niCode daemon listening');
  });
  return server;
}

function onConnection(ws: WebSocket, device: DeviceToken, ip: string): void {
  const clientId = randomUUID();
  const client: Client = { ws, device, alive: true };
  clients.set(clientId, client);
  events.add(clientId, (text) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(text);
  });
  log.info({ device: device.name, ip }, 'client connected');

  ws.on('pong', () => {
    client.alive = true;
  });
  ws.on('message', async (data) => {
    let frame: unknown;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return;
    }
    // Use the current device record (it may have been renamed/re-keyed since connecting).
    const res = await dispatch(frame, { clientId, device: client.device });
    if (res && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(res));
  });
  ws.on('close', () => {
    clients.delete(clientId);
    events.remove(clientId);
    log.info({ device: device.name }, 'client disconnected');
  });
  ws.on('error', (err) => log.warn({ err }, 'websocket error'));
}

/** After the token list changes: refresh device records and drop sockets of removed devices. */
export function applyTokenChange(): void {
  for (const [id, c] of clients) {
    const current = app.config.tokens.find((t) => t.id === c.device.id);
    if (!current) {
      c.ws.close(4401, 'device revoked');
      clients.delete(id);
      events.remove(id);
    } else {
      c.device = current;
    }
  }
}

export function closeAllClients(): void {
  for (const c of clients.values()) c.ws.close(1001, 'server shutting down');
}
