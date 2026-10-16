/**
 * Unit tests for the security fixes and the Analyze / production building blocks:
 * permission rules, rate limits, the sandbox helpers, repo fingerprints, read-only DB checks
 * and migration detection.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrations } from '../src/apps/catalog.js';
import { RateLimit } from '../src/auth.js';
import { analyzeRefusal, bashRulePrefix } from '../src/claude/permissions.js';
import { diffFingerprints, repoFingerprint } from '../src/claude/repoGuard.js';
import { parseMountInfo, projectViews, redactEnv } from '../src/claude/sandbox.js';
import { detectDb, mysqlGrantProblems, parseDbUrl, suggestionFor } from '../src/modules/analyzeDb.js';

describe('"always allow" rules for Bash', () => {
  it('never auto-allows chained, multi-line or substituted commands', () => {
    expect(bashRulePrefix('ls -la')).toBe('ls');
    expect(bashRulePrefix('ls\nrm -rf ~')).toBeNull();
    expect(bashRulePrefix('ls\rrm -rf ~')).toBeNull();
    expect(bashRulePrefix('ls && rm x')).toBeNull();
    expect(bashRulePrefix('ls $(rm x)')).toBeNull();
    expect(bashRulePrefix('ls `rm x`')).toBeNull();
    expect(bashRulePrefix('ls (x)')).toBeNull();
    expect(bashRulePrefix('cat a > b')).toBeNull();
  });

  it('never remembers command runners', () => {
    for (const c of ['sudo ls', 'bash -c "rm x"', 'env FOO=1 rm x', 'xargs rm', 'find . -delete', 'FOO=1 rm x', './script.sh', '/bin/rm x', 'timeout 5 rm x']) {
      expect(bashRulePrefix(c)).toBeNull();
    }
  });

  it('keeps the subcommand for multi-purpose tools', () => {
    expect(bashRulePrefix('git status')).toBe('git status');
    expect(bashRulePrefix('git push --force')).toBe('git push');
    expect(bashRulePrefix('npm test -- --run')).toBe('npm test');
    expect(bashRulePrefix('git --no-pager log')).toBeNull();
    expect(bashRulePrefix('git')).toBeNull();
  });
});

describe('Analyze refusals', () => {
  it('refuses writing tools and git commands that change the repository', () => {
    expect(analyzeRefusal('Edit', {})).toMatch(/read-only/);
    expect(analyzeRefusal('Write', {})).toMatch(/read-only/);
    for (const cmd of ['git commit -m x', 'git stash', 'git checkout -b t', 'cd x && git reset --hard', 'git -C . pull', 'sudo git clean -fd', 'git branch -D main']) {
      expect(analyzeRefusal('Bash', { command: cmd }), cmd).toMatch(/git/);
    }
    for (const cmd of ['git log -5', 'git status', 'git diff HEAD~1', 'git show abc', 'git blame a.ts', 'git branch -a', 'tail -n 100 storage/logs/laravel.log']) {
      expect(analyzeRefusal('Bash', { command: cmd }), cmd).toBeNull();
    }
    expect(analyzeRefusal('Read', { file_path: 'a' })).toBeNull();
  });
});

describe('rate limit', () => {
  it('allows N per window per key', () => {
    const rl = new RateLimit(3, 60_000);
    const t = 1_000_000;
    expect([1, 2, 3, 4].map(() => rl.take('a', t))).toEqual([true, true, true, false]);
    expect(rl.take('b', t)).toBe(true);
    expect(rl.take('a', t + 60_001)).toBe(true);
  });
});

describe('sandbox helpers', () => {
  it('masks secrets in .env files', () => {
    const out = redactEnv(['APP_NAME=Shop', 'DB_PASSWORD=hunter2', 'APP_KEY=base64:abc', 'export STRIPE_SECRET="sk_live_x"', 'DATABASE_URL=postgres://app:pw@db:5432/shop', 'EMPTY=', '# DB_PASSWORD=x'].join('\n'));
    expect(out).toContain('APP_NAME=Shop');
    expect(out).toContain('DB_PASSWORD=<redacted by niCode>');
    expect(out).toContain('APP_KEY=<redacted by niCode>');
    expect(out).toContain('export STRIPE_SECRET=<redacted by niCode>');
    expect(out).toContain('DATABASE_URL=postgres://app:<redacted>@db:5432/shop');
    expect(out).toContain('EMPTY=');
    expect(out).not.toMatch(/hunter2|sk_live_x|:pw@/);
  });

  it('finds every mount that shows the project', () => {
    const mounts = parseMountInfo(
      [
        '22 1 8:1 / / rw - ext4 /dev/sda1 rw',
        '40 22 8:2 / /home rw - ext4 /dev/sda2 rw',
        '41 22 8:2 /dev/projects /var/www rw - ext4 /dev/sda2 rw', // /home/dev/projects also at /var/www
        '42 22 8:2 /dev/projects/shop/storage /srv/shop\\040storage rw - ext4 /dev/sda2 rw', // a folder inside the project
        '43 22 8:3 / /data rw - ext4 /dev/sda3 rw',
      ].join('\n'),
    );
    expect(mounts[3]!.mountPoint).toBe('/srv/shop storage');
    expect(projectViews('/home/dev/projects/shop', mounts, () => true)).toEqual(['/home/dev/projects/shop', '/srv/shop storage', '/var/www/shop']);
    // A project on the root filesystem with no other views.
    expect(projectViews('/opt/app', mounts, () => true)).toEqual(['/opt/app']);
  });
});

describe('repository fingerprints', () => {
  it('reports commits, stashes and working-tree changes, but not fetches', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'nicode-fp-'));
    const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    await writeFile(path.join(dir, 'a.txt'), '1\n');
    git('add', '.');
    git('commit', '-q', '-m', 'one');
    const a = (await repoFingerprint(dir))!;
    expect(diffFingerprints(a, (await repoFingerprint(dir))!)).toEqual([]);

    git('update-ref', 'refs/remotes/origin/main', 'HEAD'); // what a fetch does
    git('update-ref', 'refs/nicode/cp/s/1', 'HEAD'); // another chat's checkpoint
    expect(diffFingerprints(a, (await repoFingerprint(dir))!)).toEqual([]);

    await writeFile(path.join(dir, 'a.txt'), '2\n');
    await writeFile(path.join(dir, 'new.txt'), 'x\n');
    const b = (await repoFingerprint(dir))!;
    expect(diffFingerprints(a, b)).toEqual(['working tree: M a.txt', 'working tree: ?? new.txt']);

    git('stash', '-u');
    const c = (await repoFingerprint(dir))!;
    expect(diffFingerprints(a, c).join('\n')).toMatch(/stashes: 0 → 1/);

    git('commit', '-q', '--allow-empty', '-m', 'two');
    expect(diffFingerprints(a, (await repoFingerprint(dir))!).join('\n')).toMatch(/HEAD \w{7} → \w{7}/);
  });
});

describe('read-only database users', () => {
  it('parses URLs', () => {
    expect(parseDbUrl('postgresql://ro:p%40ss@127.0.0.1/shop')).toEqual({ kind: 'postgres', host: '127.0.0.1', port: 5432, database: 'shop', user: 'ro', password: 'p@ss' });
    expect(parseDbUrl('mysql://ro:x@db:3307/shop').port).toBe(3307);
    expect(() => parseDbUrl('redis://x')).toThrow();
    expect(() => parseDbUrl('postgres://ro:x@host/')).toThrow();
  });

  it('detects the database from .env and suggests SQL', () => {
    expect(detectDb({ DB_CONNECTION: 'pgsql', DB_HOST: '127.0.0.1', DB_DATABASE: 'shop', DB_USERNAME: 'shop' })).toMatchObject({ kind: 'postgres', database: 'shop', appUser: 'shop', port: 5432 });
    expect(detectDb({ DATABASE_URL: 'mysql://app:pw@localhost:3306/blog' })).toMatchObject({ kind: 'mysql', database: 'blog' });
    expect(detectDb({ APP_NAME: 'x' })).toBeNull();

    const pg = suggestionFor({ DB_CONNECTION: 'pgsql', DB_DATABASE: 'shop', DB_USERNAME: 'shop' });
    expect(pg.kind).toBe('postgres');
    expect(pg.sql).toContain('default_transaction_read_only = on');
    expect(pg.sql).toContain('GRANT SELECT ON ALL TABLES IN SCHEMA public TO "nicode_ro_shop"');
    expect(pg.sql).toContain('FOR ROLE "shop"');
    expect(pg.url).toMatch(/^postgres:\/\/nicode_ro_shop:[\w-]+@127\.0\.0\.1:5432\/shop$/);
    const my = suggestionFor({ DB_CONNECTION: 'mysql', DB_DATABASE: 'blog' });
    expect(my.sql).toContain("GRANT SELECT, SHOW VIEW ON `blog`.* TO 'nicode_ro_blog'@'localhost'");
    expect(suggestionFor({}).kind).toBeNull();
  });

  it('rejects MySQL users that can write', () => {
    expect(mysqlGrantProblems(['GRANT USAGE ON *.* TO `ro`@`localhost`', 'GRANT SELECT, SHOW VIEW ON `blog`.* TO `ro`@`localhost`'])).toEqual([]);
    expect(mysqlGrantProblems(['GRANT ALL PRIVILEGES ON `blog`.* TO `app`@`%`'])).toEqual(['has ALL PRIVILEGES']);
    expect(mysqlGrantProblems(['GRANT SELECT, INSERT ON `blog`.* TO `x`@`%`'])).toEqual(['has INSERT']);
    expect(mysqlGrantProblems(['GRANT `admin`@`%` TO `x`@`%`'])).toHaveLength(1);
  });
});

describe('migration detection', () => {
  const project = async (files: Record<string, string>) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'nicode-mig-'));
    for (const [f, c] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, f)), { recursive: true });
      await writeFile(path.join(dir, f), c);
    }
    return dir;
  };

  it('finds Laravel, Prisma, Django and npm-script migrations', async () => {
    const laravel = migrations(await project({ artisan: '' }))[0]!;
    expect(laravel.run.command).toBe('php artisan migrate --force');
    expect(laravel.pending('  2024_01_01_000000_create_users ........ [1] Ran\n  2025_01_01_000000_add_x ........ Pending\n')).toBe(1);

    const prisma = migrations(await project({ 'prisma/schema.prisma': '' }))[0]!;
    expect(prisma.run.command).toBe('npx prisma migrate deploy');
    expect(prisma.pending('Database schema is up to date!')).toBe(0);
    expect(prisma.pending('Following migrations have not yet been applied:\n2 migrations found in prisma/migrations have not yet been applied')).toBe(2);

    const django = migrations(await project({ 'manage.py': '' }))[0]!;
    expect(django.run.args).toEqual(['manage.py', 'migrate', '--noinput']);
    expect(django.pending('[X]  auth.0001_initial\n[ ]  shop.0002_add_price\n')).toBe(1);

    const npm = migrations(await project({ 'package.json': JSON.stringify({ scripts: { 'db:migrate': 'knex migrate:latest' } }) }))[0]!;
    expect(npm.run.id).toBe('script:db:migrate');
    expect(migrations(await project({ 'readme.md': '' }))).toEqual([]);
  });
});
