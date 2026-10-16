/** Analyze chats: the brief Claude gets, and where their Claude state lives. */
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { app } from '../app.js';

/** Tools Analyze chats never get (the approve broker refuses them too). */
export const ANALYZE_DISALLOWED_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

/** CLAUDE_CONFIG_DIR for Analyze chats: writable inside the sandbox while ~/.claude stays read-only. */
export function analyzeConfigDir(): string {
  return path.join(app.config.dataDir, 'analyze-claude');
}

export function scratchDirOf(sessionId: string): string {
  return path.join(app.config.dataDir, 'scratch', sessionId);
}

export function analyzeBrief(opts: { kernel: boolean; db: { kind: string; database: string } | null; scratch: string }): string {
  const lines = [
    'You are in niCode ANALYZE mode: read-only troubleshooting, often on a production server.',
    'Goal: investigate the code, logs, running services and data to find the cause of the problem, then report.',
    'Hard rules:',
    '- Never modify the project or its git repository: no file edits, no git commands that write (commit, add, checkout, stash, pull, reset, …), no package installs in the project.',
    '- Never change the database, services or server configuration: no INSERT/UPDATE/DELETE/DDL, no restarts, no migrations, no cache clears.',
    kernel(opts.kernel),
    `- Temporary files go in ${opts.scratch} (also $NICODE_SCRATCH and $TMPDIR).`,
    opts.db
      ? `- Database: use the read-only ${opts.db.kind} user (database "${opts.db.database}"), e.g. ${opts.db.kind === 'postgres' ? '`psql -c "…"` (PGHOST/PGUSER/PGPASSWORD/PGDATABASE are set for it)' : '`mysql -u "$NICODE_READONLY_DB_USER" -D "$NICODE_READONLY_DB_NAME" -e "…"` (host, port and password are set in the environment)'}; the full URL is in $NICODE_READONLY_DB_URL. Keep queries bounded (LIMIT) and light on production.`
      : '- No read-only database user is set up for this project (niCode → project → Analyze settings). Do not use the app\'s own credentials to query the database; ask the user to set one up if you need data.',
    '- Secrets in .env files are redacted. Do not try to read or print secrets.',
    'When you are done: summarise the findings, the likely root cause with evidence (file:line, log lines, query results), and the fix. Show code fixes as a diff in your reply; do not apply them. The user deploys fixes through their normal workflow.',
  ];
  return lines.join('\n');
}

function kernel(on: boolean): string {
  return on
    ? '- The filesystem is mounted read-only for you (writes fail with "Read-only file system"); that is intended, do not try to work around it.'
    : '- Treat the filesystem as read-only even where a write would succeed.';
}

/**
 * A chat that becomes an Analyze chat (the server turned production) keeps its conversation:
 * its transcript is copied from ~/.claude into the Analyze config dir so --resume finds it.
 */
export async function adoptTranscript(claudeSessionId: string): Promise<void> {
  const file = `${claudeSessionId}.jsonl`;
  const from = path.join(app.home, '.claude', 'projects');
  const to = path.join(analyzeConfigDir(), 'projects');
  let dirs: string[] = [];
  try {
    dirs = await readdir(from);
  } catch {
    return;
  }
  for (const d of dirs) {
    const src = path.join(from, d, file);
    const dst = path.join(to, d, file);
    if (existsSync(src) && !existsSync(dst)) {
      await mkdir(path.join(to, d), { recursive: true, mode: 0o700 });
      await copyFile(src, dst);
    }
  }
}
