import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { SiteSuggestion } from '../../../protocol/types.js';

function readJson(p: string): Record<string, any> | null {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Record<string, any>;
  } catch {
    return null;
  }
}

function envPort(dir: string): number | null {
  try {
    const m = /^PORT\s*=\s*(\d{2,5})\s*$/m.exec(readFileSync(path.join(dir, '.env'), 'utf8'));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** Looks at a project folder and suggests how nginx should serve it. Best effort; the app lets the user change it. */
export function detectSite(dir: string, phpVersions: string[]): SiteSuggestion {
  const has = (...p: string[]) => existsSync(path.join(dir, ...p));
  const php = phpVersions[0] ? `PHP ${phpVersions[0]}` : 'PHP';

  if (has('artisan') && has('public', 'index.php')) {
    return { kind: 'php', webRoot: 'public', port: null, reason: `Laravel app (artisan found): serves public/ with ${php}` };
  }
  if (has('public', 'index.php')) return { kind: 'php', webRoot: 'public', port: null, reason: `PHP app: serves public/ with ${php}` };
  if (has('index.php') || has('wp-config.php')) return { kind: 'php', webRoot: '', port: null, reason: `PHP site: serves the project folder with ${php}` };

  const pkg = readJson(path.join(dir, 'package.json'));
  if (pkg) {
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) } as Record<string, string>;
    const port = envPort(dir) ?? 3000;
    if (deps.next) return { kind: 'proxy', webRoot: '', port, reason: `Next.js app: runs as a Node server (npm run build && npm start) on port ${port}` };
    if (deps.nuxt) return { kind: 'proxy', webRoot: '', port, reason: `Nuxt app: runs as a Node server on port ${port}` };
    if (deps['@nestjs/core'] || deps.express || deps.fastify || deps.koa || deps.hono) {
      return { kind: 'proxy', webRoot: '', port, reason: `Node API: forwards to the app on port ${port} (keep it running, e.g. with pm2)` };
    }
    if (deps.astro) return { kind: 'static', webRoot: 'dist', port: null, reason: 'Astro site: serves the built dist/ folder (run npm run build)' };
    if (deps.vite || deps['react-scripts'] || deps['@angular/core'] || deps.vue || deps.react) {
      const out = has('build', 'index.html') && !has('dist') ? 'build' : 'dist';
      return { kind: 'spa', webRoot: out, port: null, reason: `Single-page app: serves the built ${out}/ folder (run npm run build)` };
    }
  }
  if (has('dist', 'index.html')) return { kind: 'spa', webRoot: 'dist', port: null, reason: 'Built site found in dist/' };
  if (has('build', 'index.html')) return { kind: 'spa', webRoot: 'build', port: null, reason: 'Built site found in build/' };
  if (has('public', 'index.html')) return { kind: 'static', webRoot: 'public', port: null, reason: 'Static site in public/' };
  return { kind: 'static', webRoot: '', port: null, reason: 'Static files from the project folder' };
}
