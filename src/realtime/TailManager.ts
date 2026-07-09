import { TailFile } from 'tail-file';
import type { LogParser } from './LogParser.js';
import type { EventBus } from './EventBus.js';

export interface TailManagerOptions {
  parser: LogParser;
  eventBus: EventBus;
}

export class TailManager {
  private tails = new Map<string, TailFile>();

  constructor(private options: TailManagerOptions) {}

  add(filePath: string, sessionId: string): void {
    if (this.tails.has(filePath)) return;

    const tail = new TailFile(filePath, { startPos: 0 });
    this.tails.set(filePath, tail);

    tail
      .start()
      .then(() => {
        tail.on('tail_line', (line: string) => {
          const event = this.options.parser.parse(line, sessionId);
          if (event) this.options.eventBus.emit(event);
        });
        tail.on('error', (err: Error) => {
          console.error(`Tail error for ${filePath}:`, err.message);
        });
      })
      .catch((err) => {
        console.error(`Failed to tail ${filePath}:`, err.message);
      });
  }

  remove(filePath: string): void {
    const tail = this.tails.get(filePath);
    if (tail) {
      tail.stop();
      this.tails.delete(filePath);
    }
  }

  stopAll(): void {
    for (const tail of this.tails.values()) {
      tail.stop();
    }
    this.tails.clear();
  }
}
