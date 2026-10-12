/**
 * Claude sessions end to end with a fake CLI (fake-claude.mjs): streaming, multi-turn,
 * permission prompts answered "from the phone", interrupt + resume, history paging.
 */
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

const ofSession = (id: string, pred: (ev: any) => boolean) => (e: any) => e.event === 'claude.event' && e.data.sessionId === id && pred(e.data.event);
const statusOf = (id: string, state: string) => (e: any) => e.event === 'claude.status' && e.data.sessionId === id && e.data.state === state;

describe('claude sessions', () => {
  let sessionId = '';
  let claudeId = '';

  it('starts a session and streams events through to the result', async () => {
    const info = (await c.call('server.info')).result;
    expect(info.setup.claude).toBe(true);
    const start = await c.call('claude.start', { projectPath: d.demo, prompt: 'hello there' });
    expect(start.result).toMatchObject({ state: 'running', title: 'hello there', permissionMode: 'default' });
    sessionId = start.result.sessionId;

    await c.waitEvent(ofSession(sessionId, (ev) => ev.type === 'nicode' && ev.subtype === 'user_turn' && ev.text === 'hello there'));
    const init = await c.waitEvent(ofSession(sessionId, (ev) => ev.type === 'system' && ev.subtype === 'init'));
    claudeId = init.data.event.session_id;
    const reply = await c.waitEvent(ofSession(sessionId, (ev) => ev.type === 'assistant'));
    expect(reply.data.event.message.content[0].text).toBe('echo: hello there');
    await c.waitEvent(ofSession(sessionId, (ev) => ev.type === 'result'));
    await c.waitEvent(statusOf(sessionId, 'idle'));
  });

  it('passes attached images to Claude as image blocks, keeping only a count in history', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
    const st = await c.call('claude.start', { projectPath: d.demo, prompt: 'what is in this picture', images: [{ mediaType: 'image/png', data: png }, { mediaType: 'image/png', data: png }] });
    const id = st.result.sessionId;
    await c.waitEvent(ofSession(id, (ev) => ev.type === 'assistant' && ev.message.content[0].text === 'echo: what is in this picture [images: 2]'));
    await c.waitEvent(statusOf(id, 'idle'));
    const h = (await c.call('claude.history', { sessionId: id })).result;
    const turn = h.events.find((e: any) => e.event.subtype === 'user_turn').event;
    expect(turn).toMatchObject({ text: 'what is in this picture', imageCount: 2 });
    expect(JSON.stringify(h)).not.toContain(png);
    const bad = await c.call('claude.send', { sessionId: id, text: 'x', images: [{ mediaType: 'image/png', data: 'not base64!!' }] });
    expect(bad.error).toBeTruthy();
  });

  it('keeps the same process for the next turn', async () => {
    c.events = [];
    expect((await c.call('claude.send', { sessionId, text: 'second' })).result.ok).toBe(true);
    const res = await c.waitEvent(ofSession(sessionId, (ev) => ev.type === 'result'));
    expect(res.data.event.result).toBe('done 2'); // turn counter survived => same process
  });

  it('asks the phone for permission and passes the answer back to Claude', async () => {
    c.events = [];
    await c.call('claude.send', { sessionId, text: 'please needs-permission' });
    const req = await c.waitEvent((e) => e.event === 'claude.permission.request' && e.data.sessionId === sessionId);
    expect(req.data).toMatchObject({ toolName: 'Write', input: { file_path: 'x.txt' } });
    await c.waitEvent(statusOf(sessionId, 'awaiting_permission'));
    expect((await c.call('claude.permission.pending')).result).toHaveLength(1);

    expect((await c.call('claude.permission.respond', { requestId: req.data.requestId, behavior: 'allow' })).result.ok).toBe(true);
    const said = await c.waitEvent(ofSession(sessionId, (ev) => ev.type === 'assistant' && ev.message.content[0].text === 'approved'));
    expect(said).toBeTruthy();
    await c.waitEvent((e) => e.event === 'claude.permission.resolved' && e.data.behavior === 'allow');
    await c.waitEvent(ofSession(sessionId, (ev) => ev.type === 'result'));
  });

  it('denies with a reason', async () => {
    c.events = [];
    await c.call('claude.send', { sessionId, text: 'again needs-permission' });
    const req = await c.waitEvent((e) => e.event === 'claude.permission.request');
    await c.call('claude.permission.respond', { requestId: req.data.requestId, behavior: 'deny', message: 'not now' });
    const tr = await c.waitEvent(ofSession(sessionId, (ev) => ev.type === 'user'));
    expect(tr.data.event.message.content[0]).toMatchObject({ is_error: true, content: 'denied: not now' });
  });

  it('interrupts a running turn and resumes the conversation on the next message', async () => {
    c.events = [];
    await c.call('claude.send', { sessionId, text: 'slow task' });
    await c.waitEvent(statusOf(sessionId, 'running'));
    expect((await c.call('claude.send', { sessionId, text: 'too soon' })).error.code).toBe('busy');
    await c.call('claude.interrupt', { sessionId });
    await c.waitEvent(ofSession(sessionId, (ev) => ev.type === 'nicode' && ev.subtype === 'interrupted'));
    await c.waitEvent(statusOf(sessionId, 'idle'));

    c.events = [];
    await c.call('claude.send', { sessionId, text: 'after interrupt' });
    const init = await c.waitEvent(ofSession(sessionId, (ev) => ev.type === 'system' && ev.subtype === 'init'));
    expect(init.data.event.resumed).toBe(true);
    // Resumed with Claude's own conversation id (the daemon's id stays stable for the app).
    expect(init.data.event.session_id).toBe(claudeId);
    const r = await c.waitEvent(ofSession(sessionId, (ev) => ev.type === 'result'));
    expect(r.data.event.result).toBe('done 1'); // new process, resumed conversation
  });

  it('serves history and lists sessions per project', async () => {
    const all = (await c.call('claude.history', { sessionId })).result;
    expect(all.events.length).toBe(all.lastSeq);
    expect(all.events.map((e: any) => e.seq)).toEqual([...Array(all.lastSeq).keys()].map((i) => i + 1));
    const tail = (await c.call('claude.history', { sessionId, sinceSeq: all.lastSeq - 2 })).result;
    expect(tail.events).toHaveLength(2);
    const list = (await c.call('claude.list', { projectPath: d.demo })).result;
    expect(list.map((s: any) => s.sessionId)).toContain(sessionId);
    expect(list[0]).not.toHaveProperty('claudeSessionId');
  });

  it('switches permission mode for the next turn', async () => {
    const r = (await c.call('claude.setMode', { sessionId, permissionMode: 'acceptEdits' })).result;
    expect(r.permissionMode).toBe('acceptEdits');
    c.events = [];
    await c.call('claude.send', { sessionId, text: 'with new mode' });
    const init = await c.waitEvent(ofSession(sessionId, (ev) => ev.type === 'system' && ev.subtype === 'init'));
    expect(init.data.event.permissionMode).toBe('acceptEdits');
    await c.waitEvent(ofSession(sessionId, (ev) => ev.type === 'result'));
  });
});
