import { describe, it, expect } from 'vitest';
import { CopilotParser } from '../src/realtime/LogParser.js';

describe('CopilotParser', () => {
  const parser = new CopilotParser();

  describe('legacy / synthetic AEA format', () => {
    it('parses legacy llm_request', () => {
      const line = JSON.stringify({
        kind: 'llm_request',
        promptTokens: 1500,
        completionTokens: 300,
        model: 'gpt-4o',
      });
      const ev = parser.parse(line, 'sess-legacy');
      expect(ev).toBeDefined();
      expect(ev!.type).toBe('llm_request');
      expect(ev!.sessionId).toBe('sess-legacy');
      const payload = ev!.payload as Record<string, unknown>;
      expect(payload.promptTokens).toBe(1500);
      expect(payload.completionTokens).toBe(300);
      expect(payload.model).toBe('gpt-4o');
    });

    it('parses legacy tool_call', () => {
      const line = JSON.stringify({
        type: 'tool_call',
        tool: 'read_file',
        durationMs: 120,
        success: true,
        args: { path: '/tmp/foo.ts' },
      });
      const ev = parser.parse(line, 'sess-legacy');
      expect(ev).toBeDefined();
      expect(ev!.type).toBe('tool_call');
      const payload = ev!.payload as Record<string, unknown>;
      expect(payload.tool).toBe('read_file');
      expect(payload.durationMs).toBe(120);
      expect(payload.success).toBe(true);
      expect(payload.args).toEqual({ path: '/tmp/foo.ts' });
    });

    it('parses legacy session_start', () => {
      const line = JSON.stringify({ kind: 'session_start', modelLimit: 128000 });
      const ev = parser.parse(line, 'sess-legacy');
      expect(ev).toBeDefined();
      expect(ev!.type).toBe('session_start');
      expect((ev!.payload as Record<string, unknown>).modelLimit).toBe(128000);
    });

    it('returns undefined for unmapped legacy type', () => {
      const line = JSON.stringify({ kind: 'heartbeat' });
      expect(parser.parse(line, 'sess-legacy')).toBeUndefined();
    });
  });

  describe('real VSCode Copilot Agent Debug Log format', () => {
    it('parses real session_start', () => {
      const line = JSON.stringify({
        ts: 1784197523456,
        dur: 0,
        sid: 'ca37-real',
        type: 'session_start',
        name: 'session_start',
        spanId: '0000000000000001',
        status: 'ok',
        attrs: { copilotVersion: '1.300.0', vscodeVersion: '1.100.0' },
      });
      const ev = parser.parse(line, 'ignored');
      expect(ev).toBeDefined();
      expect(ev!.type).toBe('session_start');
      expect(ev!.sessionId).toBe('ca37-real');
      expect(ev!.timestamp).toBe(1784197523456);
      const payload = ev!.payload as Record<string, unknown>;
      expect(payload.modelLimit).toBe(256000);
      expect(payload.copilotVersion).toBe('1.300.0');
    });

    it('parses real llm_request', () => {
      const line = JSON.stringify({
        ts: 1784197530000,
        dur: 1200,
        sid: 'ca37-real',
        type: 'llm_request',
        name: 'chat:gpt-5-mini',
        spanId: '0000000000000005',
        parentSpanId: '0000000000000003',
        status: 'ok',
        attrs: {
          model: 'gpt-5-mini',
          debugName: 'panel/editAgent',
          inputTokens: 23995,
          outputTokens: 163,
          cachedTokens: 23680,
          ttft: 538,
        },
      });
      const ev = parser.parse(line, 'ignored');
      expect(ev).toBeDefined();
      expect(ev!.type).toBe('llm_request');
      expect(ev!.sessionId).toBe('ca37-real');
      expect(ev!.timestamp).toBe(1784197530000);
      const payload = ev!.payload as Record<string, unknown>;
      expect(payload.promptTokens).toBe(23995);
      expect(payload.completionTokens).toBe(163);
      expect(payload.cachedTokens).toBe(23680);
      expect(payload.model).toBe('gpt-5-mini');
      expect(payload.ttft).toBe(538);
    });

    it('parses real tool_call', () => {
      const line = JSON.stringify({
        ts: 1784197538280,
        dur: 6391,
        sid: 'ca37-real',
        type: 'tool_call',
        name: 'run_in_terminal',
        spanId: '0000000000000019',
        parentSpanId: '0000000000000003',
        status: 'ok',
        attrs: {
          args: JSON.stringify({ command: 'npm test --silent', mode: 'sync' }),
          result: 'Test passed',
        },
      });
      const ev = parser.parse(line, 'ignored');
      expect(ev).toBeDefined();
      expect(ev!.type).toBe('tool_call');
      const payload = ev!.payload as Record<string, unknown>;
      expect(payload.tool).toBe('run_in_terminal');
      expect(payload.durationMs).toBe(6391);
      expect(payload.success).toBe(true);
      expect(payload.args).toEqual({ command: 'npm test --silent', mode: 'sync' });
    });

    it('marks failed real tool_call as success:false', () => {
      const line = JSON.stringify({
        ts: 1784197538280,
        dur: 100,
        sid: 'ca37-real',
        type: 'tool_call',
        name: 'run_in_terminal',
        status: 'error',
        attrs: { args: '{}' },
      });
      const ev = parser.parse(line, 'ignored');
      expect(ev).toBeDefined();
      expect((ev!.payload as Record<string, unknown>).success).toBe(false);
    });

    it('skips non-actionable real event types', () => {
      const skipped = ['user_message', 'turn_start', 'turn_end', 'generic', 'discovery', 'child_session_ref'];
      for (const type of skipped) {
        const line = JSON.stringify({
          ts: 1784197530000,
          dur: 0,
          sid: 'ca37-real',
          type,
          name: type,
          status: 'ok',
          attrs: {},
        });
        expect(parser.parse(line, 'ignored')).toBeUndefined();
      }
    });

    it('detects edit intent in agent_response', () => {
      const line = JSON.stringify({
        ts: 1784197530000,
        dur: 0,
        sid: 'ca37-real',
        type: 'agent_response',
        name: 'agent_response',
        status: 'ok',
        attrs: {
          response: JSON.stringify([{
            role: 'assistant',
            parts: [{ type: 'tool_call', name: 'edit_file', arguments: JSON.stringify({ filePath: '/tmp/x.ts' }) }],
          }]),
        },
      });
      const ev = parser.parse(line, 'ignored');
      expect(ev).toBeDefined();
      expect(ev!.type).toBe('edit');
      expect((ev!.payload as Record<string, unknown>).file).toBe('/tmp/x.ts');
    });
  });
});
