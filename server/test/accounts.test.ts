/** Claude accounts: adopt the existing login, add, switch, rename, log out; tokens never leave the server. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, startDaemon, type TestDaemon, TOKEN } from './helpers.js';

let d: TestDaemon;
let c: Client;
const T1 = 'sk-ant-oat01-first-account-token-aaaa';
const T2 = 'sk-ant-oat01-second-account-token-bbbb';
const envToken = async () => /CLAUDE_CODE_OAUTH_TOKEN=(.*)/.exec(await readFile(path.join(d.tmp, 'env'), 'utf8'))?.[1] ?? null;

beforeAll(async () => {
  d = await startDaemon({ claudeToken: T1, env: { NICODE_TEST_CLAUDE_VERIFY: '1' } });
  c = await Client.connect(d.port, TOKEN);
}, 30_000);

afterAll(() => {
  c?.close();
  d?.stop();
});

describe('claude accounts', () => {
  let first = '';
  let second = '';

  it('adopts the login that was already there', async () => {
    const { accounts } = (await c.call('setup.claudeAccounts.list', {})).result;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ label: 'Account 1', kind: 'token', active: true, hint: '…aaaa' });
    expect(JSON.stringify(accounts)).not.toContain(T1);
    first = accounts[0].id;
  });

  it('adds a second account and switches to it', async () => {
    const r = (await c.call('setup.claudeLogin.setToken', { token: T2, label: 'Work' })).result;
    second = r.accountId;
    expect(await envToken()).toBe(T2);
    const { accounts } = (await c.call('setup.claudeAccounts.list', {})).result;
    expect(accounts.map((a: any) => [a.label, a.active])).toEqual([
      ['Account 1', false],
      ['Work', true],
    ]);
  });

  it('switches back and renames', async () => {
    await c.call('setup.claudeAccounts.switch', { id: first });
    expect(await envToken()).toBe(T1);
    const { accounts } = (await c.call('setup.claudeAccounts.rename', { id: first, label: 'Personal' })).result;
    expect(accounts.find((a: any) => a.id === first)).toMatchObject({ label: 'Personal', active: true });
    expect((await c.call('setup.claudeAccounts.switch', { id: 'nope' })).error.code).toBe('not_found');
  });

  it('logging out of the active account hands over to the other one, then to "logged out"', async () => {
    const r = (await c.call('setup.claudeAccounts.logout', { id: first })).result;
    expect(r.switchedTo).toBe(second);
    expect(await envToken()).toBe(T2);
    const r2 = (await c.call('setup.claudeAccounts.logout', { id: second })).result;
    expect(r2).toEqual({ accounts: [], switchedTo: null });
    expect(await envToken()).toBeNull();
    expect((await c.call('server.info', {})).result.setup.claude).toBe(false);
    expect((await c.call('claude.list', {})).error.code).toBe('setup_required');
  });
});
