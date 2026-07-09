import { watch, type FSWatcher } from 'chokidar';
import path from 'node:path';
import { TailManager } from './TailManager.js';
import { CopilotParser } from './LogParser.js';
import { EventBus } from './EventBus.js';
import type { AgentLogEvent } from '../types.js';
import type { LogSource } from './LogSource.js';

export interface CopilotSourceOptions {
  logDir: string;
  filePattern?: string;
}

export class CopilotSource implements LogSource {
  private eventBus = new EventBus();
  private tailManager: TailManager;
  private watcher?: FSWatcher;
  private queue: AgentLogEvent[] = [];
  private resolver?: (event: AgentLogEvent) => void;

  constructor(private options: CopilotSourceOptions) {
    this.tailManager = new TailManager({
      parser: new CopilotParser(),
      eventBus: this.eventBus,
    });
    this.eventBus.onAny((event) => {
      if (this.resolver) {
        this.resolver(event);
        this.resolver = undefined;
      } else {
        this.queue.push(event);
      }
    });
  }

  async *watch(): AsyncIterable<AgentLogEvent> {
    const pattern = this.options.filePattern ?? '**/*.jsonl';
    const watcher = watch(path.join(this.options.logDir, pattern), {
      ignoreInitial: false,
      persistent: true,
      depth: 10,
    });
    this.watcher = watcher;

    watcher
      .on('add', (filePath: string) => {
        const sessionId = path.basename(path.dirname(filePath)) || 'unknown';
        this.tailManager.add(filePath, sessionId);
      })
      .on('unlink', (filePath: string) => {
        this.tailManager.remove(filePath);
      });

    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
      } else {
        yield new Promise<AgentLogEvent>((resolve) => {
          this.resolver = resolve;
        });
      }
    }
  }

  stop(): void {
    this.watcher?.close();
    this.tailManager.stopAll();
  }
}
