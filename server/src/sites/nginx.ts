/**
 * Pure helpers for nginx site configs: render the sites niCode creates, and read any site
 * (including hand-written ones) well enough to list it in the app. No I/O here.
 */
import type { SiteKind } from '../../../protocol/types.js';

export const MANAGED_MARKER = '# managed-by: niCode';
const DOMAIN_RE = /^(?=.{1,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function normalizeDomain(input: string): string {
  return input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
}

export function isValidDomain(d: string): boolean {
  return DOMAIN_RE.test(d);
}

export interface RenderOptions {
  domains: string[];
  kind: SiteKind;
  /** Absolute folder nginx serves (static/spa/php). */
  root: string;
  port?: number;
  /** php-fpm socket, e.g. /run/php/php8.2-fpm.sock */
  phpSocket?: string;
  createdAt?: string;
}

export function renderSite(o: RenderOptions): string {
  const lines = [
    `${MANAGED_MARKER} (${o.createdAt ?? new Date().toISOString()}). Safe to edit by hand.`,
    `# nicode-kind: ${o.kind}`,
    'server {',
    '    listen 80;',
    '    listen [::]:80;',
    `    server_name ${o.domains.join(' ')};`,
    '',
    '    client_max_body_size 64m;',
    '    gzip on;',
    '    gzip_types text/plain text/css application/json application/javascript text/xml application/xml image/svg+xml;',
    '',
  ];
  switch (o.kind) {
    case 'proxy':
      lines.push(
        '    location / {',
        `        proxy_pass http://127.0.0.1:${o.port ?? 3000};`,
        '        proxy_http_version 1.1;',
        '        proxy_set_header Host $host;',
        '        proxy_set_header X-Real-IP $remote_addr;',
        '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
        '        proxy_set_header X-Forwarded-Proto $scheme;',
        '        proxy_set_header Upgrade $http_upgrade;',
        '        proxy_set_header Connection "upgrade";',
        '        proxy_read_timeout 120s;',
        '    }',
      );
      break;
    case 'php':
      lines.push(
        `    root ${o.root};`,
        '    index index.php index.html;',
        '    charset utf-8;',
        '',
        '    location / {',
        '        try_files $uri $uri/ /index.php?$query_string;',
        '    }',
        '',
        '    location ~ \\.php$ {',
        '        include snippets/fastcgi-php.conf;',
        `        fastcgi_pass unix:${o.phpSocket ?? '/run/php/php-fpm.sock'};`,
        '    }',
        '',
        '    location ~ /\\.(?!well-known).* {',
        '        deny all;',
        '    }',
      );
      break;
    case 'spa':
    case 'static':
      lines.push(
        `    root ${o.root};`,
        '    index index.html index.htm;',
        '',
        '    location / {',
        `        try_files $uri $uri/ ${o.kind === 'spa' ? '/index.html' : '=404'};`,
        '    }',
        '',
        '    location ~ /\\.(?!well-known).* {',
        '        deny all;',
        '    }',
      );
      break;
  }
  lines.push('}', '');
  return lines.join('\n');
}

export interface ParsedSite {
  managed: boolean;
  domains: string[];
  root: string | null;
  proxyPort: number | null;
  https: boolean;
  sslCertificate: string | null;
  kind: SiteKind | 'unknown';
}

/** Reads the parts of an nginx site that matter for the app. Tolerant of any formatting. */
export function parseSite(text: string): ParsedSite {
  const managed = text.includes(MANAGED_MARKER);
  const markedKind = /^# nicode-kind:\s*(static|spa|php|proxy)\s*$/m.exec(text)?.[1] as SiteKind | undefined;
  const body = text
    .split('\n')
    .map((l) => l.replace(/(^|\s)#.*$/, ''))
    .join('\n');
  const domains = new Set<string>();
  for (const m of body.matchAll(/\bserver_name\s+([^;]+);/g)) {
    for (const d of m[1]!.trim().split(/\s+/)) {
      if (d && d !== '_' && d !== 'localhost' && !d.startsWith('~')) domains.add(d.toLowerCase());
    }
  }
  const root = /\broot\s+([^;\s]+)\s*;/.exec(body)?.[1] ?? null;
  const port = /\bproxy_pass\s+https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)/.exec(body)?.[1];
  const sslCertificate = /\bssl_certificate\s+([^;\s]+)\s*;/.exec(body)?.[1] ?? null;
  const https = !!sslCertificate || /\blisten\s+[^;]*443/.test(body);
  let kind: ParsedSite['kind'] = markedKind ?? 'unknown';
  if (!markedKind) {
    if (port) kind = 'proxy';
    else if (/\bfastcgi_pass\b/.test(body)) kind = 'php';
    else if (/try_files[^;]*\/index\.html\s*;/.test(body)) kind = 'spa';
    else if (root) kind = 'static';
  }
  return { managed, domains: [...domains], root, proxyPort: port ? Number(port) : null, https, sslCertificate, kind };
}

/** Config file name for a new site: "<domain>.conf". */
export function siteFileName(domain: string): string {
  return `${domain}.conf`;
}

/** "php8.2-fpm.sock" → "8.2" */
export function phpVersionFromSocket(name: string): string | null {
  return /^php(\d+\.\d+)-fpm\.sock$/.exec(name)?.[1] ?? null;
}

/** Highest version first: ["8.3", "8.1", "7.4"]. */
export function sortVersionsDesc(v: string[]): string[] {
  return [...v].sort((a, b) => {
    const [a1 = 0, a2 = 0] = a.split('.').map(Number);
    const [b1 = 0, b2 = 0] = b.split('.').map(Number);
    return b1 - a1 || b2 - a2;
  });
}
