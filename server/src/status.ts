import { readFileSync } from 'node:fs';
import type { SetupState, SetupStatus } from '../../protocol/types.js';
import { writeFileAtomic } from './config.js';
import { log } from './log.js';

/**
 * status.json is shared with the installer (installer/lib/status.sh). The daemon only changes
 * `state` (and `error`), keeping the installer's step list intact.
 */
export class StatusFile {
  constructor(
    private readonly path: string,
    private readonly defaults: Pick<SetupStatus, 'host' | 'transport'>,
  ) {}

  read(): SetupStatus {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as SetupStatus;
    } catch {
      return {
        version: 1,
        state: 'installing',
        step: null,
        steps: [],
        host: this.defaults.host,
        transport: this.defaults.transport,
        updatedAt: new Date().toISOString(),
        error: null,
      };
    }
  }

  async setState(state: SetupState): Promise<SetupStatus> {
    const s = this.read();
    // Never downgrade the installer's view while it is still running.
    if (s.state === 'installing' && s.steps.some((x) => x.status === 'running')) return s;
    const next: SetupStatus = { ...s, state, error: null, updatedAt: new Date().toISOString() };
    try {
      // World-readable: Caddy/nginx serve it at /setup/status (guarded by the setup id).
      await writeFileAtomic(this.path, JSON.stringify(next) + '\n', 0o644);
    } catch (err) {
      log.warn({ err, path: this.path }, 'could not write status file');
    }
    return next;
  }
}
