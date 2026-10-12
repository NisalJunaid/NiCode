import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, type KeyObject, sign as cryptoSign } from 'node:crypto';
import { authMessage, Backoff, ChallengeStore, findTokenDevice, normalizeCode, sha256Hex, verifyDeviceSignature } from '../src/auth.js';
import { parseStatus } from '../src/modules/git.js';
import { resolveInProject, resolveProject } from '../src/paths.js';
import { RpcError } from '../src/rpc.js';
import { LineSplitter } from '../src/util/exec.js';

describe('auth', () => {
  const hour = 3600_000;
  const devices = [
    { id: 'd_1', name: 'browser', sha256: sha256Hex('aaa'), createdAt: '', expiresAt: new Date(Date.now() + hour).toISOString() },
    { id: 'd_2', name: 'old', sha256: sha256Hex('bbb'), createdAt: '', expiresAt: new Date(Date.now() - 1000).toISOString() },
    { id: 'd_3', name: 'legacy permanent', sha256: sha256Hex('ccc'), createdAt: '' },
  ];
  it('accepts only unexpired tokens that have an expiry', () => {
    expect(findTokenDevice(devices, 'aaa')?.id).toBe('d_1');
    expect(findTokenDevice(devices, 'bbb')).toBeNull(); // expired
    expect(findTokenDevice(devices, 'ccc')).toBeNull(); // legacy, no expiry
    expect(findTokenDevice(devices, undefined)).toBeNull();
  });

  it.each([
    ['Ed25519', () => generateKeyPairSync('ed25519'), (k: KeyObject) => (k.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64'), null],
    ['RS256 (SPKI)', () => generateKeyPairSync('rsa', { modulusLength: 2048 }), (k: KeyObject) => (k.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64'), 'sha256'],
    ['RS256 (PKCS#1, iOS)', () => generateKeyPairSync('rsa', { modulusLength: 2048 }), (k: KeyObject) => (k.export({ format: 'der', type: 'pkcs1' }) as Buffer).toString('base64'), 'sha256'],
    ['ES256', () => generateKeyPairSync('ec', { namedCurve: 'P-256' }), (k: KeyObject) => (k.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64'), 'sha256'],
  ] as const)('verifies %s signatures and rejects tampering', (label, gen, exportPub, hash) => {
    const { publicKey, privateKey } = gen();
    const alg = label.startsWith('RS') ? 'RS256' : label === 'ES256' ? 'ES256' : 'Ed25519';
    const device = { id: 'd_k', name: 'phone', createdAt: '', alg, publicKey: exportPub(publicKey) } as const;
    const msg = authMessage('nonce123', 'd_k');
    const sig = cryptoSign(hash, Buffer.from(msg), privateKey).toString('base64');
    expect(verifyDeviceSignature({ ...device }, msg, sig)).toBe(true);
    expect(verifyDeviceSignature({ ...device }, authMessage('other', 'd_k'), sig)).toBe(false);
    expect(verifyDeviceSignature({ ...device }, msg, Buffer.from('nope').toString('base64'))).toBe(false);
  });

  it('issues single-use, expiring challenges', () => {
    const store = new ChallengeStore(1000);
    const { nonce } = store.issue(0);
    expect(store.consume(nonce, 10)).toBe(true);
    expect(store.consume(nonce, 10)).toBe(false); // replay
    const late = store.issue(0).nonce;
    expect(store.consume(late, 5000)).toBe(false); // expired
  });

  it('normalizes hand-typed pairing codes', () => {
    expect(normalizeCode(' abcde-fghjk ')).toBe('ABCDEFGHJK');
  });

  it('backs off after 5 failures', () => {
    const b = new Backoff();
    for (let i = 0; i < 5; i++) b.fail('1.2.3.4', 0);
    expect(b.blockedFor('1.2.3.4', 0)).toBe(0);
    b.fail('1.2.3.4', 0);
    expect(b.blockedFor('1.2.3.4', 0)).toBe(1000);
    b.succeed('1.2.3.4');
    expect(b.blockedFor('1.2.3.4', 0)).toBe(0);
  });
});

describe('paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nicode-paths-'));
  const project = path.join(root, 'proj');
  await mkdir(path.join(project, 'src'), { recursive: true });
  await writeFile(path.join(project, 'src', 'a.ts'), 'x');
  const outside = await mkdtemp(path.join(os.tmpdir(), 'nicode-outside-'));

  it('accepts projects inside the root and rejects others', async () => {
    const real = await resolveProject(root, project);
    expect(real.endsWith('proj')).toBe(true);
    await expect(resolveProject(root, outside)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(resolveProject(root, 'relative/path')).rejects.toBeInstanceOf(RpcError);
  });

  it('rejects escapes from the project', async () => {
    const real = await resolveProject(root, project);
    await expect(resolveInProject(real, 'src/a.ts')).resolves.toContain('a.ts');
    await expect(resolveInProject(real, 'src/new/file.ts')).resolves.toContain('file.ts');
    await expect(resolveInProject(real, '../escape')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(resolveInProject(real, '/etc/passwd')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it.skipIf(process.platform === 'win32')('rejects symlinks that point outside', async () => {
    const real = await resolveProject(root, project);
    await symlink(outside, path.join(project, 'link'));
    await expect(resolveInProject(real, 'link/secret')).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('git status parsing', () => {
  it('parses branch, ahead/behind, renames and untracked files', () => {
    const out = ['## main...origin/main [ahead 2, behind 1]', ' M src/a.ts', 'R  new.ts', 'old.ts', '?? notes.md', ''].join('\0');
    const s = parseStatus(out);
    expect(s.branch).toBe('main');
    expect(s.ahead).toBe(2);
    expect(s.behind).toBe(1);
    expect(s.files).toEqual([
      { index: ' ', workingDir: 'M', path: 'src/a.ts' },
      { index: 'R', workingDir: ' ', path: 'new.ts', renamedFrom: 'old.ts' },
      { index: '?', workingDir: '?', path: 'notes.md' },
    ]);
  });
  it('handles a fresh repo and dotted branch names', () => {
    expect(parseStatus('## No commits yet on main\0').branch).toBe('main');
    expect(parseStatus('## release.1.2\0').branch).toBe('release.1.2');
  });
});

describe('LineSplitter', () => {
  it('reassembles lines across chunks', () => {
    const s = new LineSplitter();
    expect(s.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(s.push(':2}\r\n\n')).toEqual(['{"b":2}']);
    expect(s.push('{"c":3}')).toEqual([]);
    expect(s.flush()).toEqual(['{"c":3}']);
  });
});
