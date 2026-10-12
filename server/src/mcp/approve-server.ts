/**
 * Minimal stdio MCP server exposing one tool, `approve`, used as Claude Code's
 * --permission-prompt-tool. It forwards each permission prompt to the niCode daemon over a unix
 * socket and returns the phone's decision. Dependency-free on purpose: it is spawned by the
 * Claude CLI for every session and must start fast and never break on SDK changes.
 *
 * Env (set by the daemon in the per-session --mcp-config): NICODE_SOCKET, NICODE_SECRET, NICODE_SESSION_ID.
 */
import http from 'node:http';
import readline from 'node:readline';

const SOCKET = process.env.NICODE_SOCKET ?? '';
const SECRET = process.env.NICODE_SECRET ?? '';
const SESSION_ID = process.env.NICODE_SESSION_ID ?? '';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function askDaemon(toolName: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ sessionId: SESSION_ID, toolName, input });
    const req = http.request(
      {
        socketPath: SOCKET,
        path: '/permission',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-nicode-internal': SECRET },
        timeout: 0,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          // Fail closed: anything but a well-formed 200 answer is a denial.
          try {
            const d = JSON.parse(data) as Record<string, unknown>;
            if (res.statusCode === 200 && (d.behavior === 'allow' || d.behavior === 'deny')) return resolve(d);
          } catch {
            // fall through
          }
          resolve({ behavior: 'deny', message: 'niCode refused or returned an invalid answer' });
        });
      },
    );
    req.on('error', () => resolve({ behavior: 'deny', message: 'niCode daemon is not reachable' }));
    req.end(body);
  });
}

const TOOL = {
  name: 'approve',
  description: 'Asks the niCode app user to approve or deny a tool call.',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string' },
      input: { type: 'object' },
      tool_use_id: { type: 'string' },
    },
    required: ['tool_name', 'input'],
  },
};

async function handle(msg: JsonRpcRequest): Promise<void> {
  const reply = (result: unknown) => msg.id !== undefined && send({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      reply({
        protocolVersion: (msg.params?.protocolVersion as string) ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'nicode', version: '1.0.0' },
      });
      return;
    case 'tools/list':
      reply({ tools: [TOOL] });
      return;
    case 'tools/call': {
      const args = (msg.params?.arguments ?? {}) as { tool_name?: string; input?: Record<string, unknown> };
      const decision = await askDaemon(args.tool_name ?? 'unknown', args.input ?? {});
      reply({ content: [{ type: 'text', text: JSON.stringify(decision) }] });
      return;
    }
    case 'ping':
      reply({});
      return;
    default:
      if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg: JsonRpcRequest;
  try {
    msg = JSON.parse(line) as JsonRpcRequest;
  } catch {
    return;
  }
  void handle(msg);
});
rl.on('close', () => process.exit(0));
