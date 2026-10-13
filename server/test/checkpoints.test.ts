/**
 * Checkpoints: a snapshot before every Claude turn (HEAD, index and branches untouched), a
 * "what changed" summary after it, and rewinding files to before a turn (and undoing that).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, startDaemon, type TestDaemon, TOKEN } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let d: TestDaemon;
let c: Client;

beforeAll(async () => {
  d = await startDaemon({ claudeToken: 'sk-ant-oat01-fake', env: { NICODE_TEST_CLAUDE_SHIM: path.join(here, 'fake-claude.mjs') } });
  c = await Client.connect(d.port, TOKEN);
}, 30_000);

afterAll(() => {
  c?.close();
  d?.stop();
});

const git = (...a: string[]) => execFileSync('git', a, { cwd: d.demo, encoding: 'utf8' }).trim();
const idle = (id: string) => c.waitEvent((e: any) => e.event === 'claude.status' && e.data.sessionId === id && e.data.state === 'idle');
const summary = (id: string, turn: number) =>
  c.waitEvent((e: any) => e.event === 'claude.event' && e.data.sessionId === id && e.data.event.subtype === 'turn_summary' && e.data.event.turn === turn);

describe('checkpoints', () => {
  let id = '';
  const head0 = () => git('rev-parse', 'HEAD');
  let head = '';

  it('summarises what a turn changed, with the test result, without touching git state', async () => {
    head = head0();
    const st = await c.call('claude.start', { projectPath: d.demo, prompt: 'write-file:a.txt:hello run-tests' });
    id = st.result.sessionId;
    const s = (await summary(id, 0)).data.event;
    expect(s.files).toEqual([{ path: 'a.txt', status: 'A', add: 1, del: 0, binary: false }]);
    expect(s).toMatchObject({ totalFiles: 1, add: 1, del: 0, tests: { command: 'npm test -- --run', passed: true } });
    expect(s.from).toBe(`refs/nicode/cp/${id}/0`);
    // HEAD, the index and the branch list are unchanged; the new file is just untracked.
    expect(head0()).toBe(head);
    expect(git('diff', '--cached', '--name-only')).toBe('');
    expect(git('status', '--porcelain')).toBe('?? a.txt');
    expect(git('branch', '--list')).toBe('* main');
    const h = (await c.call('claude.history', { sessionId: id })).result;
    expect(h.events.find((e: any) => e.event.subtype === 'user_turn').event).toMatchObject({ turn: 0, checkpoint: `refs/nicode/cp/${id}/0` });
  });

  it('diffs one turn through git.diff with checkpoint refs', async () => {
    const r = (await c.call('git.diff', { projectPath: d.demo, base: `refs/nicode/cp/${id}/0`, head: `refs/nicode/cp/${id}/0-after` })).result;
    expect(r.diff).toContain('+hello');
    expect((await c.call('git.diff', { projectPath: d.demo, base: 'HEAD~1; rm -rf /' })).error.code).toBe('bad_request');
  });

  it('records failing tests and modified files on the next turn', async () => {
    await c.call('claude.send', { sessionId: id, text: 'write-file:readme.md:changed fail-tests' });
    const s = (await summary(id, 1)).data.event;
    expect(s.files.map((f: any) => [f.path, f.status])).toEqual([['readme.md', 'M']]);
    expect(s.tests.passed).toBe(false);
  });

  it('rewinds the files to before a turn, and the rewind can be undone', async () => {
    await idle(id).catch(() => undefined);
    const r = (await c.call('claude.rewind', { sessionId: id, turn: 0 })).result;
    expect(r.changed).toBe(2);
    expect(existsSync(path.join(d.demo, 'a.txt'))).toBe(false);
    expect(readFileSync(path.join(d.demo, 'readme.md'), 'utf8')).toBe('hello\n');
    expect(head0()).toBe(head);

    await c.call('claude.rewind', { sessionId: id, ref: r.undoRef });
    expect(readFileSync(path.join(d.demo, 'a.txt'), 'utf8')).toBe('hello\n');
    expect(readFileSync(path.join(d.demo, 'readme.md'), 'utf8')).toBe('changed\n');

    expect((await c.call('claude.rewind', { sessionId: id, ref: 'refs/nicode/cp/someone-else/0' })).error.code).toBe('forbidden');
    expect((await c.call('claude.rewind', { sessionId: id, turn: 99 })).error.code).toBe('not_found');
  });

  it('tells Claude about the rewind with the next message', async () => {
    c.events = [];
    await c.call('claude.send', { sessionId: id, text: 'carry on' });
    const ev = await c.waitEvent((e: any) => e.event === 'claude.event' && e.data.sessionId === id && e.data.event.type === 'assistant');
    expect(ev.data.event.message.content[0].text).toMatch(/^echo: \[niCode note: the user rewound the project files.*\n\ncarry on$/s);
  });

  it('skips checkpoints outside git', async () => {
    const plain = path.join(d.projectsRoot, 'plain');
    await mkdir(plain, { recursive: true });
    const st = await c.call('claude.start', { projectPath: plain, prompt: 'write-file:x.txt:1' });
    await idle(st.result.sessionId);
    const h = (await c.call('claude.history', { sessionId: st.result.sessionId })).result;
    expect(h.events.find((e: any) => e.event.subtype === 'user_turn').event.checkpoint).toBeNull();
    expect(h.events.some((e: any) => e.event.subtype === 'turn_summary')).toBe(false);
  });
});
