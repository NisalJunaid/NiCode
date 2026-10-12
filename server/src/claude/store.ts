import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import type { ClaudeSessionSummary, ClaudeStreamEvent, SeqEvent } from '../../../protocol/types.js';
import { writeFileAtomic } from '../config.js';

/** Extra bookkeeping kept next to the protocol summary. */
export interface StoredSession extends ClaudeSessionSummary {
  /** Claude's own session id (from the init event); used for --resume. */
  claudeSessionId: string | null;
}

/**
 * Sessions live in <dataDir>/sessions: one append-only <id>.jsonl of {seq, ts, event}
 * per session plus index.json with the summaries.
 */
export class SessionStore {
  private dir: string;
  private index = new Map<string, StoredSession>();
  private indexWrite: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'sessions');
  }

  async load(): Promise<StoredSession[]> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      const list = JSON.parse(await readFile(path.join(this.dir, 'index.json'), 'utf8')) as StoredSession[];
      for (const s of list) this.index.set(s.sessionId, { ...s, state: s.state === 'error' ? 'error' : 'idle' });
    } catch {
      // first run
    }
    return [...this.index.values()];
  }

  get(id: string): StoredSession | undefined {
    return this.index.get(id);
  }

  list(): StoredSession[] {
    return [...this.index.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  upsert(s: StoredSession): void {
    this.index.set(s.sessionId, s);
    this.saveIndex();
  }

  private saveIndex(): void {
    const snapshot = JSON.stringify([...this.index.values()]);
    this.indexWrite = this.indexWrite.then(() => writeFileAtomic(path.join(this.dir, 'index.json'), snapshot)).catch(() => undefined);
  }

  private writeChains = new Map<string, Promise<void>>();

  /**
   * Appends one event and returns its SeqEvent. The seq is assigned synchronously and file
   * writes are chained per session, so the log stays in seq order even when events arrive
   * faster than the disk.
   */
  append(id: string, event: ClaudeStreamEvent): SeqEvent {
    const s = this.index.get(id);
    if (!s) throw new Error(`unknown session ${id}`);
    const rec: SeqEvent = { seq: s.lastSeq + 1, ts: new Date().toISOString(), event };
    s.lastSeq = rec.seq;
    s.updatedAt = rec.ts;
    const file = path.join(this.dir, `${id}.jsonl`);
    const line = JSON.stringify(rec) + '\n';
    const chain = (this.writeChains.get(id) ?? Promise.resolve()).then(() => appendFile(file, line, { mode: 0o600 })).catch(() => undefined);
    this.writeChains.set(id, chain);
    this.saveIndex();
    return rec;
  }

  /** Resolves once all queued writes for the session are on disk. */
  flushed(id: string): Promise<void> {
    return this.writeChains.get(id) ?? Promise.resolve();
  }

  async history(id: string, sinceSeq = 0, limit = 2000): Promise<SeqEvent[]> {
    await this.flushed(id);
    const out: SeqEvent[] = [];
    const rl = readline.createInterface({ input: createReadStream(path.join(this.dir, `${id}.jsonl`)), crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (!line) continue;
        const rec = JSON.parse(line) as SeqEvent;
        if (rec.seq > sinceSeq) out.push(rec);
        if (out.length >= limit) break;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    } finally {
      rl.close();
    }
    return out;
  }
}
