/**
 * Claude subscription accounts on this server. Each login (`claude setup-token`) is kept as a
 * named account in <dataDir>/claude-accounts.json (mode 600); the active one is mirrored into
 * the env file as CLAUDE_CODE_OAUTH_TOKEN, which is what every Claude process uses.
 * Tokens never leave the server: the app only sees names, dates and the last 4 characters.
 * A login made directly on the server (`claude /login`, ~/.claude/.credentials.json) shows up
 * as the "cli" account and is used whenever no token account is active.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ClaudeAccount } from '../../../protocol/types.js';
import { app } from '../app.js';
import { readEnvFile, removeEnvVar, setEnvVar, writeFileAtomic } from '../config.js';
import { RpcError } from '../rpc.js';

interface Stored {
  id: string;
  label: string;
  token: string;
  addedAt: string;
  lastUsedAt: string | null;
}
interface StoreFile {
  active: string | null;
  accounts: Stored[];
}

const KEY = 'CLAUDE_CODE_OAUTH_TOKEN';
const file = () => path.join(app.config.dataDir, 'claude-accounts.json');
const cliLoggedIn = () => existsSync(path.join(app.home, '.claude', '.credentials.json'));
let writing: Promise<unknown> = Promise.resolve();

async function load(): Promise<StoreFile> {
  let s: StoreFile = { active: null, accounts: [] };
  try {
    s = JSON.parse(await readFile(file(), 'utf8')) as StoreFile;
  } catch {
    // first use
  }
  // Adopt a token that was saved before accounts existed (or put in the env file by hand).
  const envToken = readEnvFile(app.config.envFile)[KEY];
  if (envToken && !s.accounts.some((a) => a.token === envToken)) {
    const a: Stored = { id: randomUUID(), label: `Account ${s.accounts.length + 1}`, token: envToken, addedAt: new Date().toISOString(), lastUsedAt: new Date().toISOString() };
    s.accounts.push(a);
    s.active = a.id;
    await save(s);
  } else if (envToken) {
    s.active = s.accounts.find((a) => a.token === envToken)!.id;
  } else if (s.active) {
    s.active = null; // token removed from the env file by hand
  }
  return s;
}

async function save(s: StoreFile): Promise<void> {
  await writeFileAtomic(file(), JSON.stringify(s, null, 2));
}

/** Serialises changes so two taps can't interleave. */
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const p = writing.then(fn, fn);
  writing = p.catch(() => undefined);
  return p;
}

function view(s: StoreFile): ClaudeAccount[] {
  const out: ClaudeAccount[] = s.accounts.map((a) => ({
    id: a.id,
    label: a.label,
    kind: 'token',
    active: a.id === s.active,
    addedAt: a.addedAt,
    lastUsedAt: a.lastUsedAt,
    hint: `…${a.token.slice(-4)}`,
  }));
  if (cliLoggedIn()) out.push({ id: 'cli', label: 'Server login (claude /login)', kind: 'cli', active: !s.active, addedAt: null, lastUsedAt: null, hint: null });
  return out;
}

export async function listAccounts(): Promise<ClaudeAccount[]> {
  return view(await load());
}

async function activate(s: StoreFile, id: string | null): Promise<void> {
  const a = id ? s.accounts.find((x) => x.id === id) : undefined;
  if (a) {
    await setEnvVar(app.config.envFile, KEY, a.token);
    a.lastUsedAt = new Date().toISOString();
    s.active = a.id;
  } else {
    await removeEnvVar(app.config.envFile, KEY);
    s.active = null;
  }
  await save(s);
}

/** Adds a verified token (or updates the account that already has it) and optionally makes it active. */
export function addAccount(token: string, label: string | undefined, makeActive = true): Promise<{ id: string; accounts: ClaudeAccount[] }> {
  return locked(async () => {
    const s = await load();
    let a = s.accounts.find((x) => x.token === token);
    if (a) {
      if (label?.trim()) a.label = label.trim();
    } else {
      a = { id: randomUUID(), label: label?.trim() || `Account ${s.accounts.length + 1}`, token, addedAt: new Date().toISOString(), lastUsedAt: null };
      s.accounts.push(a);
    }
    if (makeActive || !s.active) await activate(s, a.id);
    else await save(s);
    return { id: a.id, accounts: view(s) };
  });
}

export function switchAccount(id: string): Promise<ClaudeAccount[]> {
  return locked(async () => {
    const s = await load();
    if (id === 'cli') {
      if (!cliLoggedIn()) throw new RpcError('not_found', 'There is no server login (claude /login) on this server');
      await activate(s, null);
    } else {
      if (!s.accounts.some((a) => a.id === id)) throw new RpcError('not_found', 'Unknown account');
      await activate(s, id);
    }
    return view(s);
  });
}

export function renameAccount(id: string, label: string): Promise<ClaudeAccount[]> {
  return locked(async () => {
    const s = await load();
    const a = s.accounts.find((x) => x.id === id);
    if (!a) throw new RpcError('not_found', 'Unknown account');
    a.label = label.trim();
    await save(s);
    return view(s);
  });
}

/** Forgets an account's token. If it was active, the most recently used other account takes over. */
export function logoutAccount(id: string): Promise<{ accounts: ClaudeAccount[]; switchedTo: string | null }> {
  return locked(async () => {
    const s = await load();
    if (id === 'cli') throw new RpcError('forbidden', 'The server login is managed on the server: run `claude /logout` there');
    const a = s.accounts.find((x) => x.id === id);
    if (!a) throw new RpcError('not_found', 'Unknown account');
    s.accounts = s.accounts.filter((x) => x.id !== id);
    let switchedTo: string | null = null;
    if (s.active === id) {
      const next = [...s.accounts].sort((x, y) => (y.lastUsedAt ?? y.addedAt).localeCompare(x.lastUsedAt ?? x.addedAt))[0];
      await activate(s, next?.id ?? null);
      switchedTo = next?.id ?? (cliLoggedIn() ? 'cli' : null);
    } else await save(s);
    return { accounts: view(s), switchedTo };
  });
}

/** Tokens to check usage with: each niCode account, plus the server's own `claude /login` (if any). */
export async function accountTokens(): Promise<{ id: string; token: string; active: boolean }[]> {
  const s = await load();
  const out = s.accounts.map((a) => ({ id: a.id, token: a.token, active: a.id === s.active }));
  if (cliLoggedIn()) {
    try {
      const creds = JSON.parse(await readFile(path.join(app.home, '.claude', '.credentials.json'), 'utf8')) as { claudeAiOauth?: { accessToken?: string } };
      if (creds.claudeAiOauth?.accessToken) out.push({ id: 'cli', token: creds.claudeAiOauth.accessToken, active: !s.active });
    } catch {
      // unreadable: no usage for it
    }
  }
  return out;
}

/** Id of the account Claude currently runs with ('cli' for the server's own login, null if none). */
export async function activeAccountId(): Promise<string | null> {
  const s = await load();
  return s.active ?? (cliLoggedIn() ? 'cli' : null);
}
