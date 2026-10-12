import type { TaskStepState } from '../../../protocol/types.js';
import { events } from '../events.js';
import { RpcError } from '../rpc.js';
import { runStreaming } from './stream.js';

/** A checklist reported live to the app as `tasks.step` events (keyed by opId). */
export class Steps {
  readonly list: TaskStepState[] = [];
  constructor(private readonly opId?: string) {}
  set(step: string, label: string, status: TaskStepState['status'], detail?: string): void {
    const s: TaskStepState = { step, label, status, ...(detail ? { detail } : {}) };
    const i = this.list.findIndex((x) => x.step === step);
    if (i >= 0) this.list[i] = s;
    else this.list.push(s);
    if (this.opId) events.emit('tasks.step', { opId: this.opId, ...s });
  }
  /** Runs one catalog/explicit command as a step; throws on failure. */
  async exec(step: string, label: string, cwd: string, file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 15 * 60_000): Promise<void> {
    this.set(step, label, 'running', [file, ...args].join(' '));
    const r = await runStreaming(file, args, { cwd, env, opId: this.opId, timeoutMs });
    if (r.code !== 0) {
      const tail = r.output.trim().split('\n').slice(-4).join('\n');
      this.set(step, label, 'failed', tail || `exit code ${r.code}`);
      throw new RpcError('bad_request', `${label} failed`, { output: r.output.slice(-4000) });
    }
    this.set(step, label, 'done');
  }
}
