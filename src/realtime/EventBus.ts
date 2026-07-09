import type { AgentLogEvent } from '../types.js';

export type EventHandler = (event: AgentLogEvent) => void;

export class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();
  private allHandlers = new Set<EventHandler>();

  on(type: string, handler: EventHandler): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);
    return () => this.handlers.get(type)?.delete(handler);
  }

  onAny(handler: EventHandler): () => void {
    this.allHandlers.add(handler);
    return () => this.allHandlers.delete(handler);
  }

  emit(event: AgentLogEvent): void {
    this.handlers.get(event.type)?.forEach((h) => h(event));
    this.allHandlers.forEach((h) => h(event));
  }

  offAll(): void {
    this.handlers.clear();
    this.allHandlers.clear();
  }
}
