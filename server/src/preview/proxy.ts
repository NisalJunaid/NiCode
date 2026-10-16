/**
 * The preview gate: requests whose Host is a preview host (p<port>.<ip>.sslip.io) are checked
 * for the preview cookie and proxied to 127.0.0.1:<port>, including websocket upgrades (HMR).
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { app } from '../app.js';
import { isExpired } from '../auth.js';
import { log } from '../log.js';
import { COOKIE, COOKIE_TTL_MS, cookieValid, issueCookie, previewPortOf, readCookie, redeemOpenToken, stripCookie } from './auth.js';

/** Previews stay open only while the device that opened them is still paired (and unexpired). */
function deviceAllowed(deviceId: string): boolean {
  const d = app.config.devices.find((x) => x.id === deviceId);
  return !!d && !isExpired(d);
}

/** Last time each previewed port was used (dev servers stop after a long idle). */
export const lastPreviewUse = new Map<number, number>();
/** Ports that must never be previewed (the daemon itself). */
export const blockedPorts = new Set<number>();

const HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer'];

function upstreamHeaders(req: IncomingMessage, port: number): http.OutgoingHttpHeaders {
  const h: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP.includes(k)) h[k] = v;
  const cookie = stripCookie(req.headers.cookie, COOKIE);
  if (cookie) h.cookie = cookie;
  else delete h.cookie;
  // Dev servers (Vite, Next) only trust localhost Host headers; the real host goes in X-Forwarded-Host.
  h['x-forwarded-host'] = req.headers.host ?? '';
  h['x-forwarded-proto'] = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'http';
  h.host = `localhost:${port}`;
  return h;
}

function deny(res: ServerResponse, status: number, title: string, body: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
      `<body style="font-family:system-ui;background:#0E1015;color:#E8EAF0;display:grid;place-items:center;min-height:90vh;margin:0;padding:24px;text-align:center">` +
      `<div><h2>${title}</h2><p style="color:#9AA3B5">${body}</p></div>`,
  );
}

/** Handles the request if it is for a preview host. Returns false otherwise. */
export function handlePreviewRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const port = previewPortOf(req.headers.host);
  if (port === null) return false;
  const url = new URL(req.url ?? '/', 'http://x');
  const secure = req.headers['x-forwarded-proto'] === 'https';

  if (url.pathname === '/__nicode/auth') {
    const deviceId = redeemOpenToken(url.searchParams.get('t') ?? '', port);
    if (!deviceId || !deviceAllowed(deviceId)) {
      deny(res, 401, 'Link expired', 'Open the preview again from the niCode app.');
      return true;
    }
    const cookie = `${COOKIE}=${issueCookie(port, deviceId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_TTL_MS / 1000}${secure ? '; Secure' : ''}`;
    const to = url.searchParams.get('to') ?? '/';
    res.writeHead(302, { location: to.startsWith('/') && !to.startsWith('//') ? to : '/', 'set-cookie': cookie, 'cache-control': 'no-store' });
    res.end();
    return true;
  }
  if (!cookieValid(readCookie(req.headers.cookie, COOKIE), port, deviceAllowed)) {
    deny(res, 401, 'Preview locked', 'Open this preview from the niCode app to sign in.');
    return true;
  }
  if (blockedPorts.has(port)) {
    deny(res, 403, 'Not allowed', 'This port can\'t be previewed.');
    return true;
  }
  lastPreviewUse.set(port, Date.now());

  const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: upstreamHeaders(req, port) }, (r) => {
    const headers = { ...r.headers };
    for (const k of HOP) delete headers[k];
    // Absolute redirects to localhost would leave the preview; keep them on the preview host.
    if (typeof headers.location === 'string') headers.location = headers.location.replace(/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i, '');
    res.writeHead(r.statusCode ?? 502, headers);
    r.pipe(res);
  });
  up.on('error', () => {
    if (!res.headersSent) deny(res, 502, `Nothing on port ${port}`, 'The app or dev server isn\'t running (yet). Start it in niCode and reload.');
    else res.destroy();
  });
  req.pipe(up);
  return true;
}

/** Websocket upgrades for preview hosts (dev-server hot reload). Returns false if not a preview host. */
export function handlePreviewUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const port = previewPortOf(req.headers.host);
  if (port === null) return false;
  if (!cookieValid(readCookie(req.headers.cookie, COOKIE), port, deviceAllowed) || blockedPorts.has(port)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return true;
  }
  lastPreviewUse.set(port, Date.now());
  const up = net.connect({ host: '127.0.0.1', port }, () => {
    const h = upstreamHeaders(req, port);
    h.connection = 'Upgrade';
    h.upgrade = req.headers.upgrade ?? 'websocket';
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [k, v] of Object.entries(h)) for (const one of Array.isArray(v) ? v : [v]) if (one !== undefined) lines.push(`${k}: ${String(one)}`);
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  const close = () => {
    up.destroy();
    socket.destroy();
  };
  up.on('error', (err) => {
    log.debug({ err, port }, 'preview upgrade failed');
    close();
  });
  socket.on('error', close);
  return true;
}
