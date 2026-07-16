// Tests for ChatSessionsParser — JSONL patch format with autoModeResolution

import { describe, it, expect } from 'vitest';
import { ChatSessionsParser } from '../src/realtime/parsers/ChatSessionsParser.js';

// 模拟真实 chatSessions/{id}.jsonl 的 patch 格式
const SAMPLE_JSONL = [
  // kind:0 初始化
  JSON.stringify({
    kind: 0,
    v: {
      version: 3,
      creationDate: 1784211871430,
      initialLocation: 'panel',
      responderUsername: 'GitHub Copilot',
      sessionId: 'test-session-1',
      hasPendingEdits: false,
      requests: [],
      pendingRequests: [],
      inputState: {
        attachments: [],
        mode: { id: 'agent', kind: 'agent' },
        selectedModel: {
          identifier: 'copilot/auto',
          metadata: {
            id: 'auto',
            vendor: 'copilot',
            name: 'Auto',
            family: 'oswe-vscode',
            version: 'raptor-mini',
          },
        },
        inputText: '',
      },
      permissionLevel: 'default',
    },
  }),
  // kind:2 追加 request(含 autoModeResolution)
  JSON.stringify({
    kind: 2,
    k: ['requests'],
    v: [
      {
        requestId: 'req-1',
        timestamp: 1784211932771,
        agent: { name: 'agent' },
        modelId: 'copilot/auto',
        responseId: 'resp-1',
        message: { text: '帮我重构这个函数', parts: [] },
        response: [
          { kind: 'mcpServersStarting', didStartServerIds: [] },
          {
            kind: 'autoModeResolution',
            resolvedModel: 'oswe-vscode-prime',
            resolvedModelName: 'Raptor mini',
            predictedLabel: 'needs_reasoning',
            confidence: 0.43,
          },
        ],
        result: {
          timings: { firstProgress: 6156, totalElapsed: 8808 },
          metadata: { promptTokens: 19023, outputTokens: 473 },
          resolvedModel: 'oswe-vscode-prime',
        },
        completionTokens: 473,
        modeInfo: { kind: 'agent', permissionLevel: 'default' },
      },
    ],
  }),
  // kind:1 设置 customTitle
  JSON.stringify({
    kind: 1,
    k: ['customTitle'],
    v: '重构函数',
  }),
  // kind:1 设置 modelState
  JSON.stringify({
    kind: 1,
    k: ['requests', 0, 'modelState'],
    v: { value: 1, completedAt: 1784211941629 },
  }),
].join('\n');

describe('ChatSessionsParser', () => {
  const parser = new ChatSessionsParser();

  it('parses kind:0 initialization', () => {
    const result = parser.parseString(SAMPLE_JSONL, '/fake/path.jsonl', false);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('test-session-1');
    expect(result!.creationDate).toBe(1784211871430);
    expect(result!.initialLocation).toBe('panel');
    expect(result!.responderUsername).toBe('GitHub Copilot');
  });

  it('applies kind:2 array append', () => {
    const result = parser.parseString(SAMPLE_JSONL, '/fake/path.jsonl', false);
    expect(result!.requests).toHaveLength(1);
    expect(result!.requests[0].requestId).toBe('req-1');
    expect(result!.requests[0].message?.text).toBe('帮我重构这个函数');
  });

  it('applies kind:1 set path', () => {
    const result = parser.parseString(SAMPLE_JSONL, '/fake/path.jsonl', false);
    expect(result!.customTitle).toBe('重构函数');
    expect(result!.requests[0].modelState?.value).toBe(1);
    expect(result!.requests[0].modelState?.completedAt).toBe(1784211941629);
  });

  it('extracts autoModeResolution from response array', () => {
    const result = parser.parseString(SAMPLE_JSONL, '/fake/path.jsonl', false);
    const req = result!.requests[0];
    expect(req.autoModeResolution).toBeDefined();
    expect(req.autoModeResolution!.resolvedModel).toBe('oswe-vscode-prime');
    expect(req.autoModeResolution!.resolvedModelName).toBe('Raptor mini');
    expect(req.autoModeResolution!.predictedLabel).toBe('needs_reasoning');
    expect(req.autoModeResolution!.confidence).toBeCloseTo(0.43);
  });

  it('extracts auto mode signals', () => {
    const result = parser.parseString(SAMPLE_JSONL, '/fake/path.jsonl', false);
    const signals = parser.extractAutoModeSignals(result!);
    expect(signals).toHaveLength(1);
    expect(signals[0].sessionId).toBe('test-session-1');
    expect(signals[0].requestId).toBe('req-1');
    expect(signals[0].predictedLabel).toBe('needs_reasoning');
    expect(signals[0].confidence).toBeCloseTo(0.43);
    expect(signals[0].userMessageText).toBe('帮我重构这个函数');
  });

  it('preserves selected model metadata', () => {
    const result = parser.parseString(SAMPLE_JSONL, '/fake/path.jsonl', false);
    expect(result!.selectedModel?.identifier).toBe('copilot/auto');
    expect(result!.selectedModel?.metadata?.family).toBe('oswe-vscode');
    expect(result!.selectedModel?.metadata?.version).toBe('raptor-mini');
  });

  it('preserves result timings and tokens', () => {
    const result = parser.parseString(SAMPLE_JSONL, '/fake/path.jsonl', false);
    const req = result!.requests[0];
    expect(req.result?.timings?.firstProgress).toBe(6156);
    expect(req.result?.timings?.totalElapsed).toBe(8808);
    expect(req.result?.metadata?.promptTokens).toBe(19023);
    expect(req.result?.metadata?.outputTokens).toBe(473);
    expect(req.result?.resolvedModel).toBe('oswe-vscode-prime');
    expect(req.completionTokens).toBe(473);
  });

  it('returns null for empty input', () => {
    expect(parser.parseString('', '/fake.jsonl', false)).toBeNull();
  });

  it('handles request without autoModeResolution', () => {
    const jsonl = JSON.stringify({
      kind: 0,
      v: { sessionId: 's2', creationDate: 0, requests: [] },
    });
    const result = parser.parseString(jsonl, '/fake.jsonl', false);
    expect(result!.requests).toHaveLength(0);
  });

  it('marks empty window sessions', () => {
    const result = parser.parseString(SAMPLE_JSONL, '/fake.jsonl', true);
    expect(result!.isEmptyWindow).toBe(true);
  });
});
