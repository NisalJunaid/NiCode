import * as pty from 'node-pty';
import stripAnsi from 'strip-ansi';

/**
 * Terminal output → plain text. TUIs (Ink) draw spaces and line breaks with cursor moves, so
 * stripping escape codes alone glues words together ("…state=abcPastecodehere"). Turn
 * cursor-forward into a space and cursor-to-row/line moves into a newline first.
 */
export function plainText(raw: string): string {
  const spaced = raw
    .replace(/\x1b\[\d*C/g, ' ') // cursor forward
    .replace(/\x1b\[\d*(;\d*)?[Hf]/g, '\n') // cursor position
    .replace(/\x1b\[\d*[ABEF]/g, '\n') // cursor up/down/next/previous line
    .replace(/\x1b\[\d*G/g, '\n'); // cursor to column (start of a redraw)
  return stripAnsi(spaced);
}

/**
 * Runs an interactive CLI in a PTY and lets callers wait for text to appear in its output.
 * Used to drive `claude setup-token` and `gh auth login` on behalf of the app.
 */
export class PtyCapture {
  private proc: pty.IPty;
  private out = '';
  private waiters: { re: RegExp; from: number; resolve: (m: RegExpExecArray) => void }[] = [];
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
      this.out += plainText(d);
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
      const m = w.re.exec(this.out.slice(w.from));
      if (m) w.resolve(m);
      return !m;
    });
  }

  /**
   * Resolves with the first match of `re` in the output (from character `from` on, so text that
   * was already on screen can be skipped), or null on timeout/exit.
   */
  waitFor(re: RegExp, timeoutMs: number, from = 0): Promise<RegExpExecArray | null> {
    const scan = () => re.exec(this.out.slice(from));
    const now = scan();
    if (now) return Promise.resolve(now);
    return new Promise((resolve) => {
      const waiter = { re, from, resolve: (m: RegExpExecArray) => { clearTimeout(t); resolve(m); } };
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(null);
      }, timeoutMs);
      this.waiters.push(waiter);
      this.exitWaiters.push(() => {
        // Give any final output a moment to be matched before giving up.
        setTimeout(() => {
          const m = scan();
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
