// Fake `claude -p --input-format stream-json --output-format stream-json` for tests.
// Speaks the same line protocol and, for prompts containing "needs-permission", calls the real
// MCP approve tool from --mcp-config exactly like the CLI's --permission-prompt-tool would.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import readline from 'node:readline';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const sessionId = flag('--resume') ?? flag('--session-id') ?? randomUUID();
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake-model', cwd: process.cwd(), permissionMode: flag('--permission-mode'), resumed: Boolean(flag('--resume')) });

function askPermission(toolName, input) {
  const cfg = JSON.parse(readFileSync(flag('--mcp-config'), 'utf8')).mcpServers.nicode;
  const mcp = spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env }, stdio: 'pipe' });
  const rl = readline.createInterface({ input: mcp.stdout });
  return new Promise((resolve) => {
    rl.on('line', (l) => {
      const m = JSON.parse(l);
      if (m.id === 2) {
        mcp.kill();
        resolve(JSON.parse(m.result.content[0].text));
      }
    });
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'approve', arguments: { tool_name: toolName, input } } }) + '\n');
  });
}

let turns = 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  const msg = JSON.parse(line);
  const text = msg.message.content[0].text;
  turns++;
  if (text.includes('slow')) await new Promise((r) => setTimeout(r, 30_000));
  if (text.includes('needs-permission')) {
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Write', input: { file_path: 'x.txt', content: 'hi' } }] } });
    const d = await askPermission('Write', { file_path: 'x.txt', content: 'hi' });
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: d.behavior === 'allow' ? 'written' : `denied: ${d.message}`, is_error: d.behavior !== 'allow' }] } });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: d.behavior === 'allow' ? 'approved' : 'was denied' }] } });
  } else {
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `echo: ${text}` }] } });
  }
  out({ type: 'result', subtype: 'success', is_error: false, result: `done ${turns}`, num_turns: turns, session_id: sessionId });
});
rl.on('close', () => process.exit(0));
