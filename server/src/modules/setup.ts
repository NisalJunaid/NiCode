import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { app } from '../app.js';
import { addAccount, listAccounts, logoutAccount, renameAccount, switchAccount } from '../claude/accounts.js';
import { events } from '../events.js';
import { log, maskSecrets } from '../log.js';
import { NoParams, register, RpcError } from '../rpc.js';
import { run, runOk } from '../util/exec.js';
import { PtyCapture } from '../util/ptyCapture.js';
import { restartClaudeProcesses } from './claude.js';
import { githubLoggedIn } from './server.js';

const TOKEN_RE = /sk-ant-oat[0-9A-Za-z_-]+/;
/** What `claude setup-token` prints when the pasted code is rejected. */
const LOGIN_ERROR_RE = /(OAuth error[^\n]*|Invalid code[^\n]*|[Ee]rror:[^\n]*)/;

/** The login link from the CLI's screen, cut cleanly (nothing glued onto the end of `state`). */
export function cleanLoginUrl(raw: string): string {
  const url = raw.replace(/Paste\s*code.*$/is, '').replace(/[)\].,;]+$/, '');
  try {
    const u = new URL(url);
    const state = u.searchParams.get('state');
    if (state) u.searchParams.set('state', state.match(/^[A-Za-z0-9_-]+/)?.[0] ?? state);
    return u.toString();
  } catch {
    return url;
  }
}

let claudeLogin: { id: string; pty: PtyCapture } | null = null;
const githubLogins = new Map<string, PtyCapture>();

/** After the logged-in account changed: new turns use it, and the server state follows. */
async function loginChanged(): Promise<void> {
  restartClaudeProcesses();
  const status = await app.status.setState(app.claudeLoggedIn() ? 'ready' : 'needs_claude_login');
  events.emit('setup.progress', status);
}

/** Proves the token works with a one-shot prompt, saves it as an account, and (by default) switches to it. */
async function saveAndVerifyClaudeToken(token: string, label?: string, activate = true): Promise<string> {
  const env = { ...app.claudeEnv(), CLAUDE_CODE_OAUTH_TOKEN: token };
  // Tests: skip the real one-shot prompt (no Claude CLI on CI machines).
  const r = process.env.NICODE_TEST_CLAUDE_VERIFY === '1' ? { code: 0, stdout: 'OK', stderr: '' } : await run(app.config.claudeBin, ['-p', 'Reply with just the word OK', '--output-format', 'json'], {
    env,
    cwd: app.home,
    timeoutMs: 90_000,
  });
  const ok = r.code === 0 && /\bok\b/i.test(r.stdout);
  if (!ok) {
    throw new RpcError('bad_request', 'Claude rejected this login. Try again.', { output: maskSecrets((r.stderr || r.stdout).slice(-500)) });
  }
  const { id } = await addAccount(token, label, activate);
  await loginChanged();
  log.info('claude login saved and verified');
  return id;
}

const Label = z.string().trim().min(1).max(40).optional();

export function registerSetupModule(): void {
  register('setup.status', NoParams, () => app.status.read());

  register('setup.claudeLogin.start', NoParams, async () => {
    claudeLogin?.pty.kill();
    const env = app.claudeEnv();
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    const p = new PtyCapture(app.config.claudeBin, ['setup-token'], { cwd: app.home, env });
    const id = randomUUID();
    claudeLogin = { id, pty: p };
    const m = await p.waitFor(/https:\/\/[^\s"'<>]+/, 30_000);
    if (!m) {
      p.kill();
      throw new RpcError('internal', 'Claude did not show a login link', { output: maskSecrets(p.output.slice(-500)) });
    }
    return { loginId: id, url: cleanLoginUrl(m[0]) };
  });

  register('setup.claudeLogin.submit', z.object({ loginId: z.string(), code: z.string().min(4).max(4096), label: Label, activate: z.boolean().optional() }), async ({ loginId, code, label, activate }) => {
    if (!claudeLogin || claudeLogin.id !== loginId) throw new RpcError('not_found', 'Login expired; start again');
    const p = claudeLogin.pty;
    const before = p.output.length;
    // The code from the Claude page looks like "<code>#<state>"; type it, then press Enter.
    p.write(code.trim().replace(/\s+/g, ''));
    await new Promise((r) => setTimeout(r, 300));
    p.write('\r');
    const m = await p.waitFor(new RegExp(`${TOKEN_RE.source}|${LOGIN_ERROR_RE.source}`), 90_000, before);
    p.kill();
    claudeLogin = null;
    if (!m) throw new RpcError('bad_request', 'Claude did not answer after the code was entered. Start the login again.', { output: maskSecrets(p.output.slice(before).slice(-500)) });
    if (!TOKEN_RE.test(m[0])) {
      throw new RpcError(
        'bad_request',
        `Claude rejected the code (${m[0].trim()}). Codes work once and only for the login link they came from: tap "Open Claude login" again and paste the new code.`,
      );
    }
    return { ok: true as const, accountId: await saveAndVerifyClaudeToken(m[0], label, activate) };
  });

  register('setup.claudeLogin.setToken', z.object({ token: z.string().regex(/^sk-ant-[A-Za-z0-9_-]+$/), label: Label, activate: z.boolean().optional() }), async ({ token, label, activate }) => ({
    ok: true as const,
    accountId: await saveAndVerifyClaudeToken(token, label, activate),
  }));

  // Several Claude subscriptions per server: list, switch, rename, log out (tokens stay here).
  register('setup.claudeAccounts.list', NoParams, async () => ({ accounts: await listAccounts() }));
  register('setup.claudeAccounts.switch', z.object({ id: z.string().max(64) }), async ({ id }) => {
    const accounts = await switchAccount(id);
    await loginChanged();
    return { accounts };
  });
  register('setup.claudeAccounts.rename', z.object({ id: z.string().max(64), label: z.string().trim().min(1).max(40) }), async ({ id, label }) => ({ accounts: await renameAccount(id, label) }));
  register('setup.claudeAccounts.logout', z.object({ id: z.string().max(64) }), async ({ id }) => {
    const r = await logoutAccount(id);
    await loginChanged();
    return r;
  });

  register('setup.github.start', NoParams, async () => {
    for (const p of githubLogins.values()) p.kill();
    githubLogins.clear();
    const env = { ...process.env, BROWSER: 'true', GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '' };
    const p = new PtyCapture('gh', ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'], {
      cwd: app.home,
      env,
      cols: 200,
    });
    // Answer gh's yes/no + "press Enter" prompts as they appear.
    void p.waitFor(/Authenticate Git with your GitHub credentials\?/i, 30_000).then((m) => m && p.write('Y\r'));
    const code = await p.waitFor(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/, 30_000);
    if (!code) {
      p.kill();
      throw new RpcError('internal', 'GitHub CLI did not show a device code', { output: p.output.slice(-500) });
    }
    void p.waitFor(/Press Enter/i, 10_000).then((m) => m && p.write('\r'));
    const id = randomUUID();
    githubLogins.set(id, p);
    setTimeout(() => {
      p.kill();
      githubLogins.delete(id);
    }, 15 * 60_000).unref();
    return { loginId: id, userCode: code[1]!, verificationUrl: 'https://github.com/login/device' };
  });

  register('setup.github.poll', z.object({ loginId: z.string() }), async ({ loginId }) => {
    const p = githubLogins.get(loginId);
    if (!p) throw new RpcError('not_found', 'Login expired; start again');
    if (p.exitCode === null) return { state: 'pending' as const };
    githubLogins.delete(loginId);
    if (p.exitCode !== 0) return { state: 'failed' as const, error: p.output.trim().split('\n').slice(-3).join('\n') };
    await run('gh', ['auth', 'setup-git'], { timeoutMs: 30_000 }).catch(() => undefined);
    const login = await fillGitIdentity();
    await githubLoggedIn(true);
    return { state: 'done' as const, ...(login ? { login } : {}) };
  });
}

/** Sets git user.name/email from the GitHub account if they aren't set yet. */
async function fillGitIdentity(): Promise<string | undefined> {
  try {
    const u = JSON.parse((await runOk('gh', ['api', 'user'], { timeoutMs: 30_000 })).stdout) as {
      login: string;
      id: number;
      name: string | null;
      email: string | null;
    };
    const name = (await run('git', ['config', '--global', 'user.name'])).stdout.trim();
    const email = (await run('git', ['config', '--global', 'user.email'])).stdout.trim();
    if (!name) await run('git', ['config', '--global', 'user.name', u.name || u.login]);
    if (!email) await run('git', ['config', '--global', 'user.email', u.email || `${u.id}+${u.login}@users.noreply.github.com`]);
    return u.login;
  } catch (err) {
    log.warn({ err }, 'could not read GitHub user');
    return undefined;
  }
}
