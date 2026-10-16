import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectSite } from '../src/sites/detect.js';
import { isValidDomain, normalizeDomain, parseSite, phpVersionFromSocket, renderSite, sortVersionsDesc } from '../src/sites/nginx.js';

describe('nginx site configs', () => {
  it('renders each kind and reads it back', () => {
    for (const kind of ['static', 'spa', 'php', 'proxy'] as const) {
      const text = renderSite({ domains: ['shop.example.com', 'www.shop.example.com'], kind, root: '/var/www/shop/public', port: 4000, phpSocket: '/run/php/php8.2-fpm.sock' });
      const p = parseSite(text);
      expect(p.managed).toBe(true);
      expect(p.kind).toBe(kind);
      expect(p.domains).toEqual(['shop.example.com', 'www.shop.example.com']);
      expect(p.https).toBe(false);
      if (kind === 'proxy') expect(p.proxyPort).toBe(4000);
      else expect(p.root).toBe('/var/www/shop/public');
    }
    expect(renderSite({ domains: ['a.dev'], kind: 'php', root: '/x', phpSocket: '/run/php/php8.1-fpm.sock' })).toContain('fastcgi_pass unix:/run/php/php8.1-fpm.sock;');
    expect(renderSite({ domains: ['a.dev'], kind: 'spa', root: '/x' })).toContain('try_files $uri $uri/ /index.html;');
  });

  it('understands hand-written and certbot-modified sites', () => {
    const text = `server {
    server_name blog.example.com www.blog.example.com; # main
    root /var/www/blog/public;
    location ~ \.php$ { fastcgi_pass unix:/run/php/php8.2-fpm.sock; }
    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/blog.example.com/fullchain.pem; # managed by Certbot
}
server {
    if ($host = blog.example.com) { return 301 https://$host$request_uri; }
    listen 80; server_name blog.example.com; return 404;
}`;
    const p = parseSite(text);
    expect(p).toMatchObject({ managed: false, kind: 'php', root: '/var/www/blog/public', https: true, sslCertificate: '/etc/letsencrypt/live/blog.example.com/fullchain.pem' });
    expect(p.domains).toEqual(['blog.example.com', 'www.blog.example.com']);
    expect(parseSite('server { listen 80 default_server; server_name _; root /var/www/html; }').domains).toEqual([]);
  });

  it('recognises sites owned by a hosting panel', () => {
    const site = parseSite('# managed-by: hostpanel site=acme-shop\nserver { server_name acme.com; root /srv/sites/acme-shop/public; }');
    expect(site).toMatchObject({ managed: false, panel: { site: 'acme-shop' }, domains: ['acme.com'] });
    expect(parseSite('# managed-by: hostpanel (panel itself — protected)\nserver { server_name panel.example.com; }').panel).toEqual({ site: null });
    expect(parseSite(renderSite({ domains: ['a.dev'], kind: 'static', root: '/x' })).panel).toBeNull();
    // Only a marker line counts, not a mention inside another comment.
    expect(parseSite('server { server_name a.dev; } # see managed-by: hostpanel docs').panel).toBeNull();
  });

  it('validates domains and php versions', () => {
    expect(normalizeDomain(' https://Shop.Example.com/path ')).toBe('shop.example.com');
    expect(isValidDomain('shop.example.com')).toBe(true);
    expect(isValidDomain('localhost')).toBe(false);
    expect(isValidDomain('bad_domain.com')).toBe(false);
    expect(isValidDomain('a.b; rm -rf /')).toBe(false);
    expect(phpVersionFromSocket('php8.2-fpm.sock')).toBe('8.2');
    expect(phpVersionFromSocket('php-fpm.sock')).toBeNull();
    expect(sortVersionsDesc(['7.4', '8.3', '8.10', '8.1'])).toEqual(['8.10', '8.3', '8.1', '7.4']);
  });
});

describe('project detection', () => {
  const make = async (files: Record<string, string>) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'nicode-detect-'));
    for (const [f, c] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, f)), { recursive: true });
      await writeFile(path.join(dir, f), c);
    }
    return dir;
  };
  it('recognises common stacks', async () => {
    expect(detectSite(await make({ artisan: '', 'public/index.php': '' }), ['8.2'])).toMatchObject({ kind: 'php', webRoot: 'public' });
    expect(detectSite(await make({ 'package.json': JSON.stringify({ dependencies: { next: '15' } }), '.env': 'PORT=4100\n' }), [])).toMatchObject({ kind: 'proxy', port: 4100 });
    expect(detectSite(await make({ 'package.json': JSON.stringify({ devDependencies: { vite: '6' }, dependencies: { react: '19' } }) }), [])).toMatchObject({ kind: 'spa', webRoot: 'dist' });
    expect(detectSite(await make({ 'package.json': JSON.stringify({ dependencies: { express: '5' } }) }), [])).toMatchObject({ kind: 'proxy', port: 3000 });
    expect(detectSite(await make({ 'index.html': '<h1>hi</h1>' }), [])).toMatchObject({ kind: 'static', webRoot: '' });
  });
});

describe('sites API over the daemon', () => {
  it('lists sites with project links and refuses to touch niCode\'s own site', async () => {
    const { Client, startDaemon, TOKEN } = await import('./helpers.js');
    const nginx = await mkdtemp(path.join(os.tmpdir(), 'nicode-nginx-'));
    await mkdir(path.join(nginx, 'sites-available'));
    await mkdir(path.join(nginx, 'sites-enabled'));
    const d = await startDaemon({ env: { NICODE_TEST_SITES_SUPPORTED: '1', NICODE_NGINX_DIR: nginx } });
    try {
      const root = d.demo.split(path.sep).join('/');
      await writeFile(path.join(nginx, 'sites-available', 'demo.test.conf'), renderSite({ domains: ['demo.test'], kind: 'static', root }));
      await writeFile(path.join(nginx, 'sites-available', 'nicode.conf'), 'server { server_name localhost; location / { proxy_pass http://127.0.0.1:7878; } }');
      await writeFile(path.join(nginx, 'sites-enabled', 'demo.test.conf'), '');
      await writeFile(path.join(nginx, 'sites-available', 'shop.test.conf'), `# managed-by: hostpanel site=shop\nserver { server_name shop.test; root ${root}/public; }`);
      const c = await Client.connect(d.port, TOKEN);
      expect((await c.call('sites.status')).result).toMatchObject({ supported: true, webServer: 'nginx' });
      const list = (await c.call('sites.list')).result;
      const demo = list.find((s: any) => s.name === 'demo.test.conf');
      expect(demo).toMatchObject({ enabled: true, managed: true, kind: 'static', domains: ['demo.test'], https: false });
      expect(list.find((s: any) => s.name === 'nicode.conf')).toMatchObject({ protected: true, kind: 'proxy', proxyPort: 7878 });
      expect((await c.call('sites.setEnabled', { name: 'nicode.conf', enabled: false })).error.code).toBe('forbidden');
      expect(demo).toMatchObject({ managedBy: 'nicode', panelSite: null });
      expect(list.find((s: any) => s.name === 'shop.test.conf')).toMatchObject({ protected: true, managed: false, managedBy: 'panel', panelSite: 'shop' });
      expect((await c.call('sites.setEnabled', { name: 'shop.test.conf', enabled: true })).error.code).toBe('forbidden');
      expect((await c.call('sites.remove', { name: 'shop.test.conf' })).error.code).toBe('forbidden');
      expect((await c.call('sites.config', { name: '../../etc/passwd' })).error.code).toBe('bad_request');
      expect((await c.call('sites.detect', { projectPath: d.demo })).result.kind).toBe('static');
      expect((await c.call('sites.create', { domain: 'not a domain', includeWww: false, project: { path: d.demo }, kind: 'static', webRoot: '', https: false })).error.code).toBe('bad_request');
      c.close();
    } finally {
      d.stop();
    }
  }, 30_000);
});
