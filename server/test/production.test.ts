/**
 * Production servers and Analyze chats through a real daemon (fake Claude CLI), plus safe pulls
 * and deploys. The kernel sandbox isn't available on CI/Windows, so production tests opt into soft
 * isolation with NICODE_TEST_SOFT_ANALYZE; the sandbox itself is checked on a real server.
 */
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, startDaemon, type TestDaemon, TOKEN } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const shim = path.join(here, 'fake-claude.mjs');
const ofSession = (id: string, pred: (ev: any) => boolean) => (e: any) => e.event === 'claude.event' && e.data.sessionId === id && pred(e.data.event);
const idle = (id: string) => (e: any) => e.event === 'claude.status' && e.data.sessionId === id && e.data.state === 'idle';
const refs = (dir: string) => execFileSync('git', ['for-each-ref', '--format=%(refname)'], { cwd: dir }).toString();

describe('production server', () => {
  let d: TestDaemon;
  let c: Client;

  beforeAll(async () => {
    d = await startDaemon({
      claudeToken: 'sk-ant-oat01-fake',
      config: { role: 'production' },
      env: { NICODE_TEST_CLAUDE_SHIM: shim, NICODE_TEST_SOFT_ANALYZE: '1', NICODE_TEST_DB_VERIFY: '1' },
    });
    c = await Client.connect(d.port, TOKEN);
  }, 30_000);

  afterAll(() => {
    c?.close();
    d?.stop();
  });

  it('reports the role and offers only Analyze', async () => {
    const info = (await c.call('server.info')).result;
    expect(info).toMatchObject({ role: 'production', permissionModes: ['analyze'], analyzeBlocked: null, isRoot: false });
    expect(['kernel', 'soft']).toContain(info.analyzeIsolation);
  });

  it('refuses writing modes', async () => {
    const r = await c.call('claude.start', { projectPath: d.demo, prompt: 'fix it', permissionMode: 'default' });
    expect(r.error).toMatchObject({ code: 'bad_request' });
    expect(r.error.message).toMatch(/production/);
  });

  let sessionId = '';
  it('starts Analyze chats by default, read-only, with their own Claude state and the read-only DB', async () => {
    await c.call('analyze.db.set', { projectPath: d.demo, url: 'postgres://ro:secret@127.0.0.1:5432/shop' });
    const info = (await c.call('analyze.db.get', { projectPath: d.demo })).result;
    expect(info).toMatchObject({ kind: 'postgres', database: 'shop', user: 'ro' });
    expect(JSON.stringify(info)).not.toContain('secret');

    const st = await c.call('claude.start', { projectPath: d.demo, prompt: 'why does checkout fail' });
    expect(st.error).toBeUndefined();
    expect(st.result.permissionMode).toBe('analyze');
    sessionId = st.result.sessionId;
    const init = await c.waitEvent(ofSession(sessionId, (ev) => ev.type === 'system' && ev.subtype === 'init'));
    expect(init.data.event.disallowedTools).toBe('Edit,Write,MultiEdit,NotebookEdit');
    expect(init.data.event.appendedPrompt).toMatch(/ANALYZE mode/);
    expect(init.data.event.readonlyDb).toBe('shop');
    expect(init.data.event.claudeConfigDir).toMatch(/analyze-claude$/);
    await c.waitEvent(idle(sessionId));
    expect(refs(d.demo)).not.toContain('refs/nicode/cp'); // no checkpoints in Analyze chats
  });

  it('refuses edits and git writes without asking the phone', async () => {
    c.events = [];
    await c.call('claude.send', { sessionId, text: 'needs-permission' });
    await c.waitEvent(ofSession(sessionId, (ev) => ev.type === 'assistant' && ev.message.content[0].text === 'was denied'));
    await c.waitEvent(idle(sessionId));
    c.events = [];
    await c.call('claude.send', { sessionId, text: 'needs-bash: git stash' });
    const r = await c.waitEvent(ofSession(sessionId, (ev) => ev.type === 'assistant' && String(ev.message.content[0].text).startsWith('bash ')));
    expect(r.data.event.message.content[0].text).toMatch(/bash denied: .*read-only/);
    expect(c.events.some((e) => e.event === 'claude.permission.request')).toBe(false);
    await c.waitEvent(idle(sessionId));
  });

  it('asks for other commands, without "always allow"', async () => {
    c.events = [];
    await c.call('claude.send', { sessionId, text: 'needs-bash: tail -n 50 app.log' });
    const req = await c.waitEvent((e) => e.event === 'claude.permission.request');
    expect(req.data.canRemember).toBe(false);
    await c.call('claude.permission.respond', { requestId: req.data.requestId, behavior: 'allow', remember: true });
    await c.waitEvent(idle(sessionId));
    c.events = [];
    await c.call('claude.send', { sessionId, text: 'needs-bash: tail -n 50 app.log' });
    await c.waitEvent((e) => e.event === 'claude.permission.request'); // asked again: nothing was remembered
    const pending = (await c.call('claude.permission.pending')).result;
    await c.call('claude.permission.respond', { requestId: pending[0].requestId, behavior: 'deny' });
    await c.waitEvent(idle(sessionId));
  });

  it('reports a repository change during an analysis', async () => {
    c.events = [];
    // The fake CLI writes directly (as if something outside the sandbox did).
    await c.call('claude.send', { sessionId, text: 'write-file:sneaky.txt:x' });
    const ev = await c.waitEvent(ofSession(sessionId, (e) => e.type === 'nicode' && e.subtype === 'repo_changed'));
    expect(ev.data.event.changes).toContain('working tree: ?? sneaky.txt');
    execFileSync('git', ['clean', '-fdq'], { cwd: d.demo });
  });

  it('keeps Analyze chats from being switched or rewound', async () => {
    expect((await c.call('claude.setMode', { sessionId, permissionMode: 'acceptEdits' })).error).toBeTruthy();
    expect((await c.call('claude.rewind', { sessionId, turn: 0 })).error).toMatchObject({ code: 'forbidden' });
  });

  it('needs a fingerprint to leave production, run migrations or discard changes', async () => {
    expect((await c.call('server.setRole', { role: 'development' })).error).toMatchObject({ code: 'forbidden' });
    await writeFile(path.join(d.demo, 'artisan'), '');
    expect((await c.call('tasks.run', { projectPath: d.demo, taskId: 'artisan-migrate' })).error).toMatchObject({ code: 'forbidden' });
    expect((await c.call('deploy.run', { projectPath: d.demo, steps: { pull: false, install: false, build: false, migrate: true, restart: false } })).error).toMatchObject({ code: 'forbidden' });
    expect((await c.call('git.pull', { projectPath: d.demo, onDirty: 'discard' })).error).toMatchObject({ code: 'forbidden' });
  });
});

describe('development server: Analyze, role switch and deploys', () => {
  let d: TestDaemon;
  let c: Client;
  let upstream = '';

  beforeAll(async () => {
    d = await startDaemon({ claudeToken: 'sk-ant-oat01-fake', env: { NICODE_TEST_CLAUDE_SHIM: shim } });
    c = await Client.connect(d.port, TOKEN);
    // A remote with one new commit, so there is something to pull.
    const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'pipe' });
    const bare = path.join(d.tmp, 'origin.git');
    git(d.tmp, 'clone', '-q', '--bare', d.demo, bare);
    git(d.demo, 'remote', 'add', 'origin', bare);
    git(d.demo, 'fetch', '-q', 'origin');
    git(d.demo, 'branch', '-q', '-u', 'origin/main');
    upstream = path.join(d.tmp, 'other');
    git(d.tmp, 'clone', '-q', bare, upstream);
    git(upstream, 'config', 'user.email', 't@example.com');
    git(upstream, 'config', 'user.name', 'T');
    await writeFile(path.join(upstream, 'feature.txt'), 'new\n');
    git(upstream, 'add', '.');
    git(upstream, 'commit', '-q', '-m', 'add feature');
    git(upstream, 'push', '-q');
  }, 30_000);

  afterAll(() => {
    c?.close();
    d?.stop();
  });

  it('offers Analyze next to the writing modes, and keeps "always allow" there separate', async () => {
    const info = (await c.call('server.info')).result;
    expect(info.role).toBe('development');
    expect(info.permissionModes).toContain('default');
    expect(info.permissionModes).toContain('analyze');
  });

  it('turns every chat into an Analyze chat when the server becomes production', async () => {
    const st = await c.call('claude.start', { projectPath: d.demo, prompt: 'hello' });
    await c.waitEvent(idle(st.result.sessionId));
    expect((await c.call('server.setRole', { role: 'production' })).result).toEqual({ role: 'production' });
    const list = (await c.call('claude.list', { projectPath: d.demo })).result;
    expect(list.find((s: any) => s.sessionId === st.result.sessionId).permissionMode).toBe('analyze');
    const cfg = JSON.parse(await readFile(d.cfgPath, 'utf8'));
    expect(cfg.role).toBe('production');
  });

  it('shows what a pull would do', async () => {
    // Back to development through the config file, like `nicode role development` does.
    const cfg = JSON.parse(await readFile(d.cfgPath, 'utf8'));
    await writeFile(d.cfgPath, JSON.stringify({ ...cfg, role: 'development' }));
    await c.waitEvent((e) => e.event === 'server.role' && e.data.role === 'development');
    const pf = (await c.call('git.pullPreflight', { projectPath: d.demo })).result;
    expect(pf).toMatchObject({ branch: 'main', upstream: 'origin/main', behind: 1, ahead: 0, dirty: [], fetchError: null });
    expect(pf.incoming[0].subject).toBe('add feature');
  });

  it('never pulls over local changes; stashes them when asked', async () => {
    await writeFile(path.join(d.demo, 'readme.md'), 'local edit\n');
    const r = await c.call('git.pull', { projectPath: d.demo });
    expect(r.error).toMatchObject({ code: 'dirty' });
    expect(r.error.data.dirty).toEqual([' M readme.md']);
    const dep = await c.call('deploy.run', { projectPath: d.demo, steps: { pull: true, install: false, build: false, migrate: false, restart: false } });
    expect(dep.error).toMatchObject({ code: 'dirty' });

    const ok = await c.call('deploy.run', { projectPath: d.demo, onDirty: 'stash', opId: 'dep1', steps: { pull: true, install: false, build: false, migrate: false, restart: false } });
    expect(ok.result.ok).toBe(true);
    expect(ok.result.after).not.toBe(ok.result.before);
    expect(await readFile(path.join(d.demo, 'feature.txt'), 'utf8')).toMatch(/^new\r?\n$/);
    expect(execFileSync('git', ['stash', 'list'], { cwd: d.demo }).toString()).toMatch(/nicode: before pull/);
    expect(c.events.some((e) => e.event === 'tasks.step' && e.data.opId === 'dep1' && e.data.step === 'pull' && e.data.status === 'done')).toBe(true);

    const hist = (await c.call('deploy.history', { projectPath: d.demo })).result;
    expect(hist[0]).toMatchObject({ ok: true, device: 'test phone' });
  });

  it('plans a deploy', async () => {
    const plan = (await c.call('deploy.plan', { projectPath: d.demo })).result;
    expect(plan).toMatchObject({ production: false, install: [], build: null, migrate: null, apps: [] });
    expect(plan.pull.behind).toBe(0);
    expect(plan.defaults).toMatchObject({ pull: true, install: false, build: false, migrate: false, restart: false });
  });
});
