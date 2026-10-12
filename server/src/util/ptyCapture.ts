import * as pty from 'node-pty';
import stripAnsi from 'strip-ansi';

/**
 * Runs an interactive CLI in a PTY and lets callers wait for text to appear in its output.
 * Used to drive `claude setup-token` and `gh auth login` on behalf of the app.
 */
export class PtyCapture {
  private proc: pty.IPty;
  private out = '';
  private waiters: { re: RegExp; resolve: (m: RegExpExecArray) => void }[] = [];
  private exitWaiters: ((code: number) => void)[] = [];
  exitCode: number | null = null;

  constructor(file: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; cols?: number }) {
    this.proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: opts.cols ?? 1000, // wide, so long URLs don't wrap
      rows: 40,
      cwd: opts.cwd,
      env: opts.env as Record<string, string>,
    });
    this.proc.onData((d) => {
      this.out += stripAnsi(d);
      if (this.out.length > 200_000) this.out = this.out.slice(-100_000);
      this.check();
    });
    this.proc.onExit(({ exitCode }) => {
      this.exitCode = exitCode;
      for (const w of this.exitWaiters) w(exitCode);
      this.exitWaiters = [];
    });
  }

  get output(): string {
    return this.out;
  }

  private check(): void {
    this.waiters = this.waiters.filter((w) => {
      const m = w.re.exec(this.out);
      if (m) w.resolve(m);
      return !m;
    });
  }

  /** Resolves with the first match of `re` in the output so far (or later), or null on timeout/exit. */
  waitFor(re: RegExp, timeoutMs: number): Promise<RegExpExecArray | null> {
    const now = re.exec(this.out);
    if (now) return Promise.resolve(now);
    return new Promise((resolve) => {
      const waiter = { re, resolve: (m: RegExpExecArray) => { clearTimeout(t); resolve(m); } };
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(null);
      }, timeoutMs);
      this.waiters.push(waiter);
      this.exitWaiters.push(() => {
        // Give any final output a moment to be matched before giving up.
        setTimeout(() => {
          const m = re.exec(this.out);
          clearTimeout(t);
          this.waiters = this.waiters.filter((w) => w !== waiter);
          resolve(m);
        }, 50);
      });
    });
  }

  waitExit(timeoutMs: number): Promise<number | null> {
    if (this.exitCode !== null) return Promise.resolve(this.exitCode);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), timeoutMs);
      this.exitWaiters.push((c) => {
        clearTimeout(t);
        resolve(c);
      });
    });
  }

  write(s: string): void {
    if (this.exitCode === null) this.proc.write(s);
  }

  kill(): void {
    if (this.exitCode === null) {
      try {
        this.proc.kill();
      } catch {
        // already gone
      }
    }
  }
}
