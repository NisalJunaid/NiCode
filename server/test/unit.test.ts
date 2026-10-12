import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Backoff, findDevice, sha256Hex } from '../src/auth.js';
import { parseStatus } from '../src/modules/git.js';
import { resolveInProject, resolveProject } from '../src/paths.js';
import { RpcError } from '../src/rpc.js';
import { LineSplitter } from '../src/util/exec.js';

describe('auth', () => {
  const tokens = [
    { id: 'd_1', name: 'phone', sha256: sha256Hex('aaa'), createdAt: '' },
    { id: 'd_2', name: 'tablet', sha256: sha256Hex('bbb'), createdAt: '' },
  ];
  it('finds the matching device', () => {
    expect(findDevice(tokens, 'bbb')?.id).toBe('d_2');
    expect(findDevice(tokens, 'nope')).toBeNull();
    expect(findDevice(tokens, undefined)).toBeNull();
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
