import { execFile } from 'node:child_process';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
  /** Exit codes that count as success (default [0]). */
  okCodes?: number[];
}

/**
 * Runs a program with an argument array — never through a shell, so request parameters can't
 * inject commands. Resolves with the exit code instead of throwing on non-zero exits.
 */
export function run(file: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        timeout: opts.timeoutMs ?? 60_000,
        maxBuffer: 32 * 1024 * 1024,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        if (err && typeof (err as NodeJS.ErrnoException).code === 'string') {
          // Spawn failure (ENOENT etc.), not a non-zero exit.
          reject(err);
          return;
        }
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    }
  });
}

/** Like run(), but throws with stderr when the exit code isn't in okCodes. */
export async function runOk(file: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const r = await run(file, args, opts);
  if (!(opts.okCodes ?? [0]).includes(r.code)) {
    const msg = (r.stderr || r.stdout).trim().split('\n').slice(-5).join('\n');
    throw new Error(msg || `${file} exited with code ${r.code}`);
  }
  return r;
}

/** Splits a byte stream into lines; keeps the trailing partial line for the next chunk. */
export class LineSplitter {
  private rest = '';
  push(chunk: string): string[] {
    const text = this.rest + chunk;
    const parts = text.split('\n');
    this.rest = parts.pop() ?? '';
    return parts.map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0);
  }
  flush(): string[] {
    const r = this.rest.trim();
    this.rest = '';
    return r ? [r] : [];
  }
}
