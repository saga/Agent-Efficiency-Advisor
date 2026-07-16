// Tests for SystemPromptToolsParser, ChatEditingSessionsParser,
// TranscriptsParser, CopilotExtLogParser

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SystemPromptToolsParser } from '../src/realtime/parsers/SystemPromptToolsParser.js';
import { ChatEditingSessionsParser } from '../src/realtime/parsers/ChatEditingSessionsParser.js';
import { TranscriptsParser } from '../src/realtime/parsers/TranscriptsParser.js';
import { CopilotExtLogParser } from '../src/realtime/parsers/CopilotExtLogParser.js';

describe('SystemPromptToolsParser', () => {
  const parser = new SystemPromptToolsParser();
  let tmpDir: string;
  let debugLogDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aea-spt-'));
    debugLogDir = join(tmpDir, 'debug-logs', 'session-1');
    mkdirSync(debugLogDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses system prompt text from content JSON', () => {
    const promptContent = JSON.stringify([
      { type: 'text', content: 'You are an AI assistant.' },
    ]);
    writeFileSync(join(debugLogDir, 'system_prompt_0.json'), JSON.stringify({ content: promptContent }));
    const result = parser.parseDir(debugLogDir, 'session-1');
    expect(result.systemPromptText).toContain('You are an AI assistant.');
  });

  it('parses tools and categorizes them', () => {
    const toolsContent = JSON.stringify([
      { name: 'read_file', description: 'Read a file' },
      { name: 'open_browser_page', description: 'Open a browser' },
      { name: 'run_in_terminal', description: 'Run command' },
      { name: 'semantic_search', description: 'Search code' },
      { name: 'unknown_tool', description: 'Mystery' },
    ]);
    writeFileSync(join(debugLogDir, 'tools_0.json'), JSON.stringify({ content: toolsContent }));
    const result = parser.parseDir(debugLogDir, 'session-1');
    expect(result.tools).toHaveLength(5);
    expect(result.toolCategoryCounts.file).toBe(1);
    expect(result.toolCategoryCounts.browser).toBe(1);
    expect(result.toolCategoryCounts.terminal).toBe(1);
    expect(result.toolCategoryCounts.search).toBe(1);
    expect(result.toolCategoryCounts.unknown).toBe(1);
  });

  it('extracts skills from system prompt', () => {
    const promptContent = JSON.stringify([
      {
        type: 'text',
        content: `<skills><skill><name>chronicle</name><description>Analyze history</description><file>/path/SKILL.md</file></skill></skills>`,
      },
    ]);
    writeFileSync(join(debugLogDir, 'system_prompt_0.json'), JSON.stringify({ content: promptContent }));
    const result = parser.parseDir(debugLogDir, 'session-1');
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe('chronicle');
    expect(result.skills[0].file).toBe('/path/SKILL.md');
  });

  it('extracts subagents from system prompt', () => {
    const promptContent = JSON.stringify([
      {
        type: 'text',
        content: `<agents><agent><name>Explore</name><description>Fast exploration</description><argumentHint>quick/medium</argumentHint></agent></agents>`,
      },
    ]);
    writeFileSync(join(debugLogDir, 'system_prompt_0.json'), JSON.stringify({ content: promptContent }));
    const result = parser.parseDir(debugLogDir, 'session-1');
    expect(result.subagents).toHaveLength(1);
    expect(result.subagents[0].name).toBe('Explore');
    expect(result.subagents[0].argumentHint).toBe('quick/medium');
  });
});

describe('ChatEditingSessionsParser', () => {
  const parser = new ChatEditingSessionsParser();

  it('parses state.json with checkpoints', () => {
    const state = {
      version: 2,
      initialFileContents: {},
      timeline: {
        checkpoints: [
          { checkpointId: 'cp-1', epoch: 0, label: 'Initial State', description: 'Starting point' },
          { checkpointId: 'cp-2', epoch: 1, requestId: 'req-1', label: 'Request' },
        ],
        currentEpoch: 2,
        epochCounter: 2,
        operations: [],
        fileBaselines: [],
      },
      recentSnapshot: { entries: [] },
    };
    const result = parser.parseString(JSON.stringify(state), '/fake/state.json', 'session-1');
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('session-1');
    expect(result!.version).toBe(2);
    expect(result!.checkpoints).toHaveLength(2);
    expect(result!.checkpoints[0].checkpointId).toBe('cp-1');
    expect(result!.checkpoints[0].epoch).toBe(0);
    expect(result!.checkpoints[1].requestId).toBe('req-1');
    expect(result!.currentEpoch).toBe(2);
  });

  it('returns null for invalid JSON', () => {
    expect(parser.parseString('not json', '/fake.json', 's1')).toBeNull();
  });
});

describe('TranscriptsParser', () => {
  const parser = new TranscriptsParser();

  it('parses session.start and subsequent events', () => {
    const jsonl = [
      JSON.stringify({
        type: 'session.start',
        data: {
          sessionId: 'transcript-1',
          producer: 'copilot-agent',
          copilotVersion: '0.57.0',
          vscodeVersion: '1.129.0',
          startTime: '2026-07-16T14:25:34.091Z',
        },
        id: 'evt-1',
        timestamp: '2026-07-16T14:25:34.091Z',
        parentId: null,
      }),
      JSON.stringify({
        type: 'turn.end',
        data: { sessionId: 'transcript-1', turnId: 0 },
        timestamp: '2026-07-16T14:26:00.000Z',
      }),
    ].join('\n');

    const result = parser.parseString(jsonl, '/fake.jsonl');
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('transcript-1');
    expect(result!.events).toHaveLength(2);
    expect(result!.producer).toBe('copilot-agent');
    expect(result!.copilotVersion).toBe('0.57.0');
    expect(result!.vscodeVersion).toBe('1.129.0');
    expect(result!.startTime).toBe('2026-07-16T14:25:34.091Z');
  });

  it('returns null for empty input', () => {
    expect(parser.parseString('', '/fake.jsonl')).toBeNull();
  });
});

describe('CopilotExtLogParser', () => {
  const parser = new CopilotExtLogParser();

  it('extracts token sku, versions, and flags', () => {
    const log = [
      '2026-07-13 08:10:26.075 [info] [GitExtensionServiceImpl] Initializing.',
      '2026-07-13 08:10:26.812 [info] Copilot Chat: 0.56.0, VS Code: 1.128.0',
      '2026-07-13 08:10:26.842 [info] copilot token sku: free_limited_copilot',
      '2026-07-13 08:10:26.770 [info] [CopilotCLI] MCP server started. Lock file: /tmp/x.lock',
      '2026-07-13 08:10:26.853 [info] [code-referencing] Public code references are enabled.',
      '2026-07-13 08:10:26.853 [info] activationBlocker from \'conversationFeature\' took for 279ms',
    ].join('\n');

    const result = parser.parseString(log, '/fake.log');
    expect(result.copilotVersion).toBe('0.56.0');
    expect(result.vscodeVersion).toBe('1.128.0');
    expect(result.tokenSku).toBe('free_limited_copilot');
    expect(result.mcpServerStarted).toBe(true);
    expect(result.codeReferencingEnabled).toBe(true);
    expect(result.activationBlockerMs).toBe(279);
    expect(result.firstSeenTimestamp).toBe('2026-07-13 08:10:26.075');
  });

  it('handles log without token sku', () => {
    const log = '2026-07-13 08:10:26.075 [info] Some other message';
    const result = parser.parseString(log, '/fake.log');
    expect(result.tokenSku).toBeUndefined();
    expect(result.mcpServerStarted).toBe(false);
  });
});
