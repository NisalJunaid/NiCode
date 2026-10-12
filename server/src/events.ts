import type { EventData, EventFrame, EventName } from '../../protocol/types.js';

type Sink = (frame: string) => void;

/** Fan-out of server events to every authenticated socket (single-user server). */
class EventHub {
  private sinks = new Map<string, Sink>();
  private closeListeners = new Set<(clientId: string) => void>();

  add(clientId: string, sink: Sink): void {
    this.sinks.set(clientId, sink);
  }

  remove(clientId: string): void {
    this.sinks.delete(clientId);
    for (const l of this.closeListeners) l(clientId);
  }

  onClientClosed(fn: (clientId: string) => void): void {
    this.closeListeners.add(fn);
  }

  emit<E extends EventName>(event: E, data: EventData<E>): void {
    const frame: EventFrame<E> = { event, data };
    const text = JSON.stringify(frame);
    for (const sink of this.sinks.values()) sink(text);
  }

  get clientCount(): number {
    return this.sinks.size;
  }
}

export const events = new EventHub();
