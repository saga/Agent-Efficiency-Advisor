declare module 'tail-file' {
  import { EventEmitter } from 'node:events';

  interface TailFileOptions {
    startPos?: number;
  }

  export class TailFile extends EventEmitter {
    constructor(filePath: string, options?: TailFileOptions);
    start(): Promise<void>;
    stop(): void;
    on(event: 'tail_line', listener: (line: string) => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
  }
}
