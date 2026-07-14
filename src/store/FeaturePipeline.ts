// Feature Pipeline — Aggregators that turn Events into Features per domain.
// Run offline (on session end) or periodically. Writes are versioned.

import type Database from 'better-sqlite3';
import type { FeatureDefinition, FeatureDomain, IDEEvent } from './types.js';
import type { FeatureRegistry } from './FeatureRegistry.js';
import type { FeatureStore } from './FeatureStore.js';
import type { EventStore } from './EventStore.js';

const FEATURE_VERSION = 1;

export const CORE_FEATURE_DEFINITIONS: FeatureDefinition[] = [
  // Workspace
  { name: 'totalFiles', domain: 'workspace', description: 'Number of files in workspace', version: FEATURE_VERSION, owner: 'core' },
  { name: 'totalLOC', domain: 'workspace', description: 'Total lines of code', version: FEATURE_VERSION, owner: 'core' },
  { name: 'languageCount', domain: 'workspace', description: 'Number of programming languages', version: FEATURE_VERSION, owner: 'core' },
  { name: 'dependencyCount', domain: 'workspace', description: 'Number of dependencies', version: FEATURE_VERSION, owner: 'core' },
  { name: 'gitBranchCount', domain: 'workspace', description: 'Number of git branches observed', version: FEATURE_VERSION, owner: 'core' },
  { name: 'workspaceComplexity', domain: 'workspace', description: '0.4*log(fileCount)+0.3*lang+0.3*deps', version: FEATURE_VERSION, owner: 'core' },

  // Session
  { name: 'duration', domain: 'session', description: 'Session duration in ms', version: FEATURE_VERSION, owner: 'core' },
  { name: 'completionCount', domain: 'session', description: 'Number of completions', version: FEATURE_VERSION, owner: 'core' },
  { name: 'retryCount', domain: 'session', description: 'Number of retries', version: FEATURE_VERSION, owner: 'core' },
  { name: 'acceptCount', domain: 'session', description: 'Number of accepts', version: FEATURE_VERSION, owner: 'core' },
  { name: 'rejectCount', domain: 'session', description: 'Number of rejects', version: FEATURE_VERSION, owner: 'core' },
  { name: 'acceptRate', domain: 'session', description: 'accept/(accept+reject)', version: FEATURE_VERSION, owner: 'core' },
  { name: 'retryRate', domain: 'session', description: 'retry/completion', version: FEATURE_VERSION, owner: 'core' },

  // Prompt
  { name: 'tokenCount', domain: 'prompt', description: 'Prompt token count', version: FEATURE_VERSION, owner: 'core' },
  { name: 'historyLength', domain: 'prompt', description: 'Conversation history length', version: FEATURE_VERSION, owner: 'core' },
  { name: 'retrievedFiles', domain: 'prompt', description: 'Files referenced in prompt', version: FEATURE_VERSION, owner: 'core' },
  { name: 'retrievedSymbols', domain: 'prompt', description: 'Symbols referenced in prompt', version: FEATURE_VERSION, owner: 'core' },
  { name: 'promptDensity', domain: 'prompt', description: 'promptToken/contextToken', version: FEATURE_VERSION, owner: 'core' },
  { name: 'historyRatio', domain: 'prompt', description: 'historyToken/promptToken', version: FEATURE_VERSION, owner: 'core' },

  // Tool
  { name: 'terminalCalls', domain: 'tool', description: 'Terminal invocations', version: FEATURE_VERSION, owner: 'core' },
  { name: 'gitCalls', domain: 'tool', description: 'Git operations', version: FEATURE_VERSION, owner: 'core' },
  { name: 'mcpCalls', domain: 'tool', description: 'MCP server calls', version: FEATURE_VERSION, owner: 'core' },
  { name: 'filesystemCalls', domain: 'tool', description: 'Filesystem tool calls', version: FEATURE_VERSION, owner: 'core' },

  // Behavior (the innovation)
  { name: 'avgReadBeforeAsk', domain: 'behavior', description: 'Average files read before each chat/completion', version: FEATURE_VERSION, owner: 'core' },
  { name: 'avgRetryDistance', domain: 'behavior', description: 'Average events between retries', version: FEATURE_VERSION, owner: 'core' },
  { name: 'toolSwitchFrequency', domain: 'behavior', description: 'How often tool type changes in sequence', version: FEATURE_VERSION, owner: 'core' },
  { name: 'contextExpansionSpeed', domain: 'behavior', description: 'Tokens gained per event', version: FEATURE_VERSION, owner: 'core' },
  { name: 'workflowEntropy', domain: 'behavior', description: 'Shannon entropy of event-type distribution', version: FEATURE_VERSION, owner: 'core' },
  { name: 'retryBurstScore', domain: 'behavior', description: 'Max consecutive retries / total retries', version: FEATURE_VERSION, owner: 'core' },
  { name: 'editAfterAcceptRatio', domain: 'behavior', description: 'Edits immediately following an accept', version: FEATURE_VERSION, owner: 'core' },
  { name: 'workflowLength', domain: 'behavior', description: 'Total events in session', version: FEATURE_VERSION, owner: 'core' },
];

export class FeaturePipeline {
  constructor(
    private db: Database.Database,
    private eventStore: EventStore,
    private featureStore: FeatureStore,
    private registry: FeatureRegistry
  ) {}

  initializeRegistry(): void {
    this.registry.registerBatch(CORE_FEATURE_DEFINITIONS);
  }

  /**
   * Recompute features for one session and persist them (versioned).
   */
  computeSession(sessionId: string): { domains: FeatureDomain[] } {
    const events = this.eventStore.getBySession(sessionId);
    if (events.length === 0) return { domains: [] };

    const workspaceId = events[0].workspaceId;

    // Workspace features
    const wf = computeWorkspaceFeatures(workspaceId, events);
    this.featureStore.write('workspace', workspaceId, FEATURE_VERSION, wf);

    // Session features
    const sf = computeSessionFeatures(sessionId, events);
    this.featureStore.write('session', sessionId, FEATURE_VERSION, sf);

    // Prompt features (one row per promptId in metadata)
    const prompts = computePromptFeatures(events);
    for (const p of prompts) {
      this.featureStore.write('prompt', p.promptId, FEATURE_VERSION, p.features);
    }

    // Tool features (aggregate, stored under sessionId)
    const tf = computeToolFeatures(events);
    this.featureStore.write('tool', sessionId, FEATURE_VERSION, tf);

    // Behavior features — the high-value innovation
    const bf = computeBehaviorFeatures(events);
    this.featureStore.write('behavior', sessionId, FEATURE_VERSION, bf);

    return { domains: ['workspace', 'session', 'prompt', 'tool', 'behavior'] };
  }

  computeAllSessions(): { sessions: number; features: number } {
    const sessionIds = this.eventStore.getSessionIds();
    let featureRows = 0;
    for (const sid of sessionIds) {
      const result = this.computeSession(sid);
      featureRows += result.domains.length;
    }
    return { sessions: sessionIds.length, features: featureRows };
  }
}

function computeWorkspaceFeatures(workspaceId: string, events: IDEEvent[]): Record<string, number> {
  const files = new Set<string>();
  const languages = new Set<string>();
  const branches = new Set<string>();
  let totalLOC = 0;
  let deps = 0;

  for (const e of events) {
    const path = String(e.metadata.path ?? e.metadata.file ?? '');
    if (path) files.add(path);
    const lang = String(e.metadata.language ?? '');
    if (lang) languages.add(lang);
    const branch = String(e.metadata.branch ?? '');
    if (branch) branches.add(branch);
    if (typeof e.metadata.loc === 'number') totalLOC += e.metadata.loc;
    if (typeof e.metadata.dependencies === 'number') deps = Math.max(deps, e.metadata.dependencies);
  }

  const fileCount = files.size || 1;
  const complexity = 0.4 * Math.log(fileCount) + 0.3 * languages.size + 0.3 * deps;

  return {
    totalFiles: fileCount,
    totalLOC,
    languageCount: languages.size,
    dependencyCount: deps,
    gitBranchCount: branches.size,
    workspaceComplexity: Number(complexity.toFixed(3)),
  };
}

function computeSessionFeatures(sessionId: string, events: IDEEvent[]): Record<string, number> {
  const start = events[0]?.timestamp ?? 0;
  const end = events[events.length - 1]?.timestamp ?? 0;
  const duration = end - start;

  let completions = 0, retries = 0, accepts = 0, rejects = 0;
  for (const e of events) {
    if (e.eventType === 'completion') completions++;
    if (e.eventType === 'retry') retries++;
    if (e.eventType === 'accept') accepts++;
    if (e.eventType === 'reject') rejects++;
  }

  return {
    duration,
    completionCount: completions,
    retryCount: retries,
    acceptCount: accepts,
    rejectCount: rejects,
    acceptRate: accepts + rejects > 0 ? Number((accepts / (accepts + rejects)).toFixed(3)) : 0,
    retryRate: completions > 0 ? Number((retries / completions).toFixed(3)) : 0,
  };
}

function computePromptFeatures(events: IDEEvent[]): { promptId: string; features: Record<string, number> }[] {
  // Group chat events by promptId
  const byPrompt = new Map<string, IDEEvent[]>();
  for (const e of events) {
    if (e.eventType === 'chat') {
      const pid = String(e.metadata.promptId ?? e.id ?? `prompt-${e.timestamp}`);
      if (!byPrompt.has(pid)) byPrompt.set(pid, []);
      byPrompt.get(pid)!.push(e);
    }
  }

  const out: { promptId: string; features: Record<string, number> }[] = [];
  for (const [promptId, evts] of byPrompt) {
    const tokenCount = Number(evts[0].metadata.tokenCount ?? 0);
    const historyLength = Number(evts[0].metadata.historyLength ?? 0);
    const retrievedFiles = Number(evts[0].metadata.retrievedFiles ?? 0);
    const retrievedSymbols = Number(evts[0].metadata.retrievedSymbols ?? 0);
    const contextToken = Number(evts[0].metadata.contextToken ?? tokenCount);
    const historyToken = Number(evts[0].metadata.historyToken ?? 0);

    out.push({
      promptId,
      features: {
        tokenCount,
        historyLength,
        retrievedFiles,
        retrievedSymbols,
        promptDensity: contextToken > 0 ? Number((tokenCount / contextToken).toFixed(3)) : 0,
        historyRatio: tokenCount > 0 ? Number((historyToken / tokenCount).toFixed(3)) : 0,
      },
    });
  }
  return out;
}

function computeToolFeatures(events: IDEEvent[]): Record<string, number> {
  let terminal = 0, git = 0, mcp = 0, fs = 0;
  for (const e of events) {
    const tool = String(e.metadata.tool ?? '');
    if (e.eventType === 'terminal' || tool.includes('terminal')) terminal++;
    else if (e.eventType === 'commit' || tool.includes('git')) git++;
    else if (tool.includes('mcp')) mcp++;
    else if (e.eventType === 'read_file' || e.eventType === 'edit' || tool.includes('read') || tool.includes('file') || tool.includes('edit')) fs++;
    else if (e.eventType === 'tool_call') {
      // generic tool_call not matched above — count by tool name
      if (tool.includes('terminal')) terminal++;
      else if (tool.includes('git')) git++;
      else if (tool.includes('mcp')) mcp++;
      else fs++;
    }
  }
  return { terminalCalls: terminal, gitCalls: git, mcpCalls: mcp, filesystemCalls: fs };
}

/**
 * Behavior features — describe the dynamics of development, not just counts.
 * This is the high-value innovation from v6.md.
 */
function computeBehaviorFeatures(events: IDEEvent[]): Record<string, number> {
  const types = events.map((e) => e.eventType);
  const n = events.length;

  // avgReadBeforeAsk: count reads between chat/completion events
  let reads = 0, asks = 0, readsBeforeAsk = 0;
  for (const t of types) {
    if (t === 'read_file' || t === 'open_file') reads++;
    if (t === 'chat' || t === 'completion') {
      asks++;
      readsBeforeAsk += reads;
      reads = 0;
    }
  }
  const avgReadBeforeAsk = asks > 0 ? readsBeforeAsk / asks : 0;

  // avgRetryDistance: average number of events between retries
  const retryIdx = types.map((t, i) => (t === 'retry' ? i : -1)).filter((i) => i >= 0);
  let totalDistance = 0;
  for (let i = 1; i < retryIdx.length; i++) totalDistance += retryIdx[i] - retryIdx[i - 1];
  const avgRetryDistance = retryIdx.length > 1 ? totalDistance / (retryIdx.length - 1) : 0;

  // toolSwitchFrequency: how often adjacent events differ in "tool class"
  let switches = 0;
  for (let i = 1; i < types.length; i++) {
    if (types[i] !== types[i - 1]) switches++;
  }
  const toolSwitchFrequency = n > 1 ? switches / (n - 1) : 0;

  // contextExpansionSpeed: tokens gained per event
  let totalTokens = 0;
  for (const e of events) {
    totalTokens += Number(e.metadata.promptTokens ?? e.metadata.tokenCount ?? 0);
  }
  const contextExpansionSpeed = n > 0 ? totalTokens / n : 0;

  // workflowEntropy: Shannon entropy of event-type distribution
  const counts = new Map<string, number>();
  for (const t of types) counts.set(t, (counts.get(t) ?? 0) + 1);
  let entropy = 0;
  for (const c of counts.values()) {
    const p = c / n;
    entropy -= p * Math.log(p);
  }
  // Normalize by log(n) so 0..1
  const workflowEntropy = n > 1 ? Number((entropy / Math.log(n)).toFixed(3)) : 0;

  // retryBurstScore: longest run of consecutive retries / total retries
  let maxBurst = 0, currentBurst = 0, totalRetries = 0;
  for (const t of types) {
    if (t === 'retry') {
      currentBurst++;
      totalRetries++;
      if (currentBurst > maxBurst) maxBurst = currentBurst;
    } else {
      currentBurst = 0;
    }
  }
  const retryBurstScore = totalRetries > 0 ? maxBurst / totalRetries : 0;

  // editAfterAcceptRatio: edits immediately following an accept
  let editsAfterAccept = 0, accepts = 0;
  for (let i = 1; i < types.length; i++) {
    if (types[i - 1] === 'accept') {
      accepts++;
      if (types[i] === 'edit') editsAfterAccept++;
    }
  }
  const editAfterAcceptRatio = accepts > 0 ? editsAfterAccept / accepts : 0;

  return {
    avgReadBeforeAsk: Number(avgReadBeforeAsk.toFixed(3)),
    avgRetryDistance: Number(avgRetryDistance.toFixed(3)),
    toolSwitchFrequency: Number(toolSwitchFrequency.toFixed(3)),
    contextExpansionSpeed: Number(contextExpansionSpeed.toFixed(3)),
    workflowEntropy,
    retryBurstScore: Number(retryBurstScore.toFixed(3)),
    editAfterAcceptRatio: Number(editAfterAcceptRatio.toFixed(3)),
    workflowLength: n,
  };
}
