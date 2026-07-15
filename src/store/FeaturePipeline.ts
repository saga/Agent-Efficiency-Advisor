// FeaturePipeline — thin orchestrator.
// v7.md #1: 拆分为三层 — Aggregator (Event→Aggregate) → Calculator (Aggregate→Feature) → Store (Persistence)。
// 该类只负责编排这三层，不再包含任何聚合或计算逻辑。

import type { FeatureDefinition, FeatureDomain } from './types.js';
import type { FeatureRegistry } from './FeatureRegistry.js';
import type { FeatureStore } from './FeatureStore.js';
import type { EventStore } from './EventStore.js';
import { WorkspaceAggregator, SessionAggregator, PromptAggregator } from './aggregators/index.js';
import {
  WorkspaceFeatureCalculator,
  ContextFeatureCalculator,
  BehaviorFeatureCalculator,
} from './calculators/index.js';

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
  // v7.md #1: 三层职责分离，Pipeline 只持有各层组件并编排。
  private workspaceAggregator = new WorkspaceAggregator();
  private sessionAggregator = new SessionAggregator();
  private promptAggregator = new PromptAggregator();
  private workspaceCalculator = new WorkspaceFeatureCalculator();
  private contextCalculator = new ContextFeatureCalculator();
  private behaviorCalculator = new BehaviorFeatureCalculator();

  constructor(
    private featureStore: FeatureStore,
    private eventStore: EventStore,
    private registry: FeatureRegistry
  ) {}

  initializeRegistry(): void {
    this.registry.registerBatch(CORE_FEATURE_DEFINITIONS);
  }

  /**
   * Recompute features for one session: Aggregator → Calculator → Store.
   */
  computeSession(sessionId: string): { domains: FeatureDomain[] } {
    const events = this.eventStore.getBySession(sessionId);
    if (events.length === 0) return { domains: [] };

    const workspaceId = events[0].workspaceId;

    // Layer 1: Aggregator (Event → Aggregate)
    const workspaceAgg = this.workspaceAggregator.aggregate(workspaceId, events);
    const sessionAgg = this.sessionAggregator.aggregate(sessionId, events);
    const promptAggs = this.promptAggregator.aggregate(events);

    // Layer 2: Calculator (Aggregate → Feature)
    const workspaceFeatures = this.workspaceCalculator.calculate(workspaceAgg);
    const behaviorResult = this.behaviorCalculator.calculate(sessionAgg);
    const promptFeaturesList = promptAggs.map((p) => ({
      promptId: p.promptId,
      features: this.contextCalculator.calculate(p),
    }));

    // Layer 3: Store (Persistence)
    this.featureStore.write('workspace', workspaceId, FEATURE_VERSION, workspaceFeatures);
    this.featureStore.write('session', sessionId, FEATURE_VERSION, behaviorResult.session);
    this.featureStore.write('tool', sessionId, FEATURE_VERSION, behaviorResult.tool);
    this.featureStore.write('behavior', sessionId, FEATURE_VERSION, behaviorResult.behavior);
    for (const p of promptFeaturesList) {
      this.featureStore.write('prompt', p.promptId, FEATURE_VERSION, p.features);
    }

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
