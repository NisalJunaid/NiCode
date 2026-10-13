/**
 * Commit history + restore to a commit: preview, both modes, the backup/undo safety net, and
 * the step-up confirmation (signed by the phone key, single use, bound to the exact action).
 */
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authMessage, confirmMessage, signatureHeader } from '../../protocol/types.js';
import { Client, sha, startDaemon, type TestDaemon, TOKEN } from './helpers.js';

let d: TestDaemon;
let phone: Client;
let browser: Client;
const key = generateKeyPairSync('ed25519');
const pub = (key.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64');
const deviceId = `d_${sha(pub).slice(0, 8)}`;
const commits: Record<string, string> = {};
let project = '';

const git = (...a: string[]) => execFileSync('git', a, { cwd: d.demo, encoding: 'utf8' }).trim();
const file = (f: string) => path.join(d.demo, f);
const commit = (name: string, edit: () => void) => {
  edit();
  git('add', '-A');
  git('commit', '-q', '-m', name);
  commits[name] = git('rev-parse', 'HEAD');
};

async function proof(action: string, fields: string[], c = phone) {
  const { nonce } = (await c.call('auth.confirmChallenge', {})).result;
  return { nonce, sig: sign(null, Buffer.from(confirmMessage(nonce, action, fields)), key.privateKey).toString('base64') };
}

beforeAll(async () => {
  d = await startDaemon();
  const cfg = JSON.parse(await readFile(d.cfgPath, 'utf8'));
  cfg.devices.push({ id: deviceId, name: 'Pixel', createdAt: new Date().toISOString(), alg: 'Ed25519', publicKey: pub });
  await writeFile(d.cfgPath, JSON.stringify(cfg));
  await new Promise((r) => setTimeout(r, 500)); // config watcher reload
  const { nonce } = (await (await fetch(`http://127.0.0.1:${d.port}/auth/challenge`)).json()) as { nonce: string };
  phone = await Client.connectWith(d.port, signatureHeader(deviceId, nonce, sign(null, Buffer.from(authMessage(nonce, deviceId)), key.privateKey).toString('base64')));
  browser = await Client.connect(d.port, TOKEN);
  project = d.demo; // proofs sign the projectPath string exactly as sent
  commit('add a', () => writeFileSync(file('a.txt'), '1\n'));
  commit('change readme', () => writeFileSync(file('readme.md'), 'two\n'));
  commit('add b', () => writeFileSync(file('b.txt'), 'b\n'));
}, 30_000);

afterAll(() => {
  phone?.close();
  browser?.close();
  d?.stop();
});

describe('history', () => {
  it('lists commits with refs and shows one', async () => {
    const log = (await phone.call('git.log', { projectPath: d.demo, limit: 10 })).result;
    expect(log.map((c: any) => c.message)).toEqual(['add b', 'change readme', 'add a', 'init']);
    expect(log[0].refs).toContain('HEAD -> main');
    expect(log[0].pushed).toBeNull(); // no upstream
    expect((await phone.call('git.log', { projectPath: d.demo, limit: 2, skip: 2 })).result.map((c: any) => c.message)).toEqual(['add a', 'init']);
    const show = (await phone.call('git.show', { projectPath: d.demo, hash: commits['change readme']!.slice(0, 8) })).result;
    expect(show.files).toEqual([{ path: 'readme.md', status: 'M', add: 1, del: 1, binary: false }]);
    expect((await phone.call('git.show', { projectPath: d.demo, hash: 'deadbeef' })).error.code).toBe('not_found');
  });

  it('previews what a restore would do', async () => {
    const p = (await phone.call('git.restorePreview', { projectPath: d.demo, hash: commits['add a'] })).result;
    expect(p).toMatchObject({ subject: 'add a', commitsAfter: 2, totalFiles: 2, dirty: false, isAncestor: true, pushedAfter: false, busy: false });
    expect(p.files.map((f: any) => [f.path, f.status])).toEqual([
      ['b.txt', 'D'],
      ['readme.md', 'M'],
    ]);
  });

  it('refuses without a valid, fresh, matching confirmation', async () => {
    const h = commits['add a']!;
    expect((await phone.call('git.restoreTo', { projectPath: d.demo, hash: h, mode: 'commit' })).error.code).toBe('bad_request');
    const wrong = await proof('git.restoreTo', [project, h, 'reset']); // signed for another mode
    expect((await phone.call('git.restoreTo', { projectPath: d.demo, hash: h, mode: 'commit', proof: wrong })).error.code).toBe('forbidden');
    const fromBrowser = await proof('git.restoreTo', [project, h, 'commit'], browser);
    expect((await browser.call('git.restoreTo', { projectPath: d.demo, hash: h, mode: 'commit', proof: fromBrowser })).error.code).toBe('forbidden');
    expect(git('rev-parse', 'HEAD')).toBe(commits['add b']);
  });

  let backupRef = '';
  it('restores the code as a new commit, backing up uncommitted work first', async () => {
    writeFileSync(file('a.txt'), 'dirty\n');
    writeFileSync(file('c.txt'), 'untracked\n');
    const h = commits['add a']!;
    const pr = await proof('git.restoreTo', [project, h, 'commit']);
    const r = (await phone.call('git.restoreTo', { projectPath: d.demo, hash: h, mode: 'commit', proof: pr })).result;
    backupRef = r.backupRef;
    expect(r).toMatchObject({ removedCommits: 0, needsForcePush: false });
    expect(git('log', '-1', '--format=%s')).toMatch(/^Restore code to [0-9a-f]{7}: add a$/);
    expect(git('rev-parse', 'HEAD~1')).toBe(commits['add b']); // history kept
    expect(readFileSync(file('readme.md'), 'utf8')).toBe('hello\n');
    expect(readFileSync(file('a.txt'), 'utf8')).toBe('1\n');
    expect(existsSync(file('b.txt'))).toBe(false);
    expect(existsSync(file('c.txt'))).toBe(true); // untracked files are left alone
    expect((await phone.call('git.restoreTo', { projectPath: d.demo, hash: h, mode: 'commit', proof: pr })).error.code).toBe('forbidden'); // single use
  });

  it('undoes a restore, bringing back the uncommitted work', async () => {
    const pr = await proof('git.undoRestore', [project, backupRef]);
    const r = (await phone.call('git.undoRestore', { projectPath: d.demo, backupRef, proof: pr })).result;
    expect(r.head).toBe(commits['add b']);
    expect(git('rev-parse', 'HEAD')).toBe(commits['add b']);
    expect(readFileSync(file('a.txt'), 'utf8')).toBe('dirty\n');
    expect(readFileSync(file('b.txt'), 'utf8')).toBe('b\n');
    const list = (await phone.call('git.backups', { projectPath: d.demo })).result;
    expect(list[0]).toMatchObject({ ref: backupRef, head: commits['add b'], subject: 'add b', hadUncommitted: true });
  });

  it('resets the branch back (rewriting history) and can undo that too', async () => {
    git('checkout', '-q', '--', '.');
    const h = commits['add a']!;
    const r = (await phone.call('git.restoreTo', { projectPath: d.demo, hash: h, mode: 'reset', proof: await proof('git.restoreTo', [project, h, 'reset']) })).result;
    expect(r).toMatchObject({ head: h, removedCommits: 2, needsForcePush: false });
    expect(git('rev-parse', 'HEAD')).toBe(h);
    await phone.call('git.undoRestore', { projectPath: d.demo, backupRef: r.backupRef, proof: await proof('git.undoRestore', [project, r.backupRef]) });
    expect(git('rev-parse', 'HEAD')).toBe(commits['add b']);
  });
});
