import { spawn } from 'node:child_process';
import stripAnsi from 'strip-ansi';
import { events } from '../events.js';

const MAX_KEEP = 200_000;

/**
 * Runs a program (no shell) and streams its output to the app as `tasks.output` events
 * (batched every 120 ms). Resolves with the exit code and the last ~200 KB of output.
 */
export function runStreaming(
  file: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; opId?: string; timeoutMs?: number },
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    let out = '';
    let pending = '';
    let timer: NodeJS.Timeout | null = null;
    const flush = () => {
      timer = null;
      if (pending && opts.opId) events.emit('tasks.output', { opId: opts.opId, chunk: pending });
      pending = '';
    };
    const onData = (d: Buffer) => {
      const text = stripAnsi(d.toString('utf8'));
      out = (out + text).slice(-MAX_KEEP);
      pending += text;
      timer ??= setTimeout(flush, 120);
    };
    if (opts.opId) events.emit('tasks.output', { opId: opts.opId, chunk: `$ ${[file, ...args].join(' ')}\n` });
    let child;
    try {
      child = spawn(file, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: 127, output: String(err) });
      return;
    }
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const kill = setTimeout(() => {
      onData(Buffer.from(`\n[niCode] stopped after ${Math.round((opts.timeoutMs ?? 0) / 1000)}s\n`));
      child.kill('SIGTERM');
    }, opts.timeoutMs ?? 15 * 60_000);
    child.on('error', (err) => onData(Buffer.from(`\n${err.message}\n`)));
    child.on('close', (code) => {
      clearTimeout(kill);
      if (timer) clearTimeout(timer);
      flush();
      resolve({ code: code ?? 1, output: out });
    });
  });
}

/** A minimal, non-secret environment for user apps and builds (no daemon tokens leak in). */
export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'SHELL', 'TZ', 'TMPDIR', 'SYSTEMROOT', 'COMSPEC', 'APPDATA', 'USERPROFILE'];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  return { ...env, CI: '1', ...extra };
}
