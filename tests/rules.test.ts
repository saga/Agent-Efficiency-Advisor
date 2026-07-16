// 7 条规则的单元测试 — 验证每条规则的触发条件与自定义配置覆盖。
// 所有测试仅依赖内存中的 SessionState 对象,不需要数据库或 Python 环境。

import { describe, it, expect } from 'vitest';
import { ContextTooLargeRule } from '../src/rules/ContextTooLargeRule.js';
import { ReadFileStormRule } from '../src/rules/ReadFileStormRule.js';
import { ToolLoopRule } from '../src/rules/ToolLoopRule.js';
import { RetryRule } from '../src/rules/RetryRule.js';
import { PromptExplosionRule } from '../src/rules/PromptExplosionRule.js';
import { LargeDiffRule } from '../src/rules/LargeDiffRule.js';
import { ModelSwitchRule } from '../src/rules/ModelSwitchRule.js';
import { DEFAULT_RULE_CONFIG, type RuleConfig } from '../src/rules/config.js';
import { createSessionState, updateState } from '../src/realtime/SessionState.js';
import type { AgentLogEvent, SessionState } from '../src/types.js';

// 构造一个可定制的 SessionState,便于测试
function makeState(overrides: Partial<SessionState> = {}): SessionState {
  const state = createSessionState('sess-test');
  return { ...state, ...overrides };
}

// ---- ContextTooLargeRule ----
describe('ContextTooLargeRule', () => {
  it('在 context >= 80% 时触发 warning', () => {
    const rule = new ContextTooLargeRule();
    // modelLimit=1000,contextTokens=800 → 80% 触发 warning
    const state = makeState({ modelLimit: 1000, contextTokens: 800 });
    const event: AgentLogEvent = {
      type: 'llm_request',
      sessionId: 'sess-test',
      timestamp: 1,
      payload: { promptTokens: 800, completionTokens: 0 },
    };
    expect(rule.match(state, event)).toBe(true);
    const alert = rule.action(state, event);
    expect(alert).toBeDefined();
    expect(alert!.severity).toBe('warning');
    expect(alert!.ruleId).toBe('context-too-large');
  });

  it('在 context >= 95% 时触发 critical', () => {
    const rule = new ContextTooLargeRule();
    const state = makeState({ modelLimit: 1000, contextTokens: 950 });
    const event: AgentLogEvent = {
      type: 'llm_request',
      sessionId: 'sess-test',
      timestamp: 1,
      payload: { promptTokens: 950, completionTokens: 0 },
    };
    expect(rule.match(state, event)).toBe(true);
    const alert = rule.action(state, event);
    expect(alert).toBeDefined();
    expect(alert!.severity).toBe('critical');
  });

  it('在 context < 80% 时不触发', () => {
    const rule = new ContextTooLargeRule();
    const state = makeState({ modelLimit: 1000, contextTokens: 799 });
    const event: AgentLogEvent = {
      type: 'llm_request',
      sessionId: 'sess-test',
      timestamp: 1,
      payload: { promptTokens: 799, completionTokens: 0 },
    };
    expect(rule.match(state, event)).toBe(false);
  });

  it('非 llm_request 事件不触发', () => {
    const rule = new ContextTooLargeRule();
    const state = makeState({ modelLimit: 1000, contextTokens: 950 });
    const event: AgentLogEvent = {
      type: 'tool_call',
      sessionId: 'sess-test',
      timestamp: 1,
      payload: { tool: 'read_file', success: true },
    };
    expect(rule.match(state, event)).toBe(false);
  });

  it('自定义配置能覆盖默认阈值', () => {
    const config: RuleConfig = {
      ...DEFAULT_RULE_CONFIG,
      contextTooLarge: { warningUtilization: 0.5, criticalUtilization: 0.9 },
    };
    const rule = new ContextTooLargeRule(config);
    // 60% 在默认 80% 以下不触发,但在自定义 50% 以上触发
    const state = makeState({ modelLimit: 1000, contextTokens: 600 });
    const event: AgentLogEvent = {
      type: 'llm_request',
      sessionId: 'sess-test',
      timestamp: 1,
      payload: { promptTokens: 600, completionTokens: 0 },
    };
    expect(rule.match(state, event)).toBe(true);
    const alert = rule.action(state, event);
    expect(alert!.severity).toBe('warning');
  });
});

// ---- ReadFileStormRule ----
describe('ReadFileStormRule', () => {
  it('在 >= 20 次 read_file 时触发', () => {
    const rule = new ReadFileStormRule();
    const state = makeState({ readFiles: 20 });
    const event: AgentLogEvent = {
      type: 'tool_call',
      sessionId: 'sess-test',
      timestamp: 1,
      payload: { tool: 'read_file', args: { path: 'a.ts' }, success: true },
    };
    expect(rule.match(state, event)).toBe(true);
    const alert = rule.action(state, event);
    expect(alert).toBeDefined();
    expect(alert!.ruleId).toBe('readfile-storm');
    expect(alert!.details!.readFiles).toBe(20);
  });

  it('在 < 20 次 read_file 时不触发', () => {
    const rule = new ReadFileStormRule();
    const state = makeState({ readFiles: 19 });
    const event: AgentLogEvent = {
      type: 'tool_call',
      sessionId: 'sess-test',
      timestamp: 1,
      payload: { tool: 'read_file', args: { path: 'a.ts' }, success: true },
    };
    expect(rule.match(state, event)).toBe(false);
  });

  it('非 read_file 工具不触发', () => {
    const rule = new ReadFileStormRule();
    const state = makeState({ readFiles: 100 });
    const event: AgentLogEvent = {
      type: 'tool_call',
      sessionId: 'sess-test',
      timestamp: 1,
      payload: { tool: 'edit', success: true },
    };
    expect(rule.match(state, event)).toBe(false);
  });

  it('自定义配置能覆盖默认阈值', () => {
    const config: RuleConfig = {
      ...DEFAULT_RULE_CONFIG,
      readFileStorm: { threshold: 5 },
    };
    const rule = new ReadFileStormRule(config);
    // 5 次在自定义阈值上,触发
    const state = makeState({ readFiles: 5 });
    const event: AgentLogEvent = {
      type: 'tool_call',
      sessionId: 'sess-test',
      timestamp: 1,
      payload: { tool: 'read_file', args: { path: 'a.ts' }, success: true },
    };
    expect(rule.match(state, event)).toBe(true);
  });
});

// ---- ToolLoopRule ----
describe('ToolLoopRule', () => {
  it('在重复模式 4+ 次时触发', () => {
    const rule = new ToolLoopRule();
    // 构造 read_file → edit 重复 4 次的序列
    const seq = ['read_file', 'edit', 'read_file', 'edit', 'read_file', 'edit', 'read_file', 'edit'];
    const state = makeState({ toolSequence: seq });
    const event: AgentLogEvent = {
      type: 'tool_call',
      sessionId: 'sess-test',
      timestamp: 1,
      payload: { tool: 'read_file', success: true },
    };
    expect(rule.match(state, event)).toBe(true);
    const alert = rule.action(state, event);
    expect(alert).toBeDefined();
    expect(alert!.ruleId).toBe('tool-loop');
    expect(alert!.message).toContain('read_file → edit');
  });

  it('在重复次数不足时不触发', () => {
    const rule = new ToolLoopRule();
    // 只有 3 次重复,未达到 4 次阈值
    const seq = ['read_file', 'edit', 'read_file', 'edit', 'read_file', 'edit'];
    const state = makeState({ toolSequence: seq });
    const event: AgentLogEvent = {
      type: 'tool_call',
      sessionId: 'sess-test',
      timestamp: 1,
      payload: { tool: 'read_file', success: true },
    };
    expect(rule.match(state, event)).toBe(false);
  });

  it('非 tool_call 事件不触发', () => {
    const rule = new ToolLoopRule();
    const seq = ['read_file', 'edit', 'read_file', 'edit', 'read_file', 'edit', 'read_file', 'edit'];
    const state = makeState({ toolSequence: seq });
    const event: AgentLogEvent = {
      type: 'llm_request',
      sessionId: 'sess-test',
      timestamp: 1,
      payload: { promptTokens: 100 },
    };
    expect(rule.match(state, event)).toBe(false);
  });

  it('自定义配置能覆盖 minRepeats', () => {
    const config: RuleConfig = {
      ...DEFAULT_RULE_CONFIG,
      toolLoop: { window: 10, minRepeats: 2 },
    };
    const rule = new ToolLoopRule(config);
    // 2 次重复在自定义阈值 2 上,触发
    const seq = ['read_file', 'edit', 'read_file', 'edit'];
    const state = makeState({ toolSequence: seq });
    const event: AgentLogEvent = {
      type: 'tool_call',
      sessionId: 'sess-test',
      timestamp: 1,
      payload: { tool: 'read_file', success: true },
    };
    expect(rule.match(state, event)).toBe(true);
  });
});

// ---- RetryRule ----
describe('RetryRule', () => {
  it('在 >= 3 次连续失败时触发', () => {
    const rule = new RetryRule();
    const state = makeState({ retries: 3 });
    const event: AgentLogEvent = {
      type: 'tool_call',
      sessionId: 'sess-test',
      timestamp: 1,
      payload: { tool: 'read_file', success: false },
    };
    expect(rule.match(state, event)).toBe(true);
    const alert = rule.action(state, event);
    expect(alert).toBeDefined();
    expect(alert!.ruleId).toBe('retry-spike');
    expect(alert!.details!.retries).toBe(3);
  });

  it('在 < 3 次失败时不触发', () => {
    const rule = new RetryRule();
    const state = makeState({ retries: 2 });
    const event: AgentLogEvent = {
      type: 'tool_call',
      sessionId: 'sess-test',
      timestamp: 1,
      payload: { tool: 'read_file', success: false },
    };
    expect(rule.match(state, event)).toBe(false);
  });

  it('成功事件不触发', () => {
    const rule = new RetryRule();
    const state = makeState({ retries: 5 });
    const event: AgentLogEvent = {
      type: 'tool_call',
      sessionId: 'sess-test',
      timestamp: 1,
      payload: { tool: 'read_file', success: true },
    };
    expect(rule.match(state, event)).toBe(false);
  });

  it('edit 事件失败也触发', () => {
    const rule = new RetryRule();
    const state = makeState({ retries: 3 });
    const event: AgentLogEvent = {
      type: 'edit',
      sessionId: 'sess-test',
      timestamp: 1,
      payload: { file: 'a.ts', diffLines: 5, success: false },
    };
    expect(rule.match(state, event)).toBe(true);
  });

  it('自定义配置能覆盖默认阈值', () => {
    const config: RuleConfig = {
      ...DEFAULT_RULE_CONFIG,
      retry: { threshold: 1 },
    };
    const rule = new RetryRule(config);
    // 1 次失败在自定义阈值 1 上,触发
    const state = makeState({ retries: 1 });
    const event: AgentLogEvent = {
      type: 'tool_call',
      sessionId: 'sess-test',
      timestamp: 1,
      payload: { tool: 'read_file', success: false },
    };
    expect(rule.match(state, event)).toBe(true);
  });
});

// ---- PromptExplosionRule ----
describe('PromptExplosionRule', () => {
  it('在 prompt 增长 10k+ tokens 时触发', () => {
    const rule = new PromptExplosionRule();
    const state = makeState({ modelLimit: 100000 });

    // 第一次 llm_request:promptTokens=1000,增量 1000 < 10000,不触发
    const ev1: AgentLogEvent = {
      type: 'llm_request',
      sessionId: 'sess-test',
      timestamp: 1,
      payload: { promptTokens: 1000, completionTokens: 0 },
    };
    updateState(state, ev1);
    expect(rule.match(state, ev1)).toBe(false);

    // 第二次 llm_request:promptTokens=11000,累计 12000,增量 11000 >= 10000,触发
    const ev2: AgentLogEvent = {
      type: 'llm_request',
      sessionId: 'sess-test',
      timestamp: 2,
      payload: { promptTokens: 11000, completionTokens: 0 },
    };
    updateState(state, ev2);
    expect(rule.match(state, ev2)).toBe(true);
    const alert = rule.action(state, ev2);
    expect(alert).toBeDefined();
    expect(alert!.ruleId).toBe('prompt-explosion');
    expect(alert!.details!.promptTokens).toBe(12000);
  });

  it('增量不足 10k 时不触发', () => {
    const rule = new PromptExplosionRule();
    const state = makeState({ modelLimit: 100000 });

    const ev1: AgentLogEvent = {
      type: 'llm_request',
      sessionId: 'sess-test',
      timestamp: 1,
      payload: { promptTokens: 1000, completionTokens: 0 },
    };
    updateState(state, ev1);
    expect(rule.match(state, ev1)).toBe(false);

    // 增量 5000 < 10000
    const ev2: AgentLogEvent = {
      type: 'llm_request',
      sessionId: 'sess-test',
      timestamp: 2,
      payload: { promptTokens: 5000, completionTokens: 0 },
    };
    updateState(state, ev2);
    expect(rule.match(state, ev2)).toBe(false);
  });

  it('非 llm_request 事件不触发', () => {
    const rule = new PromptExplosionRule();
    const state = makeState();
    const event: AgentLogEvent = {
      type: 'tool_call',
      sessionId: 'sess-test',
      timestamp: 1,
      payload: { tool: 'read_file', success: true },
    };
    expect(rule.match(state, event)).toBe(false);
  });

  it('自定义配置能覆盖增长阈值', () => {
    const config: RuleConfig = {
      ...DEFAULT_RULE_CONFIG,
      promptExplosion: { growthThresholdTokens: 1000 },
    };
    const rule = new PromptExplosionRule(config);
    const state = makeState({ modelLimit: 100000 });

    // 第一次:增量 500 < 1000,不触发
    const ev1: AgentLogEvent = {
      type: 'llm_request',
      sessionId: 'sess-test',
      timestamp: 1,
      payload: { promptTokens: 500, completionTokens: 0 },
    };
    updateState(state, ev1);
    expect(rule.match(state, ev1)).toBe(false);

    // 第二次:增量 1500 >= 1000,触发
    const ev2: AgentLogEvent = {
      type: 'llm_request',
      sessionId: 'sess-test',
      timestamp: 2,
      payload: { promptTokens: 1500, completionTokens: 0 },
    };
    updateState(state, ev2);
    expect(rule.match(state, ev2)).toBe(true);
  });
});

// ---- LargeDiffRule ----
describe('LargeDiffRule', () => {
  it('在单次 edit >= 100 行时触发', () => {
    const rule = new LargeDiffRule();
    const state = makeState();
    const event: AgentLogEvent = {
      type: 'edit',
      sessionId: 'sess-test',
      timestamp: 1,
      payload: { file: 'big.ts', diffLines: 100, success: true },
    };
    expect(rule.match(state, event)).toBe(true);
    const alert = rule.action(state, event);
    expect(alert).toBeDefined();
    expect(alert!.ruleId).toBe('large-diff');
    expect(alert!.severity).toBe('info');
    expect(alert!.details!.file).toBe('big.ts');
    expect(alert!.details!.diffLines).toBe(100);
  });

  it('在 < 100 行时不触发', () => {
    const rule = new LargeDiffRule();
    const state = makeState();
    const event: AgentLogEvent = {
      type: 'edit',
      sessionId: 'sess-test',
      timestamp: 1,
      payload: { file: 'small.ts', diffLines: 99, success: true },
    };
    expect(rule.match(state, event)).toBe(false);
  });

  it('非 edit 事件不触发', () => {
    const rule = new LargeDiffRule();
    const state = makeState();
    const event: AgentLogEvent = {
      type: 'tool_call',
      sessionId: 'sess-test',
      timestamp: 1,
      payload: { tool: 'read_file', success: true },
    };
    expect(rule.match(state, event)).toBe(false);
  });

  it('自定义配置能覆盖默认阈值', () => {
    const config: RuleConfig = {
      ...DEFAULT_RULE_CONFIG,
      largeDiff: { threshold: 10 },
    };
    const rule = new LargeDiffRule(config);
    // 10 行在自定义阈值上,触发
    const state = makeState();
    const event: AgentLogEvent = {
      type: 'edit',
      sessionId: 'sess-test',
      timestamp: 1,
      payload: { file: 'a.ts', diffLines: 10, success: true },
    };
    expect(rule.match(state, event)).toBe(true);
  });
});

// ---- ModelSwitchRule ----
describe('ModelSwitchRule', () => {
  it('在模型名包含 mini 关键词时触发', () => {
    const rule = new ModelSwitchRule();
    const state = makeState();
    const event: AgentLogEvent = {
      type: 'llm_request',
      sessionId: 'sess-test',
      timestamp: 1,
      payload: { promptTokens: 100, completionTokens: 0, model: 'gpt-5-mini' },
    };
    expect(rule.match(state, event)).toBe(true);
    const alert = rule.action(state, event);
    expect(alert).toBeDefined();
    expect(alert!.ruleId).toBe('model-switch');
    expect(alert!.details!.model).toBe('gpt-5-mini');
  });

  it('在模型名包含 sonnet 关键词时触发', () => {
    const rule = new ModelSwitchRule();
    const state = makeState();
    const event: AgentLogEvent = {
      type: 'llm_request',
      sessionId: 'sess-test',
      timestamp: 1,
      payload: { promptTokens: 100, completionTokens: 0, model: 'claude-3-5-sonnet' },
    };
    expect(rule.match(state, event)).toBe(true);
  });

  it('模型名不含关键词时不触发', () => {
    const rule = new ModelSwitchRule();
    const state = makeState();
    const event: AgentLogEvent = {
      type: 'llm_request',
      sessionId: 'sess-test',
      timestamp: 1,
      payload: { promptTokens: 100, completionTokens: 0, model: 'gpt-5' },
    };
    expect(rule.match(state, event)).toBe(false);
  });

  it('非 llm_request 事件不触发', () => {
    const rule = new ModelSwitchRule();
    const state = makeState();
    const event: AgentLogEvent = {
      type: 'tool_call',
      sessionId: 'sess-test',
      timestamp: 1,
      payload: { tool: 'read_file', success: true },
    };
    expect(rule.match(state, event)).toBe(false);
  });

  it('自定义配置能覆盖关键词列表', () => {
    const config: RuleConfig = {
      ...DEFAULT_RULE_CONFIG,
      modelSwitch: { keywords: ['opus', 'haiku'] },
    };
    const rule = new ModelSwitchRule(config);
    // 'opus' 在自定义关键词中,触发
    const state = makeState();
    const event: AgentLogEvent = {
      type: 'llm_request',
      sessionId: 'sess-test',
      timestamp: 1,
      payload: { promptTokens: 100, completionTokens: 0, model: 'claude-opus' },
    };
    expect(rule.match(state, event)).toBe(true);

    // 'mini' 已不在自定义关键词中,不触发
    const event2: AgentLogEvent = {
      type: 'llm_request',
      sessionId: 'sess-test',
      timestamp: 2,
      payload: { promptTokens: 100, completionTokens: 0, model: 'gpt-5-mini' },
    };
    expect(rule.match(state, event2)).toBe(false);
  });
});
