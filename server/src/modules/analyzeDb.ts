/**
 * Read-only database access for Analyze chats, per project. The user creates a SELECT-only DB user
 * once (niCode suggests the SQL from the project's .env); niCode verifies it really can't write,
 * keeps the URL in <dataDir>/analyze-db.json (mode 600, never sent back to the app) and hands it
 * only to Analyze chats, as $NICODE_READONLY_DB_URL (plus PG* / NICODE_READONLY_DB_* parts).
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { AnalyzeDb, AnalyzeDbSuggestion } from '../../../protocol/types.js';
import { app } from '../app.js';
import { readEnvFile, writeFileAtomic } from '../config.js';
import { log } from '../log.js';
import { register, RpcError } from '../rpc.js';
import { run } from '../util/exec.js';
import { projectOf } from './projects.js';

interface Stored extends AnalyzeDb {
  url: string;
}
type StoreFile = Record<string, Stored>;

const file = () => path.join(app.config.dataDir, 'analyze-db.json');
let writing: Promise<unknown> = Promise.resolve();

async function load(): Promise<StoreFile> {
  try {
    return JSON.parse(await readFile(file(), 'utf8')) as StoreFile;
  } catch {
    return {};
  }
}

function update(mutate: (s: StoreFile) => void): Promise<void> {
  const step = async () => {
    const s = await load();
    mutate(s);
    await writeFileAtomic(file(), JSON.stringify(s, null, 2));
  };
  const p = writing.then(step, step);
  writing = p.catch(() => undefined);
  return p;
}

const publicInfo = ({ url: _url, ...rest }: Stored): AnalyzeDb => rest;

interface Parsed {
  kind: 'postgres' | 'mysql';
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export function parseDbUrl(url: string): Parsed {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new RpcError('bad_request', 'Not a valid database URL (postgres://user:password@host:5432/db or mysql://…)');
  }
  const scheme = u.protocol.replace(/:$/, '');
  const kind = scheme === 'postgres' || scheme === 'postgresql' ? 'postgres' : scheme === 'mysql' || scheme === 'mariadb' ? 'mysql' : null;
  if (!kind) throw new RpcError('bad_request', 'Only PostgreSQL and MySQL/MariaDB URLs are supported');
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!u.hostname || !u.username || !database) throw new RpcError('bad_request', 'The URL needs a user, a host and a database name');
  return {
    kind,
    host: u.hostname.replace(/^\[|\]$/g, ''),
    port: u.port ? Number(u.port) : kind === 'postgres' ? 5432 : 3306,
    database,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
  };
}

function buildUrl(p: Parsed): string {
  const scheme = p.kind === 'postgres' ? 'postgres' : 'mysql';
  return `${scheme}://${encodeURIComponent(p.user)}:${encodeURIComponent(p.password)}@${p.host.includes(':') ? `[${p.host}]` : p.host}:${p.port}/${encodeURIComponent(p.database)}`;
}

/** Environment for an Analyze chat of this project (null when no read-only user is set up). */
export async function readonlyDb(projectPath: string): Promise<{ kind: string; database: string; env: Record<string, string> } | null> {
  const s = (await load())[projectPath];
  if (!s) return null;
  const p = parseDbUrl(s.url);
  const env: Record<string, string> = {
    NICODE_READONLY_DB_URL: s.url,
    NICODE_READONLY_DB_KIND: p.kind,
    NICODE_READONLY_DB_HOST: p.host,
    NICODE_READONLY_DB_PORT: String(p.port),
    NICODE_READONLY_DB_USER: p.user,
    NICODE_READONLY_DB_PASSWORD: p.password,
    NICODE_READONLY_DB_NAME: p.database,
  };
  // Plain `psql` / `mysql` then connect as the read-only user by default.
  if (p.kind === 'postgres') Object.assign(env, { PGHOST: p.host, PGPORT: String(p.port), PGUSER: p.user, PGPASSWORD: p.password, PGDATABASE: p.database });
  else Object.assign(env, { MYSQL_HOST: p.host, MYSQL_TCP_PORT: String(p.port), MYSQL_PWD: p.password });
  return { kind: p.kind, database: p.database, env };
}

// ── Suggesting the SQL ────────────────────────────────────────────────────────

const ident = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');
const pgIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;
const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;
const myIdent = (s: string) => `\`${s.replace(/`/g, '``')}\``;

/** What the project's .env says about its database. */
export function detectDb(env: Record<string, string>): { kind: 'postgres' | 'mysql'; host: string; port: number; database: string; appUser: string | null } | null {
  for (const key of ['DATABASE_URL', 'DB_URL', 'POSTGRES_URL', 'MYSQL_URL']) {
    const v = env[key];
    if (!v) continue;
    try {
      const p = parseDbUrl(v);
      return { kind: p.kind, host: p.host, port: p.port, database: p.database, appUser: p.user };
    } catch {
      // not a URL we understand
    }
  }
  const conn = (env.DB_CONNECTION ?? env.DB_ENGINE ?? '').toLowerCase();
  const kind = /pg|postgres/.test(conn) ? 'postgres' : /mysql|maria/.test(conn) ? 'mysql' : env.POSTGRES_DB ? 'postgres' : env.MYSQL_DATABASE ? 'mysql' : null;
  if (!kind) return null;
  const database = env.DB_DATABASE ?? env.DB_NAME ?? env.POSTGRES_DB ?? env.MYSQL_DATABASE ?? '';
  if (!database) return null;
  const host = env.DB_HOST ?? env.POSTGRES_HOST ?? env.MYSQL_HOST ?? '127.0.0.1';
  const port = Number(env.DB_PORT ?? env.POSTGRES_PORT ?? env.MYSQL_PORT ?? (kind === 'postgres' ? 5432 : 3306));
  return { kind, host, port, database, appUser: env.DB_USERNAME ?? env.DB_USER ?? env.POSTGRES_USER ?? env.MYSQL_USER ?? null };
}

export function suggestionFor(env: Record<string, string>): AnalyzeDbSuggestion {
  const db = detectDb(env);
  const password = randomBytes(18).toString('base64url');
  if (!db) {
    return {
      kind: null,
      reason: "Couldn't find PostgreSQL or MySQL settings in the project's .env (DATABASE_URL or DB_CONNECTION/DB_DATABASE).",
      host: '127.0.0.1',
      port: 5432,
      database: '',
      user: 'nicode_ro',
      password,
      sql: '',
      url: '',
    };
  }
  const user = `nicode_ro_${ident(db.database)}`.slice(0, 32).toLowerCase();
  let sql: string;
  if (db.kind === 'postgres') {
    sql = [
      `-- Run as a database admin, e.g.: sudo -u postgres psql -d ${pgIdent(db.database)}`,
      `CREATE ROLE ${pgIdent(user)} LOGIN PASSWORD ${sqlString(password)};`,
      `ALTER ROLE ${pgIdent(user)} SET default_transaction_read_only = on;`,
      `GRANT CONNECT ON DATABASE ${pgIdent(db.database)} TO ${pgIdent(user)};`,
      `GRANT USAGE ON SCHEMA public TO ${pgIdent(user)};`,
      `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${pgIdent(user)};`,
      `GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${pgIdent(user)};`,
      `-- Tables created later (by the app's own user) are readable too:`,
      `ALTER DEFAULT PRIVILEGES${db.appUser ? ` FOR ROLE ${pgIdent(db.appUser)}` : ''} IN SCHEMA public GRANT SELECT ON TABLES TO ${pgIdent(user)};`,
    ].join('\n');
  } else {
    const local = ['127.0.0.1', 'localhost', '::1'].includes(db.host);
    const hosts = local ? ['localhost', '127.0.0.1'] : ['%'];
    sql = [
      `-- Run as a database admin, e.g.: sudo mysql`,
      ...hosts.flatMap((h) => [
        `CREATE USER ${sqlString(user)}@${sqlString(h)} IDENTIFIED BY ${sqlString(password)};`,
        `GRANT SELECT, SHOW VIEW ON ${myIdent(db.database)}.* TO ${sqlString(user)}@${sqlString(h)};`,
      ]),
    ].join('\n');
  }
  const parsed: Parsed = { kind: db.kind, host: db.host, port: db.port, database: db.database, user, password };
  return { kind: db.kind, host: db.host, port: db.port, database: db.database, user, password, sql, url: buildUrl(parsed) };
}

// ── Verifying a URL really is read-only ───────────────────────────────────────

const ALLOWED_MYSQL = new Set(['USAGE', 'SELECT', 'SHOW VIEW', 'SHOW DATABASES', 'PROCESS', 'REPLICATION CLIENT']);

/** Problems with MySQL `SHOW GRANTS` output for a read-only user (empty = fine). */
export function mysqlGrantProblems(grants: string[]): string[] {
  const problems: string[] = [];
  for (const g of grants) {
    const m = /^GRANT\s+(.+?)\s+ON\s+/i.exec(g.trim());
    if (!m) {
      problems.push(`unexpected grant: ${g.trim().slice(0, 120)}`);
      continue;
    }
    for (const priv of m[1]!.split(',').map((p) => p.trim().toUpperCase().replace(/\s*\(.*\)$/, ''))) {
      if (!ALLOWED_MYSQL.has(priv)) problems.push(`has ${priv}`);
    }
  }
  return problems;
}

async function verify(p: Parsed): Promise<void> {
  if (process.env.NICODE_TEST_DB_VERIFY === '1') return; // tests: no database server
  if (p.kind === 'postgres') {
    const env = { ...process.env, PGHOST: p.host, PGPORT: String(p.port), PGUSER: p.user, PGPASSWORD: p.password, PGDATABASE: p.database, PGCONNECT_TIMEOUT: '10' };
    const q = [
      "SELECT 'super=' || (rolsuper OR rolcreaterole OR rolbypassrls)::text FROM pg_roles WHERE rolname = current_user",
      "SELECT 'grants=' || count(*) FROM information_schema.role_table_grants WHERE grantee = current_user AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER','REFERENCES')",
      "SELECT 'owns=' || count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE pg_get_userbyid(c.relowner) = current_user AND n.nspname NOT IN ('pg_catalog','information_schema')",
    ].join(' UNION ALL ');
    const r = await run('psql', ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', q], { env, timeoutMs: 30_000 }).catch((err: NodeJS.ErrnoException) => {
      throw new RpcError('bad_request', err.code === 'ENOENT' ? 'psql is not installed on this server (apt install postgresql-client)' : err.message);
    });
    if (r.code !== 0) throw new RpcError('bad_request', `Couldn't connect: ${(r.stderr || r.stdout).trim().split('\n')[0]}`);
    const out = Object.fromEntries(r.stdout.trim().split('\n').map((l) => l.trim().split('=') as [string, string]));
    const problems: string[] = [];
    if (out.super === 'true') problems.push('is a superuser or can create roles');
    if (Number(out.grants) > 0) problems.push(`has write privileges on ${out.grants} table(s)`);
    if (Number(out.owns) > 0) problems.push(`owns ${out.owns} table(s) (owners can always write)`);
    if (problems.length) throw new RpcError('bad_request', `This user can write to the database: it ${problems.join('; ')}. Use a SELECT-only user.`);
    return;
  }
  const env = { ...process.env, MYSQL_PWD: p.password };
  const r = await run('mysql', ['-h', p.host, '-P', String(p.port), '-u', p.user, '-D', p.database, '-N', '-B', '--connect-timeout=10', '-e', 'SHOW GRANTS'], { env, timeoutMs: 30_000 }).catch(
    (err: NodeJS.ErrnoException) => {
      throw new RpcError('bad_request', err.code === 'ENOENT' ? 'The mysql client is not installed on this server (apt install mysql-client)' : err.message);
    },
  );
  if (r.code !== 0) throw new RpcError('bad_request', `Couldn't connect: ${(r.stderr || r.stdout).trim().split('\n')[0]}`);
  const problems = mysqlGrantProblems(r.stdout.split('\n').filter((l) => l.trim()));
  if (problems.length) throw new RpcError('bad_request', `This user can write to the database (${[...new Set(problems)].join(', ')}). Use a SELECT-only user.`);
}

export function registerAnalyzeDbModule(): void {
  const P = z.object({ projectPath: z.string() });

  register('analyze.db.get', P, async ({ projectPath }) => {
    const s = (await load())[await projectOf(projectPath)];
    return s ? publicInfo(s) : null;
  });

  register('analyze.db.suggest', P, async ({ projectPath }) => {
    const project = await projectOf(projectPath);
    return suggestionFor(readEnvFile(path.join(project, '.env')));
  });

  register('analyze.db.set', z.object({ projectPath: z.string(), url: z.string().min(8).max(2000) }), async ({ projectPath, url }) => {
    const project = await projectOf(projectPath);
    const p = parseDbUrl(url);
    await verify(p);
    const stored: Stored = { kind: p.kind, host: p.host, port: p.port, database: p.database, user: p.user, verifiedAt: new Date().toISOString(), url: buildUrl(p) };
    await update((s) => {
      s[project] = stored;
    });
    log.info({ project, kind: p.kind, host: p.host, database: p.database, user: p.user }, 'read-only database saved for analyze');
    return publicInfo(stored);
  });

  register('analyze.db.clear', P, async ({ projectPath }) => {
    const project = await projectOf(projectPath);
    await update((s) => {
      delete s[project];
    });
    return { ok: true as const };
  });
}
