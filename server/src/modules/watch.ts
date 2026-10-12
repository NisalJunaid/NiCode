/**
 * Background watchers that send push notifications: a pm2 app crashing (errored, or restarting
 * repeatedly) and a niCode site going down / coming back. They only do work while at least one
 * phone is registered for push. Each alert is sent at most once an hour.
 */
import type { AppProcess } from '../../../protocol/types.js';
import { log } from '../log.js';
import { listApps } from './apps.js';
import { readTokens, sendPush } from './push.js';
import { listSites } from './sites.js';

const HOUR = 3600_000;
const RESTART_WINDOW = 5 * 60_000;
const RESTARTS_ALERT = 3;

export interface Alert {
  key: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
}

/** Remembers when each alert was last sent. */
export class Throttle {
  private last = new Map<string, number>();
  constructor(private readonly everyMs = HOUR) {}
  allow(key: string, now = Date.now()): boolean {
    const t = this.last.get(key);
    if (t !== undefined && now - t < this.everyMs) return false;
    this.last.set(key, now);
    return true;
  }
}

/** pm2 apps: alert when an app becomes errored, or restarts ≥3 times within 5 minutes. */
export class CrashWatcher {
  private prev = new Map<string, { status: string; restarts: { at: number; count: number }[] }>();
  private primed = false;

  observe(apps: Pick<AppProcess, 'name' | 'status' | 'restarts'>[], now = Date.now()): Alert[] {
    const out: Alert[] = [];
    for (const a of apps) {
      const p = this.prev.get(a.name) ?? { status: a.status, restarts: [] };
      const history = [...p.restarts, { at: now, count: a.restarts }].filter((r) => now - r.at <= RESTART_WINDOW);
      const recent = history.length ? a.restarts - history[0]!.count : 0;
      if (this.primed) {
        if (a.status === 'errored' && p.status !== 'errored') {
          out.push({ key: `app:${a.name}:errored`, title: `💥 ${a.name} crashed`, body: 'pm2 stopped restarting it. Open the app to see its logs.', data: { kind: 'app', name: a.name } });
        } else if (recent >= RESTARTS_ALERT) {
          out.push({ key: `app:${a.name}:restarts`, title: `⚠️ ${a.name} keeps restarting`, body: `${recent} restarts in the last 5 minutes.`, data: { kind: 'app', name: a.name } });
        }
      }
      this.prev.set(a.name, { status: a.status, restarts: history });
    }
    this.primed = true;
    return out;
  }
}

/** Sites: alert after two failed checks in a row, and again once it is back up. */
export class SiteWatcher {
  private fails = new Map<string, number>();
  private down = new Set<string>();

  observe(results: { name: string; domain: string; ok: boolean; detail: string }[]): Alert[] {
    const out: Alert[] = [];
    for (const r of results) {
      if (r.ok) {
        this.fails.delete(r.name);
        if (this.down.delete(r.name)) out.push({ key: `site:${r.name}:up:${Date.now()}`, title: `✅ ${r.domain} is back up`, body: 'It answers again.', data: { kind: 'site', name: r.name } });
        continue;
      }
      const n = (this.fails.get(r.name) ?? 0) + 1;
      this.fails.set(r.name, n);
      if (n >= 2 && !this.down.has(r.name)) {
        this.down.add(r.name);
        out.push({ key: `site:${r.name}:down`, title: `🔴 ${r.domain} is down`, body: r.detail, data: { kind: 'site', name: r.name } });
      }
    }
    return out;
  }
}

async function checkSite(domain: string, https: boolean): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`${https ? 'https' : 'http'}://${domain}/`, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    return res.status >= 500 ? { ok: false, detail: `It answers with error ${res.status}.` } : { ok: true, detail: '' };
  } catch (err) {
    const msg = err instanceof Error ? ((err.cause as Error | undefined)?.message ?? err.message) : 'no answer';
    return { ok: false, detail: `No answer: ${msg}` };
  }
}

export function startWatchers(): void {
  const throttle = new Throttle();
  const crashes = new CrashWatcher();
  const sites = new SiteWatcher();
  const send = (alerts: Alert[]) => {
    for (const a of alerts) if (throttle.allow(a.key)) void sendPush(a.title, a.body, a.data, 'alerts');
  };
  const anyPhone = async () => (await readTokens()).length > 0;

  setInterval(async () => {
    try {
      if (await anyPhone()) send(crashes.observe(await listApps()));
    } catch (err) {
      log.debug({ err }, 'crash watcher');
    }
  }, 30_000).unref();

  setInterval(async () => {
    try {
      if (!(await anyPhone())) return;
      const list = (await listSites()).filter((s) => s.enabled && s.managed && s.domains[0] && !s.protected);
      const results = await Promise.all(list.map(async (s) => ({ name: s.name, domain: s.domains[0]!, ...(await checkSite(s.domains[0]!, s.https)) })));
      send(sites.observe(results));
    } catch (err) {
      log.debug({ err }, 'site watcher');
    }
  }, 5 * 60_000).unref();
}
