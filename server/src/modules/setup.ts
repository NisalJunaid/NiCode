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
    return { loginId: id, url: m[0] };
  });

  register('setup.claudeLogin.submit', z.object({ loginId: z.string(), code: z.string().min(4).max(4096), label: Label, activate: z.boolean().optional() }), async ({ loginId, code, label, activate }) => {
    if (!claudeLogin || claudeLogin.id !== loginId) throw new RpcError('not_found', 'Login expired; start again');
    const p = claudeLogin.pty;
    p.write(code.trim() + '\r');
    const m = await p.waitFor(TOKEN_RE, 60_000);
    p.kill();
    claudeLogin = null;
    if (!m) throw new RpcError('bad_request', 'Claude did not accept the code', { output: maskSecrets(p.output.slice(-500)) });
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
