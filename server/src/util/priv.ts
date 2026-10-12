import { app } from '../app.js';
import { run, type RunResult } from './exec.js';

/** Runs a command as root: directly when the daemon is root, else via passwordless sudo. */
export function priv(file: string, args: string[], timeoutMs = 60_000): Promise<RunResult> {
  if (app.isRoot) return run(file, args, { timeoutMs });
  return run('sudo', ['-n', file, ...args], { timeoutMs });
}
