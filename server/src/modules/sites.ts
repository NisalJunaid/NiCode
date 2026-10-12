/**
 * Websites & domains on the server's nginx: list sites, enable/disable, and one-click
 * domain setup (folder → config → enable → nginx -t → reload → certbot).
 *
 * Every change is validated with `nginx -t` before nginx reloads; a failed change is rolled
 * back. niCode only removes sites it created and never touches its own site.
 */
import { X509Certificate } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { Site, SiteStep, SitesStatus } from '../../../protocol/types.js';
import { app } from '../app.js';
import { events } from '../events.js';
import { log } from '../log.js';
import { resolveInProject } from '../paths.js';
import { register, RpcError } from '../rpc.js';
import { detectSite } from '../sites/detect.js';
import { isValidDomain, normalizeDomain, parseSite, phpVersionFromSocket, renderSite, siteFileName, sortVersionsDesc } from '../sites/nginx.js';
import { run, type RunResult } from '../util/exec.js';
import { projectOf } from './projects.js';

const NGINX = process.env.NICODE_NGINX_DIR ?? '/etc/nginx';
const AVAILABLE = path.join(NGINX, 'sites-available');
const ENABLED = path.join(NGINX, 'sites-enabled');
const PHP_RUN = process.env.NICODE_PHP_RUN_DIR ?? '/run/php';
const FOLDER_RE = /^[A-Za-z0-9._-]{1,100}$/;

// ── privileged helpers (daemon may run as root, or as a user with passwordless sudo) ──

function priv(file: string, args: string[], timeoutMs = 60_000): Promise<RunResult> {
  if (app.isRoot) return run(file, args, { timeoutMs });
  return run('sudo', ['-n', file, ...args], { timeoutMs });
}

async function writeRootFile(dest: string, content: string): Promise<void> {
  if (app.isRoot) {
    await writeFile(dest, content, { mode: 0o644 });
    return;
  }
  const tmp = path.join(os.tmpdir(), `nicode-${process.pid}-${Date.now()}.conf`);
  await writeFile(tmp, content, { mode: 0o644 });
  const r = await run('sudo', ['-n', 'install', '-m', '644', tmp, dest]);
  if (r.code !== 0) throw new RpcError('forbidden', `Can't write ${dest}: ${r.stderr.trim()}`);
}

async function nginxTest(): Promise<{ ok: boolean; output: string }> {
  const r = await priv('nginx', ['-t']);
  return { ok: r.code === 0, output: (r.stderr || r.stdout).trim() };
}

async function nginxReload(): Promise<void> {
  const r = await priv('systemctl', ['reload', 'nginx']);
  if (r.code !== 0) {
    const r2 = await priv('nginx', ['-s', 'reload']);
    if (r2.code !== 0) throw new RpcError('internal', `nginx reload failed: ${(r2.stderr || r.stderr).trim()}`);
  }
}

// ── status / discovery ───────────────────────────────────────────────────────

let ipCache: { at: number; ip: string | null } = { at: 0, ip: null };
async function serverIp(): Promise<string | null> {
  const sslip = /^(\d+)-(\d+)-(\d+)-(\d+)\.sslip\.io$/.exec(app.config.publicHost);
  if (sslip) return sslip.slice(1).join('.');
  if (Date.now() - ipCache.at < 3600_000) return ipCache.ip;
  let ip: string | null = null;
  for (const url of ['http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address', 'https://api.ipify.org']) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      const t = (await res.text()).trim();
      if (res.ok && /^\d+\.\d+\.\d+\.\d+$/.test(t)) {
        ip = t;
        break;
      }
    } catch {
      // try next
    }
  }
  ipCache = { at: Date.now(), ip };
  return ip;
}

async function phpVersions(): Promise<string[]> {
  const names = await readdir(PHP_RUN).catch(() => [] as string[]);
  return sortVersionsDesc(names.map(phpVersionFromSocket).filter((v): v is string => !!v));
}

async function status(): Promise<SitesStatus> {
  const [ip, php, nginxV, certbotV] = await Promise.all([
    serverIp(),
    phpVersions(),
    run('nginx', ['-v'], { timeoutMs: 5000 }).catch(() => null),
    run('certbot', ['--version'], { timeoutMs: 10_000 }).catch(() => null),
  ]);
  const hasNginx = nginxV?.code === 0 && existsSync(AVAILABLE);
  const base = { serverIp: ip, certbot: certbotV?.code === 0, phpVersions: php };
  // Tests/UI previews on machines without nginx: NICODE_TEST_SITES_SUPPORTED=1 (+ NICODE_NGINX_DIR).
  if (process.env.NICODE_TEST_SITES_SUPPORTED === '1') return { ...base, supported: true, webServer: 'nginx' };
  if (!hasNginx) {
    const caddy = await run('caddy', ['version'], { timeoutMs: 5000 }).catch(() => null);
    return {
      ...base,
      supported: false,
      webServer: caddy?.code === 0 ? 'caddy' : 'none',
      reason: caddy?.code === 0 ? 'This server uses Caddy. Domain management currently supports nginx.' : 'nginx is not installed on this server.',
    };
  }
  if (!app.isRoot) {
    const sudo = await run('sudo', ['-n', 'true'], { timeoutMs: 5000 }).catch(() => null);
    if (sudo?.code !== 0) return { ...base, supported: false, webServer: 'nginx', reason: 'niCode needs root or passwordless sudo to change nginx.' };
  }
  return { ...base, supported: true, webServer: 'nginx' };
}

async function certExpiry(certPath: string | null): Promise<string | null> {
  if (!certPath) return null;
  try {
    return new Date(new X509Certificate(await readFile(certPath)).validTo).toISOString();
  } catch {
    return null; // not readable without root, or not a file
  }
}

async function projectFor(root: string | null): Promise<string | null> {
  if (!root) return null;
  const projectsRoot = app.config.projectsRoot.replace(/\/+$/, '');
  if (!root.startsWith(projectsRoot + '/')) return null;
  const name = root.slice(projectsRoot.length + 1).split('/')[0];
  return name ? path.posix.join(projectsRoot, name) : null;
}

function isProtected(name: string, domains: string[]): boolean {
  return name === 'nicode.conf' || name === 'default' || domains.includes(app.config.publicHost);
}

async function readSite(name: string, enabledNames: Set<string>): Promise<Site | null> {
  const file = path.join(AVAILABLE, name);
  const st = await stat(file).catch(() => null);
  if (!st?.isFile()) return null;
  const parsed = parseSite(await readFile(file, 'utf8').catch(() => ''));
  return {
    name,
    enabled: enabledNames.has(name),
    managed: parsed.managed,
    protected: isProtected(name, parsed.domains),
    domains: parsed.domains,
    kind: parsed.kind,
    root: parsed.root,
    proxyPort: parsed.proxyPort,
    projectPath: await projectFor(parsed.root),
    https: parsed.https,
    certExpiresAt: await certExpiry(parsed.sslCertificate),
  };
}

async function enabledSet(): Promise<Set<string>> {
  return new Set(await readdir(ENABLED).catch(() => [] as string[]));
}

async function listSites(): Promise<Site[]> {
  const names = await readdir(AVAILABLE).catch(() => [] as string[]);
  const enabled = await enabledSet();
  const sites = (await Promise.all(names.map((n) => readSite(n, enabled)))).filter((s): s is Site => !!s);
  return sites.sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.domains[0] ?? a.name).localeCompare(b.domains[0] ?? b.name));
}

async function getSite(name: string): Promise<Site> {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new RpcError('bad_request', 'Invalid site name');
  const s = await readSite(name, await enabledSet());
  if (!s) throw new RpcError('not_found', `No site ${name}`);
  return s;
}

// ── actions ──────────────────────────────────────────────────────────────────

const currentStep = new Map<string, SiteStep>();

function progress(opId: string | undefined, step: SiteStep, s: 'running' | 'done' | 'failed' | 'skipped', detail?: string): void {
  if (!opId) return;
  if (s === 'running') currentStep.set(opId, step);
  else if (currentStep.get(opId) === step) currentStep.delete(opId);
  events.emit('sites.progress', { opId, step, status: s, ...(detail ? { detail } : {}) });
}

/** Runs an operation; if it throws, the step that was running is reported as failed. */
async function withSteps<T>(opId: string | undefined, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const step = opId ? currentStep.get(opId) : undefined;
    if (opId && step) progress(opId, step, 'failed', err instanceof Error ? err.message.split('\n')[0] : 'Failed');
    throw err;
  } finally {
    if (opId) currentStep.delete(opId);
  }
}

async function runCertbot(domains: string[], email: string | undefined, opId: string | undefined, logLines: string[]): Promise<boolean> {
  progress(opId, 'certbot', 'running', 'Getting a free certificate from Let\'s Encrypt…');
  if ((await run('certbot', ['--version'], { timeoutMs: 10_000 }).catch(() => null))?.code !== 0) {
    logLines.push('Installing certbot…');
    const inst = await priv('apt-get', ['-y', '-o', 'DPkg::Lock::Timeout=300', 'install', 'certbot', 'python3-certbot-nginx'], 600_000);
    if (inst.code !== 0) {
      progress(opId, 'certbot', 'failed', 'Could not install certbot');
      logLines.push(inst.stderr.trim().split('\n').slice(-3).join('\n'));
      return false;
    }
  }
  const args = ['--nginx', '--non-interactive', '--agree-tos', '--redirect', ...(email ? ['-m', email] : ['--register-unsafely-without-email'])];
  for (const d of domains) args.push('-d', d);
  const r = await priv('certbot', args, 300_000);
  const out = (r.stdout + '\n' + r.stderr).trim();
  logLines.push(out.split('\n').slice(-6).join('\n'));
  if (r.code !== 0) {
    const hint = /DNS problem|NXDOMAIN|unauthorized|Timeout during connect/i.test(out)
      ? 'The domain doesn\'t point to this server yet (or port 80 is blocked). The site works on http; try HTTPS again once DNS has updated.'
      : 'certbot failed; the site still works on http.';
    progress(opId, 'certbot', 'failed', hint);
    return false;
  }
  progress(opId, 'certbot', 'done', 'HTTPS enabled; http redirects to https');
  return true;
}

const CreateSchema = z.object({
  domain: z.string().min(3).max(253),
  includeWww: z.boolean(),
  project: z.union([z.object({ path: z.string() }), z.object({ newFolder: z.string().regex(FOLDER_RE) })]),
  kind: z.enum(['static', 'spa', 'php', 'proxy']),
  webRoot: z.string().max(200),
  port: z.number().int().min(1).max(65535).optional(),
  phpVersion: z.string().regex(/^\d+\.\d+$/).optional(),
  https: z.boolean(),
  email: z.string().email().optional(),
  opId: z.string().max(64).optional(),
});

async function createSite(p: z.infer<typeof CreateSchema>): Promise<{ site: Site; log: string[] }> {
  const logLines: string[] = [];
  const st = await status();
  if (!st.supported) throw new RpcError('forbidden', st.reason ?? 'Domains are not supported on this server');
  const domain = normalizeDomain(p.domain);
  if (!isValidDomain(domain)) throw new RpcError('bad_request', `"${p.domain}" isn't a valid domain`);
  const domains = p.includeWww && !domain.startsWith('www.') ? [domain, `www.${domain}`] : [domain];
  const name = siteFileName(domain);
  const existing = await listSites();
  if (existing.some((s) => s.name === name)) throw new RpcError('conflict', `A site for ${domain} already exists`);
  const clash = existing.find((s) => s.domains.some((d) => domains.includes(d)));
  if (clash) throw new RpcError('conflict', `${clash.domains.find((d) => domains.includes(d))} is already used by ${clash.name}`);

  // 1. Folder
  progress(p.opId, 'folder', 'running');
  let projectPath: string;
  if ('newFolder' in p.project) {
    projectPath = path.join(app.config.projectsRoot, p.project.newFolder);
    if (existsSync(projectPath)) throw new RpcError('conflict', `${p.project.newFolder} already exists in ${app.config.projectsRoot}`);
    await mkdir(projectPath, { recursive: true });
    logLines.push(`Created ${projectPath}`);
  } else {
    projectPath = await projectOf(p.project.path);
  }
  const root = p.kind === 'proxy' ? projectPath : await resolveInProject(projectPath, p.webRoot || '.');
  if (p.kind !== 'proxy' && !existsSync(root)) {
    await mkdir(root, { recursive: true });
    logLines.push(`Created ${root}`);
  }
  if ((p.kind === 'static' || p.kind === 'spa') && !existsSync(path.join(root, 'index.html'))) {
    await writeFile(
      path.join(root, 'index.html'),
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${domain}</title></head>` +
        `<body style="font-family:system-ui;display:grid;place-items:center;min-height:90vh"><div><h1>${domain}</h1><p>Set up with niCode. Ask Claude to build the site!</p></div></body></html>\n`,
    );
    logLines.push('Added a placeholder index.html');
  }
  progress(p.opId, 'folder', 'done', projectPath);

  // 2. Config
  progress(p.opId, 'config', 'running');
  const phpVersion = p.phpVersion ?? st.phpVersions[0];
  if (p.kind === 'php' && !phpVersion) throw new RpcError('bad_request', 'No php-fpm found on this server (looked in /run/php)');
  const conf = renderSite({
    domains,
    kind: p.kind,
    root,
    port: p.port,
    ...(phpVersion ? { phpSocket: path.posix.join(PHP_RUN, `php${phpVersion}-fpm.sock`) } : {}),
  });
  const file = path.join(AVAILABLE, name);
  await writeRootFile(file, conf);
  progress(p.opId, 'config', 'done', file);

  // 3–5. Enable, test, reload (roll back on a failed test)
  progress(p.opId, 'enable', 'running');
  await priv('ln', ['-sf', file, path.join(ENABLED, name)]);
  progress(p.opId, 'enable', 'done');
  progress(p.opId, 'test', 'running');
  const t = await nginxTest();
  if (!t.ok) {
    await priv('rm', ['-f', path.join(ENABLED, name), file]);
    progress(p.opId, 'test', 'failed', 'nginx rejected the config; nothing was changed');
    throw new RpcError('bad_request', 'nginx rejected the new site, so it was removed again', { output: t.output });
  }
  progress(p.opId, 'test', 'done');
  progress(p.opId, 'reload', 'running');
  await nginxReload();
  progress(p.opId, 'reload', 'done', `http://${domain} is live`);

  // 6. HTTPS
  if (p.https) await runCertbot(domains, p.email, p.opId, logLines);
  else progress(p.opId, 'certbot', 'skipped');

  log.info({ domain, kind: p.kind, root }, 'site created');
  return { site: await getSite(name), log: logLines };
}

async function setEnabled(name: string, enabled: boolean): Promise<Site> {
  const site = await getSite(name);
  if (site.protected) throw new RpcError('forbidden', 'This site is managed by the server setup and can\'t be changed here');
  if (site.enabled === enabled) return site;
  const link = path.join(ENABLED, name);
  await (enabled ? priv('ln', ['-sf', path.join(AVAILABLE, name), link]) : priv('rm', ['-f', link]));
  const t = await nginxTest();
  if (!t.ok) {
    await (enabled ? priv('rm', ['-f', link]) : priv('ln', ['-sf', path.join(AVAILABLE, name), link]));
    throw new RpcError('bad_request', `nginx rejected that change, so it was undone`, { output: t.output });
  }
  await nginxReload();
  return getSite(name);
}

export function registerSitesModule(): void {
  register('sites.status', z.object({}).passthrough(), status);
  register('sites.list', z.object({}).passthrough(), listSites);

  register('sites.config', z.object({ name: z.string() }), async ({ name }) => {
    await getSite(name);
    return { text: await readFile(path.join(AVAILABLE, name), 'utf8') };
  });

  register('sites.checkDns', z.object({ domain: z.string().min(3).max(253) }), async ({ domain }) => {
    const d = normalizeDomain(domain);
    if (!isValidDomain(d)) throw new RpcError('bad_request', `"${domain}" isn't a valid domain`);
    const [addresses, ip] = await Promise.all([dns.resolve4(d).catch(() => [] as string[]), serverIp()]);
    return { domain: d, addresses, serverIp: ip, pointsHere: !!ip && addresses.includes(ip) };
  });

  register('sites.detect', z.object({ projectPath: z.string() }), async ({ projectPath }) => detectSite(await projectOf(projectPath), await phpVersions()));

  register('sites.create', CreateSchema, (p) => withSteps(p.opId, () => createSite(p)));

  register('sites.setEnabled', z.object({ name: z.string(), enabled: z.boolean() }), ({ name, enabled }) => setEnabled(name, enabled));

  register('sites.enableHttps', z.object({ name: z.string(), email: z.string().email().optional(), opId: z.string().max(64).optional() }), async ({ name, email, opId }) => {
    const site = await getSite(name);
    if (site.protected) throw new RpcError('forbidden', 'This site is managed by the server setup');
    if (!site.enabled) throw new RpcError('bad_request', 'Enable the site first');
    const logLines: string[] = [];
    await runCertbot(site.domains, email, opId, logLines);
    return { site: await getSite(name), log: logLines };
  });

  register('sites.remove', z.object({ name: z.string(), deleteFolder: z.literal(false).optional() }), async ({ name }) => {
    const site = await getSite(name);
    if (site.protected) throw new RpcError('forbidden', 'This site is managed by the server setup');
    if (!site.managed) throw new RpcError('forbidden', 'Only sites created by niCode can be removed here. You can disable it instead.');
    await priv('rm', ['-f', path.join(ENABLED, name), path.join(AVAILABLE, name)]);
    if (site.https && site.domains[0]) await priv('certbot', ['delete', '--cert-name', site.domains[0], '--non-interactive'], 120_000).catch(() => undefined);
    const t = await nginxTest();
    if (t.ok) await nginxReload();
    // The project folder is never deleted here.
    return { ok: true as const };
  });
}
