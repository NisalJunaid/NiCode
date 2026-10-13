/**
 * Claude subscription usage per account: the 5-hour session window and the weekly window.
 *
 * Two sources, newest wins:
 *  - "api":  the usage endpoint Claude Code's own /usage screen reads (read-only, costs nothing),
 *            asked with each account's token when the app refreshes.
 *  - "chat": the `rate_limit_event`s Claude Code reports while chatting, credited to the account
 *            that was active at the time (only the window it is reporting on).
 * Neither is an official API, so every field is parsed defensively and a failure only means
 * "no numbers", never an error elsewhere. Results are kept in <dataDir>/claude-usage.json
 * (no tokens in it).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AccountUsage, UsageWindow } from '../../../protocol/types.js';
import { app } from '../app.js';
import { writeFileAtomic } from '../config.js';
import { events } from '../events.js';
import { log } from '../log.js';
import { accountTokens, activeAccountId } from './accounts.js';

const USAGE_URL = process.env.NICODE_USAGE_URL ?? 'https://api.anthropic.com/api/oauth/usage';
const MIN_REFRESH_MS = 60_000;

const file = () => path.join(app.config.dataDir, 'claude-usage.json');
let cache: Record<string, AccountUsage> | null = null;
const lastFetch = new Map<string, number>();

function load(): Record<string, AccountUsage> {
  if (cache) return cache;
  try {
    cache = JSON.parse(readFileSync(file(), 'utf8')) as Record<string, AccountUsage>;
  } catch {
    cache = {};
  }
  return cache;
}

function save(): void {
  void writeFileAtomic(file(), JSON.stringify(cache ?? {})).catch(() => undefined);
}

/**
 * → percent 0..100. The usage endpoint reports percent already (`scale` 'percent'); chat events
 * and rate-limit headers report a fraction 0..1 (`scale` 'fraction'), like Claude Code itself.
 */
export function toPercent(v: unknown, scale: 'percent' | 'fraction'): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  const pct = scale === 'fraction' ? n * 100 : n;
  return Math.min(100, Math.round(pct * 10) / 10);
}

/** Epoch seconds, epoch ms or an ISO string → ISO string. */
export function toIso(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === 'string' && v) {
    const t = /^\d+(\.\d+)?$/.test(v) ? Number(v) : Date.parse(v);
    if (Number.isFinite(t)) return toIso(t);
  }
  return null;
}

function window(raw: unknown): UsageWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const used = r.used_percentage !== undefined ? toPercent(r.used_percentage, 'percent') : toPercent(r.utilization, 'percent');
  if (used === null) return null;
  return { usedPercent: used, resetsAt: toIso(r.resets_at ?? r.resetsAt) };
}

/** Parses the usage endpoint's answer ({five_hour:{utilization,resets_at}, seven_day:{…}}). */
export function parseUsageResponse(body: unknown): Pick<AccountUsage, 'fiveHour' | 'sevenDay'> | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const fiveHour = window(b.five_hour ?? b.fiveHour);
  const sevenDay = window(b.seven_day ?? b.sevenDay);
  return fiveHour || sevenDay ? { fiveHour, sevenDay } : null;
}

function put(id: string, patch: Partial<AccountUsage>): AccountUsage {
  const all = load();
  const prev = all[id] ?? { fiveHour: null, sevenDay: null, updatedAt: new Date(0).toISOString(), source: 'chat' as const };
  const next: AccountUsage = { ...prev, ...patch, updatedAt: new Date().toISOString() };
  if (!patch.error) delete next.error;
  all[id] = next;
  save();
  events.emit('claude.usage', { accountId: id, usage: next });
  return next;
}

async function fetchOne(id: string, token: string): Promise<void> {
  try {
    const res = await fetch(USAGE_URL, {
      headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', accept: 'application/json', 'user-agent': 'niCode' },
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => null)) as unknown;
    const parsed = res.ok ? parseUsageResponse(body) : null;
    if (parsed) put(id, { ...parsed, source: 'api' });
    else {
      const why = res.status === 401 || res.status === 403 ? "This login can't read usage directly; numbers come from chats instead." : `Usage check failed (${res.status})`;
      put(id, { error: why });
      log.info({ status: res.status, account: id }, 'usage check failed');
    }
  } catch (err) {
    put(id, { error: 'Usage check failed (no answer)' });
    log.debug({ err }, 'usage check failed');
  }
}

/** Current numbers for every account; `refresh` asks the usage endpoint again (at most once a minute per account). */
export async function getUsage(refresh: boolean): Promise<Record<string, AccountUsage>> {
  if (refresh) {
    const now = Date.now();
    const due = (await accountTokens()).filter((a) => now - (lastFetch.get(a.id) ?? 0) > MIN_REFRESH_MS);
    for (const a of due) lastFetch.set(a.id, now);
    await Promise.all(due.map((a) => fetchOne(a.id, a.token)));
  }
  const ids = new Set((await accountTokens()).map((a) => a.id));
  return Object.fromEntries(Object.entries(load()).filter(([id]) => ids.has(id)));
}

/** A `rate_limit_event` from a chat: credit it to the account that is active now. */
export async function noteRateLimitEvent(event: Record<string, unknown>): Promise<void> {
  const info = (event.rate_limit_info ?? event.rateLimitInfo) as Record<string, unknown> | undefined;
  if (!info) return;
  const id = await activeAccountId();
  if (!id) return;
  const w: UsageWindow | null = (() => {
    const used = toPercent(info.utilization, 'fraction');
    return used === null ? null : { usedPercent: used, resetsAt: toIso(info.resetsAt ?? info.resets_at) };
  })();
  const status = typeof info.status === 'string' ? (info.status as AccountUsage['status']) : undefined;
  const type = info.rateLimitType ?? info.rate_limit_type;
  const patch: Partial<AccountUsage> = { source: 'chat', ...(status ? { status } : {}) };
  if (w && type === 'five_hour') patch.fiveHour = w;
  else if (w && (type === 'seven_day' || type === 'seven_day_opus' || type === 'seven_day_sonnet')) patch.sevenDay = w;
  else if (!status) return;
  put(id, patch);
}
