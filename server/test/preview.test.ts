/**
 * Live preview: sign-in tokens and cookies, the preview gate/proxy (http + websocket) through a
 * real daemon, and the dev-server lifecycle. nginx/certbot are skipped (NICODE_TEST_PREVIEW_NO_NGINX).
 */
import http from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { devCommand } from '../src/apps/catalog.js';
import { cookieValid, initPreviewKey, issueCookie, issueOpenToken, previewHost, previewPortOf, readCookie, redeemOpenToken, stripCookie } from '../src/preview/auth.js';
import { Client, startDaemon, type TestDaemon, TOKEN } from './helpers.js';

describe('preview sign-in', () => {
  beforeAll(async () => initPreviewKey(await mkdtemp(path.join(os.tmpdir(), 'nicode-pk-'))));

  it('one-time links are single use, port-bound and expire', () => {
    const t = issueOpenToken(3000, 'd_phone');
    expect(redeemOpenToken(t, 3001)).toBeNull();
    expect(redeemOpenToken(t, 3000)).toBe('d_phone');
    expect(redeemOpenToken(t, 3000)).toBeNull(); // reused
    expect(redeemOpenToken(issueOpenToken(3000, 'd_phone', Date.now() - 10 * 60_000), 3000)).toBeNull(); // expired
    expect(redeemOpenToken(t.slice(0, -2) + 'xx', 3000)).toBeNull(); // tampered
  });

  it('cookies only open their own preview host, and only while their device is paired', () => {
    const paired = (id: string) => id === 'd_phone';
    const c = issueCookie(4000, 'd_phone');
    expect(cookieValid(c, 4000, paired)).toBe(true);
    expect(cookieValid(c, 4001, paired)).toBe(false);
    expect(cookieValid(c, 4000, () => false)).toBe(false); // the phone was revoked
    expect(cookieValid(issueCookie(4000, 'd_lost'), 4000, paired)).toBe(false);
    expect(cookieValid(issueCookie(4000, 'd_phone', Date.now() - 13 * 3600_000), 4000, paired)).toBe(false);
    expect(cookieValid(undefined, 4000, paired)).toBe(false);
  });

  it('parses preview hosts and cookies', () => {
    expect(previewHost(5173, '203.0.113.7')).toBe('p5173.203-0-113-7.sslip.io');
    expect(previewPortOf('p5173.203-0-113-7.sslip.io')).toBe(5173);
    expect(previewPortOf('P5173.203-0-113-7.sslip.io:443')).toBe(5173);
    expect(previewPortOf('203-0-113-7.sslip.io')).toBeNull();
    expect(previewPortOf('p80.203-0-113-7.sslip.io')).toBeNull();
    expect(previewPortOf('p5173.evil.com')).toBeNull();
    expect(readCookie('a=1; nicode_preview=xyz; b=2', 'nicode_preview')).toBe('xyz');
    expect(stripCookie('a=1; nicode_preview=xyz; b=2', 'nicode_preview')).toBe('a=1; b=2');
    expect(stripCookie('nicode_preview=xyz', 'nicode_preview')).toBeUndefined();
  });
});

describe('dev server commands', () => {
  const project = async (files: Record<string, string>) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'nicode-dev-'));
    for (const [f, c] of Object.entries(files)) await writeFile(path.join(dir, f), c);
    return dir;
  };
  it('adds the framework port/host flags', async () => {
    const vite = await project({ 'package.json': JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^6' } }) });
    expect(devCommand(vite, 5170)).toMatchObject({ file: 'npm', args: ['run', 'dev', '--', '--port', '5170', '--host', '127.0.0.1', '--strictPort'], framework: 'Vite' });
    const next = await project({ 'package.json': JSON.stringify({ scripts: { dev: 'next dev' }, dependencies: { next: '15' } }), 'pnpm-lock.yaml': '' });
    expect(devCommand(next, 5171)).toMatchObject({ file: 'pnpm', args: ['run', 'dev', '-p', '5171', '-H', '127.0.0.1'], framework: 'Next.js' });
    const laravel = await project({ artisan: '', 'package.json': JSON.stringify({ scripts: { dev: 'vite' } }) });
    expect(devCommand(laravel, 5172)).toMatchObject({ file: 'php', args: ['artisan', 'serve', '--host=127.0.0.1', '--port=5172'] });
    expect(devCommand(await project({ 'readme.md': 'x' }), 5173)).toBeNull();
    const odd = await project({ 'package.json': JSON.stringify({ scripts: { 'dev;rm -rf': 'x' } }) });
    expect(devCommand(odd, 5174)).toBeNull();
  });
});

describe('preview gate through the daemon', () => {
  let d: TestDaemon;
  let c: Client;
  let upstream: http.Server;
  let upPort = 0;
  let seen: http.IncomingHttpHeaders = {};

  beforeAll(async () => {
    d = await startDaemon({ env: { NICODE_TEST_PREVIEW_NO_NGINX: '1' } });
    c = await Client.connect(d.port, TOKEN);
    upstream = http.createServer((req, res) => {
      seen = req.headers;
      if (req.url === '/redirect') {
        res.writeHead(302, { location: `http://localhost:${upPort}/next` });
        return res.end();
      }
      res.end(`hello from ${req.url}`);
    });
    const wss = new WebSocketServer({ server: upstream });
    wss.on('connection', (ws) => ws.on('message', (m) => ws.send(`echo ${m}`)));
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    upPort = (upstream.address() as AddressInfo).port;
  }, 30_000);

  afterAll(() => {
    c?.close();
    d?.stop();
    upstream?.close();
  });

  const host = () => `p${upPort}.127-0-0-1.sslip.io`;
  const get = (p: string, cookie?: string) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: d.port, path: p, headers: { host: host(), ...(cookie ? { cookie } : {}) } }, (res) => {
          let body = '';
          res.on('data', (x) => (body += x));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        })
        .on('error', reject);
    });

  it('refuses ports that are closed or niCode itself', async () => {
    expect((await c.call('preview.open', { port: d.port })).error?.code).toBe('forbidden');
    expect((await c.call('preview.open', { port: 1999 })).error?.code).toBe('bad_request');
  });

  it('signs in with the one-time link and proxies to the app', async () => {
    const link = (await c.call('preview.open', { port: upPort })).result;
    expect(link).toMatchObject({ host: host(), port: upPort, https: false });
    const authPath = new URL(link.url).pathname + new URL(link.url).search;

    expect((await get('/')).status).toBe(401); // no cookie
    const auth = await get(authPath);
    expect(auth.status).toBe(302);
    const cookie = String(auth.headers['set-cookie']).split(';')[0]!;
    expect(cookie).toMatch(/^nicode_preview=/);
    expect((await get(authPath)).status).toBe(401); // link already used

    const page = await get('/some/page?x=1', `${cookie}; theme=dark`);
    expect(page.body).toBe('hello from /some/page?x=1');
    expect(seen.host).toBe(`localhost:${upPort}`);
    expect(seen['x-forwarded-host']).toBe(host());
    expect(seen.cookie).toBe('theme=dark'); // our cookie never reaches the app
    expect((await get('/redirect', cookie)).headers.location).toBe('/next');

    const ws = new WebSocket(`ws://127.0.0.1:${d.port}/hmr`, { headers: { host: host(), cookie } });
    const reply = await new Promise<string>((resolve, reject) => {
      ws.on('open', () => ws.send('ping'));
      ws.on('message', (m) => resolve(String(m)));
      ws.on('error', reject);
    });
    expect(reply).toBe('echo ping');
    ws.close();

    const anon = new WebSocket(`ws://127.0.0.1:${d.port}/hmr`, { headers: { host: host() } });
    await expect(new Promise((resolve, reject) => (anon.on('open', resolve), anon.on('error', reject)))).rejects.toThrow();
  });

  it('runs a dev server, reports it, and stops it', async () => {
    const proj = path.join(d.projectsRoot, 'devapp');
    await mkdir(proj, { recursive: true });
    await writeFile(path.join(proj, 'package.json'), JSON.stringify({ name: 'devapp', scripts: { dev: 'node server.js' } }));
    await writeFile(
      path.join(proj, 'server.js'),
      "require('http').createServer((q, s) => s.end('dev ok')).listen(Number(process.env.PORT), '127.0.0.1', () => console.log('ready on ' + process.env.PORT));",
    );
    const opts = (await c.call('preview.devOptions', { projectPath: proj })).result;
    expect(opts).toMatchObject({ available: true });
    const dev = (await c.call('preview.devStart', { projectPath: proj, opId: 'dev1' }, 60_000)).result;
    expect(dev).toMatchObject({ state: 'running', opId: 'dev1' });
    expect(dev.port).toBeGreaterThanOrEqual(5170);
    const st = (await c.call('preview.devStatus', { projectPath: proj })).result;
    expect(st.dev.state).toBe('running');
    expect(st.output).toContain('ready on');
    expect((await c.call('preview.devStart', { projectPath: proj })).result.port).toBe(dev.port); // already running
    await c.call('preview.devStop', { projectPath: proj });
    expect((await c.call('preview.devStatus', { projectPath: proj })).result.dev).toBeNull();
  }, 90_000);
});
