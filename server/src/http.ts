import { randomUUID } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import type { PairResponse } from '../../protocol/types.js';
import { app } from './app.js';
import {
  authMessage,
  Backoff,
  ChallengeStore,
  findPairingCode,
  findTokenDevice,
  isExpired,
  isKeyDevice,
  keyDeviceId,
  normalizeCode,
  publicKeyFrom,
  sha256Hex,
  verifyDeviceSignature,
} from './auth.js';
import { type Device, updateDevices } from './config.js';
import { events } from './events.js';
import { log } from './log.js';
import { blockedPorts, handlePreviewRequest, handlePreviewUpgrade } from './preview/proxy.js';
import { dispatch } from './rpc.js';

const WS_SUBPROTOCOL_PREFIX = 'nicode.';
const backoff = new Backoff();
const challenges = new ChallengeStore();

interface Client {
  ws: WebSocket;
  device: Device;
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

/**
 * Who is connecting:
 *  - phones:  Authorization: Signature deviceId="…", nonce="…", sig="<base64>"
 *             (nonce from GET /auth/challenge, signature over authMessage(nonce, deviceId))
 *  - browser test console: short-lived token as Bearer, or subprotocol 'nicode.<token>'
 */
function authenticate(req: IncomingMessage): Device | null {
  const auth = req.headers.authorization ?? '';
  if (auth.startsWith('Signature ')) {
    const f = Object.fromEntries([...auth.slice(10).matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));
    const { deviceId, nonce, sig } = f;
    if (!deviceId || !nonce || !sig) return null;
    const device = app.config.devices.find((d) => d.id === deviceId && isKeyDevice(d));
    // Consume the nonce whatever happens next, so a captured signature can never be replayed.
    const fresh = challenges.consume(nonce);
    if (!device || !fresh) return null;
    return verifyDeviceSignature(device, authMessage(nonce, deviceId), sig) ? device : null;
  }
  let token: string | undefined;
  if (auth.startsWith('Bearer ')) token = auth.slice(7).trim();
  else {
    const protos = req.headers['sec-websocket-protocol']?.split(',').map((s) => s.trim()) ?? [];
    token = protos.find((p) => p.startsWith(WS_SUBPROTOCOL_PREFIX))?.slice(WS_SUBPROTOCOL_PREFIX.length);
  }
  return findTokenDevice(app.config.devices, token);
}

function reject(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, limit = 16 * 1024): Promise<unknown> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error('body too large');
  }
  return JSON.parse(body);
}

const PairBody = z.object({
  code: z.string().min(4).max(64),
  deviceName: z.string().min(1).max(64),
  alg: z.enum(['RS256', 'ES256', 'Ed25519']),
  publicKey: z.string().min(16).max(8192),
});

/** POST /pair — one-time code + the phone's public key → a new key device. */
async function handlePair(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
  if (backoff.blockedFor(ip) > 0) return sendJson(res, 429, { error: 'Too many attempts; wait a minute' });
  let body: z.infer<typeof PairBody>;
  try {
    body = PairBody.parse(await readJson(req));
    publicKeyFrom(body.alg, body.publicKey); // reject unusable keys up front
  } catch (err) {
    return sendJson(res, 400, { error: err instanceof Error ? err.message.split('\n')[0] : 'bad request' });
  }
  const code = findPairingCode(app.config.pairingCodes, body.code);
  if (!code) {
    backoff.fail(ip);
    log.warn({ ip }, 'pairing rejected: bad or expired code');
    return sendJson(res, 401, { error: 'Pairing code is wrong or has expired. Run `nicode pair` again.' });
  }
  backoff.succeed(ip);
  const codeHash = sha256Hex(normalizeCode(body.code));
  let device!: Device;
  const next = await updateDevices(({ devices, pairingCodes }) => {
    const remaining = pairingCodes.filter((c) => c.sha256 !== codeHash && Date.parse(c.expiresAt) > Date.now());
    // Re-pairing the same hardware key keeps its device record.
    const existing = devices.find((d) => d.publicKey === body.publicKey);
    device = existing ?? { id: keyDeviceId(body.publicKey), name: body.deviceName, createdAt: new Date().toISOString(), alg: body.alg, publicKey: body.publicKey };
    return { devices: existing ? devices : [...devices, device], pairingCodes: remaining };
  });
  app.config.devices = next.devices;
  app.config.pairingCodes = next.pairingCodes;
  log.info({ device: device.name, ip }, 'device paired');
  const out: PairResponse = { deviceId: device.id, deviceName: device.name, hostname: os.hostname(), publicHost: app.config.publicHost || null };
  sendJson(res, 200, out);
}

export function startHttpServer(): http.Server {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024 * 1024,
    // Browsers offer ['nicode', 'nicode.<token>'] and require us to pick one they offered.
    // Pick plain 'nicode' so the token is never echoed back in a response header.
    handleProtocols: (protocols) => (protocols.has('nicode') ? 'nicode' : false),
  });

  blockedPorts.add(app.config.port);
  const server = http.createServer((req, res) => {
    if (handlePreviewRequest(req, res)) return; // p<port>.<ip>.sslip.io → the previewed app
    const route = `${req.method} ${req.url?.split('?')[0]}`;
    const ip = clientIp(req);
    if (route === 'GET /health') {
      return sendJson(res, 200, { ok: true, version: app.daemonVersion, state: app.status.read().state });
    }
    if (route === 'GET /auth/challenge') {
      if (backoff.blockedFor(ip) > 0) return sendJson(res, 429, { error: 'Too many failed logins; wait a minute' });
      return sendJson(res, 200, challenges.issue());
    }
    if (route === 'POST /pair') {
      handlePair(req, res, ip).catch((err) => {
        log.error({ err }, 'pairing failed');
        sendJson(res, 500, { error: 'pairing failed' });
      });
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  });

  server.on('upgrade', (req, socket, head) => {
    if (handlePreviewUpgrade(req, socket, head)) return;
    const ip = clientIp(req);
    if (req.url?.split('?')[0] !== '/ws') return reject(socket, 404, 'Not Found');
    if (backoff.blockedFor(ip) > 0) return reject(socket, 429, 'Too Many Requests');
    const device = authenticate(req);
    if (!device) {
      backoff.fail(ip);
      log.warn({ ip }, 'rejected websocket: bad signature or token');
      return reject(socket, 401, 'Unauthorized');
    }
    backoff.succeed(ip);
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, device, ip));
  });

  const heartbeat = setInterval(() => {
    applyDeviceChange(); // also ends sessions of browser tokens that just expired
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

function onConnection(ws: WebSocket, device: Device, ip: string): void {
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
    // Use the current device record (it may have been renamed since connecting).
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

/** After the device list changes (or time passes): drop sockets of revoked or expired devices. */
export function applyDeviceChange(): void {
  for (const [id, c] of clients) {
    const current = app.config.devices.find((d) => d.id === c.device.id);
    if (!current || isExpired(current)) {
      c.ws.close(4401, current ? 'access expired' : 'device revoked');
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
