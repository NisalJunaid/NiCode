import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PermissionRequest } from '../../protocol/types.js';
import { PermissionBroker } from '../src/claude/permissions.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const approveJs = path.join(here, '..', 'dist', 'server', 'src', 'mcp', 'approve-server.js');

/** Drives the compiled MCP approve server the way the Claude CLI does. */
function mcpClient(env: Record<string, string>) {
  const proc = spawn(process.execPath, [approveJs], { env: { ...process.env, ...env }, stdio: 'pipe' });
  const rl = readline.createInterface({ input: proc.stdout });
  const waiting = new Map<number, (v: any) => void>();
  rl.on('line', (l) => {
    const msg = JSON.parse(l);
    waiting.get(msg.id)?.(msg);
  });
  let id = 0;
  const call = (method: string, params: unknown = {}) =>
    new Promise<any>((resolve) => {
      const n = ++id;
      waiting.set(n, resolve);
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
    });
  return { call, close: () => proc.kill() };
}

describe('permission bridge (MCP approve tool → daemon → phone)', () => {
  it('relays a prompt and returns the phone decision; remembers "always allow"', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nicode-perm-'));
    const requests: PermissionRequest[] = [];
    const broker = new PermissionBroker(dataDir, {
      policyOf: () => ({ projectPath: '/projects/demo', analyze: false, allowRemember: true }),
      onWaiting: () => undefined,
      notify: (r) => requests.push(r),
    });
    await broker.start();
    const mcp = mcpClient({ NICODE_SOCKET: broker.socketPath, NICODE_SECRET: broker.secret, NICODE_SESSION_ID: 's1' });
    try {
      const init = await mcp.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
      expect(init.result.serverInfo.name).toBe('nicode');
      const tools = await mcp.call('tools/list');
      expect(tools.result.tools[0].name).toBe('approve');

      // 1) Phone allows with an edited command, and asks to remember "npm".
      const pending = mcp.call('tools/call', { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'npm test' } } });
      await vi_waitFor(() => requests.length === 1);
      expect(broker.list()).toHaveLength(1);
      broker.respond(requests[0]!.requestId, { behavior: 'allow', updatedInput: { command: 'npm test -- --run' }, remember: true });
      const res = await pending;
      expect(JSON.parse(res.result.content[0].text)).toEqual({ behavior: 'allow', updatedInput: { command: 'npm test -- --run' } });

      // 2) Same command ("npm test") is now auto-allowed without asking the phone.
      const auto = await mcp.call('tools/call', { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'npm test -- --coverage' } } });
      expect(JSON.parse(auto.result.content[0].text).behavior).toBe('allow');
      expect(requests).toHaveLength(1);

      // 3) Chained or multi-line commands always ask; deny with a reason.
      const chained = mcp.call('tools/call', { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'npm test && rm -rf /' } } });
      await vi_waitFor(() => requests.length === 2);
      expect(requests[1]!.canRemember).toBe(false);
      broker.respond(requests[1]!.requestId, { behavior: 'deny', message: 'not that' });
      expect(JSON.parse((await chained).result.content[0].text)).toMatchObject({ behavior: 'deny', message: 'not that' });
      const multiline = mcp.call('tools/call', { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'npm test\nrm -rf ~' } } });
      await vi_waitFor(() => requests.length === 3);
      broker.respond(requests[2]!.requestId, { behavior: 'deny' });
      await multiline;
      // Another npm subcommand isn't covered by "npm test".
      const other = mcp.call('tools/call', { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'npm publish' } } });
      await vi_waitFor(() => requests.length === 4);
      broker.respond(requests[3]!.requestId, { behavior: 'deny' });
      await other;

      // 4) Wrong secret is refused.
      const bad = mcpClient({ NICODE_SOCKET: broker.socketPath, NICODE_SECRET: 'wrong', NICODE_SESSION_ID: 's1' });
      await bad.call('initialize', {});
      const refused = await bad.call('tools/call', { name: 'approve', arguments: { tool_name: 'Edit', input: {} } });
      expect(JSON.parse(refused.result.content[0].text).behavior).toBe('deny');
      bad.close();
    } finally {
      mcp.close();
      broker.stop();
    }
  });
});

async function vi_waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}
