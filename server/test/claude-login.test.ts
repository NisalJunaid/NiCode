/**
 * Claude login through the app. Unit: terminal text cleanup and the login link. Opt-in end to end
 * with the real CLI (NICODE_REAL_CLAUDE_BIN=<path to claude>): the link is clean and a wrong
 * code is reported quickly with Claude's own message.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanLoginUrl } from '../src/modules/setup.js';
import { plainText } from '../src/util/ptyCapture.js';
import { Client, startDaemon, type TestDaemon, TOKEN } from './helpers.js';

describe('login text handling', () => {
  it('turns cursor moves into spaces and line breaks', () => {
    expect(plainText('Paste\x1b[1Ccode\x1b[1Chere\x1b[2;1H>')).toBe('Paste code here\n>');
    expect(plainText('\x1b[32mok\x1b[0m')).toBe('ok');
  });

  it('cuts text glued onto the login link', () => {
    const glued = 'https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=j5vUmLxQUZuuGNO8_ffbDHeDS-YC_7pKYiknwLoMkIYPastecodehereifprompted';
    expect(new URL(cleanLoginUrl(glued)).searchParams.get('state')).toBe('j5vUmLxQUZuuGNO8_ffbDHeDS-YC_7pKYiknwLoMkIY');
    const clean = 'https://claude.com/cai/oauth/authorize?code=true&state=abc_-123';
    expect(new URL(cleanLoginUrl(clean)).searchParams.get('state')).toBe('abc_-123');
  });
});

const realBin = process.env.NICODE_REAL_CLAUDE_BIN;
describe.skipIf(!realBin)('login with the real Claude CLI', () => {
  let d: TestDaemon;
  let c: Client;
  beforeAll(async () => {
    d = await startDaemon({ claudeBin: realBin });
    c = await Client.connect(d.port, TOKEN);
  }, 60_000);
  afterAll(() => {
    c?.close();
    d?.stop();
  });

  it('gives a clean link and reports a wrong code quickly', async () => {
    const start = (await c.call('setup.claudeLogin.start', {})).result;
    expect(start.url).toMatch(/^https:\/\/claude\.(com|ai)\//);
    expect(start.url).not.toMatch(/Paste/i);
    const t0 = Date.now();
    const r = await c.call('setup.claudeLogin.submit', { loginId: start.loginId, code: 'notarealcode#notarealstate' });
    expect(r.error.message).toMatch(/Claude rejected the code \(OAuth error/);
    expect(Date.now() - t0).toBeLessThan(30_000);
  }, 90_000);
});
