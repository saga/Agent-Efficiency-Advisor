import fs from 'node:fs';
import path from 'node:path';
import type { AgentTrace } from '../types.js';

export interface CollectorOptions {
  dataDir: string;
  filename?: string;
}

export class Collector {
  private filePath: string;

  constructor(options: CollectorOptions) {
    const filename = options.filename ?? 'traces.jsonl';
    this.filePath = path.join(options.dataDir, filename);
    fs.mkdirSync(options.dataDir, { recursive: true });
  }

  append(trace: AgentTrace): void {
    const line = JSON.stringify(trace) + '\n';
    fs.appendFileSync(this.filePath, line, 'utf8');
  }

  readAll(): AgentTrace[] {
    if (!fs.existsSync(this.filePath)) return [];
    const raw = fs.readFileSync(this.filePath, 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AgentTrace);
  }

  readRecent(count: number): AgentTrace[] {
    const all = this.readAll();
    return all.slice(-count);
  }

  count(): number {
    if (!fs.existsSync(this.filePath)) return 0;
    const raw = fs.readFileSync(this.filePath, 'utf8');
    let n = 0;
    for (const c of raw) if (c === '\n') n++;
    return n;
  }
}
