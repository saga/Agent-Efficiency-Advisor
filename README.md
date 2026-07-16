# Agent-Efficiency-Advisor

Real-time observability agent for AI coding agents. Monitors Copilot (and potentially Claude Code, Codex CLI, Cursor, etc.) debug logs via tailing, detects inefficiencies, scores agent health, and recommends the right model size.

## Core idea

Instead of asking "Can GPT-5 be replaced by GPT-5-mini for this task?" (no counterfactual), we:

1. Stream agent debug logs in real time.
2. Maintain per-session state (tokens, tools, files, retries, loops).
3. Run lightweight, explainable rules.
4. Compute an **Agent Health Score** and model-size recommendation.
5. Eventually learn from historical outcomes (CatBoost/Random Forest) to calibrate recommendations.

This follows the pattern: **online collection → offline training → online prediction**.

## Architecture

### V2.5 Realtime Layer

```
Copilot Debug Log
       │
       ▼
┌──────────────┐     ┌─────────────┐     ┌─────────────┐
│   Watcher    │────▶│ TailManager │────▶│  LogParser  │
│  (chokidar)  │     │ (tail-file) │     │(per source) │
└──────────────┘     └─────────────┘     └──────┬──────┘
                                                 │
                                                 ▼
┌──────────────┐     ┌─────────────┐     ┌─────────────┐
│  Dashboard   │◀────│   Advisor   │◀────│   Metrics   │
│   (CLI)      │     │(Rule + ML)  │     │  + Health   │
└──────────────┘     └─────────────┘     └──────▲──────┘
                                                 │
                                                 ▼
                                        ┌─────────────┐
                                        │  RuleEngine │
                                        │(pluginable) │
                                        └──────▲──────┘
                                               │
                                               ▼
                                        ┌─────────────┐
                                        │ SessionState│
                                        │  Manager    │
                                        └─────────────┘
```

`LogParser.ts` now parses both the legacy synthetic AEA format and the real VSCode Copilot Agent Debug Log format (`ts`/`dur`/`sid`/`type`/`attrs`). Use `npm run real-copilot` to ingest logs from the default macOS path.

### V7 Observatory Layer

V7 在 V6 基础上强化了架构边界，核心演进为：

```
Event → Entity → Feature → Embedding → ML → Graph → LLM
```

1. **Canonical Entity Layer** (`src/entity/`): Session/Prompt/Completion/Workspace/ToolInvocation/Failure/Recommendation 7 个领域实体，统一事件与特征/图/嵌入/LLM 之间的语义。
2. **Feature Pipeline 三层拆分** (`src/store/aggregators/`, `src/store/calculators/`):
   - Aggregator: Event → Intermediate Aggregate
   - FeatureCalculator: Aggregate → Feature
   - FeatureStore: Persistence + Materialized View
3. **Embedding Provider 插件化** (`src/embedding/EmbeddingProvider.ts`): `feature-v1` 是默认实现，未来可接入 `text-embedding-3-small` / `nomic` / `bge-m3` 而无需修改 Pipeline。
4. **AnalyticsEngine 薄编排** (`src/ml/analyzers/`): 5 个独立 Analyzer（Behavior/Workflow/Trend/Failure/ROI）+ 编排器只负责 Merge。
5. **Three Registries** (`FeatureRegistry` / `EventRegistry` / `AnalyzerRegistry`): 补齐元数据体系，支持插件化扩展。
6. **Feature Materialized View** (`session_feature_view`): 保留 JSON Blob 的同时，为高频分析字段建立真实列，可直接用 SQL/DuckDB/CatBoost 查询。
7. **LabelStore 独立**: Label 与 Feature 生命周期解耦，Training Matrix 由 `LabelStore` 组装。

## Project structure

```
src/
  realtime/
    CopilotSource.ts    # chokidar + tail-file log source
    MockLogSource.ts    # mock events for demo
    TailManager.ts      # manage per-file tail instances
    EventBus.ts         # decouple parser from consumers
    LogParser.ts        # Copilot/generic JSONL parser
    SessionState.ts     # mutable session state updates
    SessionManager.ts   # session registry
    V6Sink.ts           # bridge: AgentLogEvent → IDEEvent → V6 SQLite
  rules/
    Rule.ts             # base rule + alert helper
    RuleEngine.ts       # evaluate all rules
    ruleRegistry.ts     # default rules
    ContextTooLargeRule.ts
    ReadFileStormRule.ts
    ToolLoopRule.ts
    RetryRule.ts
    PromptExplosionRule.ts
    LargeDiffRule.ts
    ModelSwitchRule.ts
  metrics/
    Metrics.ts          # live metrics builder
    HealthScorer.ts     # Agent Health Score
  advisor/
    Advisor.ts          # rule-based model recommendation
  dashboard/
    Dashboard.ts        # CLI dashboard renderer
  notifications/
    Notifier.ts         # console notifier
    NodeNotifier.ts     # OS notifications via node-notifier
  ml/                   # CatBoost model-size recommendation
    features.ts         # feature extraction for ML
    dataset.ts          # synthetic dataset generation + CSV export
    CatBoostTrainer.ts  # train CatBoost via Python bridge
    CatBoostModel.ts    # predict with trained .cbm model
    CatBoostAdvisor.ts  # real-time recommendation from SessionState
    shadow/             # shadow evaluation framework
      ShadowRunner.ts
    feedback/           # outcome → training data feedback loop
      FeedbackCollector.ts
  scripts/
    train_catboost.py   # Python training script
    predict_catboost.py # Python inference script
  entity/               # V7: Canonical Entity Layer (Session/Prompt/Completion/Workspace/ToolInvocation/Failure/Recommendation)
    types.ts            # 7 Entity interfaces + EntityBundle + EntityType
    EntityBuilder.ts    # Event → EntityBundle
  store/                # V6/V7 SQLite-backed Event Store + Feature Store
    types.ts            # IDEEvent + 5 feature domain interfaces
    schema.ts           # SQLite migrations (events / feature_* / embeddings / graph / session_feature_view)
    EventStore.ts       # event insert/query
    EventRegistry.ts    # V7: Event Schema + Provider Mapping + 版本管理
    FeatureStore.ts     # V7: versioned feature read/write + session_feature_view Materialized View
    LabelStore.ts       # V7: independent label storage + training matrix assembly
    FeatureRegistry.ts  # central feature catalog
    FeaturePipeline.ts  # V7: thin orchestrator over Aggregator → Calculator → Store
    aggregators/        # V7: Event → Intermediate Aggregate
      WorkspaceAggregator.ts
      SessionAggregator.ts
      PromptAggregator.ts
    calculators/        # V7: Aggregate → Feature
      WorkspaceFeatureCalculator.ts
      ContextFeatureCalculator.ts
      BehaviorFeatureCalculator.ts
  embedding/            # V6/V7 Layer 3: Embedding Store
    EmbeddingStore.ts   # SQLite-backed vectors + cosine similarity search
    EmbeddingProvider.ts        # V7: plugin interface
    FeatureEmbeddingProvider.ts # V7: feature-v1 provider
    EmbeddingPipeline.ts        # V7: provider-orchestrator (not hard-coded)
  ml/                   # CatBoost + V6/V7 Layer 4: Analytics Engine
    features.ts         # feature extraction for ML
    dataset.ts          # synthetic dataset generation + CSV export
    CatBoostTrainer.ts  # train CatBoost via Python bridge
    CatBoostModel.ts    # predict with trained .cbm model
    CatBoostAdvisor.ts  # real-time recommendation from SessionState
    BehaviorModel.ts    # first-order Markov chain over event sequences
    WorkflowMiner.ts    # Heuristic Miner for process discovery (reads Event directly)
    TrendAnalysis.ts    # linear-regression + 7-day rolling avg trend detection
    AnalyticsEngine.ts  # V7: thin orchestrator; only Merge
    AnalyticsSummary.ts # V7: strongly-typed LLM payload schema
    AnalyzerRegistry.ts # V7: registry for Behavior/Trend/Workflow/Failure/ROI analyzers
    analyzers/          # V7: 5 standalone analyzer plugins
      BehaviorAnalyzer.ts
      WorkflowAnalyzer.ts
      TrendAnalyzer.ts
      FailureAnalyzer.ts
      ROIAnalyzer.ts
    shadow/             # shadow evaluation framework
      ShadowRunner.ts
    feedback/           # outcome → training data feedback loop
      FeedbackCollector.ts
  llm/                  # V6/V7 Layer 5: LLM Insights Engine
    InsightsEngine.ts   # pi-ai driven natural-language insights (template fallback)
  graph/                # V6/V7 Layer 6: Session Graph (Temporal Property Graph)
    types.ts            # GraphNodeType / GraphEdgeType / GraphNode / GraphEdge
    GraphStore.ts       # SQLite node/edge storage + neighbor traversal
    GraphBuilder.ts     # V7: build graph from Entity (not raw Event); node stores featureVersion Reference
    GraphQueries.ts     # 4 canonical queries (retry-recovery, workspace failure, tool impact, failure clusters)
  history/              # V1/V2 historical trace analysis
    collector.ts
    featureExtractor.ts
    evaluator.ts
    outcomeSignals.ts
  types.ts              # shared types
  cli.ts                # real-time observability demo
  cli-train.ts          # CatBoost training demo
  cli-predict.ts        # CatBoost prediction demo
  cli-store.ts          # V6/V7 Event Store + Feature Store + LabelStore demo
  cli-v6.ts             # V6/V7 full 5-layer Observatory demo
```

## Quick start

```bash
npm install
uv venv              # create .venv
uv pip install       # install catboost + pandas from pyproject.toml

npm run demo        # real-time observability demo (rules)
npm run train       # train CatBoost model-size classifier (uses .venv)
npm run predict     # predict with trained model (uses .venv)
npm run v4          # real-time recommendation + shadow evaluation + feedback
npm run v5          # Agent Runtime Intelligence (state machine + event sourcing + plugins)
npm run trust       # Trustworthy Decision Engine (calibration + fusion + explainability + evaluation)
npm run store       # SQLite Event Store + Feature Store (event pipeline + behavior features)
npm run v6          # Full 6-layer Observatory demo (Event + Feature + Embedding + ML + LLM + Graph)
npm run real-copilot # ingest real VSCode Copilot Agent Debug Logs (macOS default path)
npm run demo        # Realtime V2.5 dashboard + V6Sink bridge (writes to SQLite in real-time)
npm run test        # run vitest test suite (55 tests across 7 files)
npm run typecheck   # verify types
npm run build       # compile to dist/
```

## Default rules

| Rule | Trigger |
|------|---------|
| ContextTooLarge | context >= 80% of model limit |
| ReadFileStorm | >= 20 read_file calls |
| ToolLoop | repeated tool pattern 4+ times |
| RetrySpike | >= 3 consecutive failures |
| PromptExplosion | prompt grows by 10k+ tokens |
| LargeDiff | single edit >= 100 lines |
| ModelSwitch | model changes mid-session |

## Roadmap

| Version | Focus | Status |
|--------|-------|--------|
| V1 | Pure trace logging | Done (history/) |
| V2 | Async evaluator + outcome signals | Done (history/) |
| V2.5 | Real-time tail + rules + health score | Done |
| V3 | Historical ML model (CatBoost/Random Forest) | Done |
| V4 | Real-time recommendation + shadow evaluation | Done |
| V5 | Agent Runtime Intelligence (state machine + event sourcing + plugins) | Done |
| V5.2 | Trustworthy Decision Engine (calibration + fusion + explainability + evaluation) | Done |
| V6 | AI Development Observatory (Event + Feature + Embedding + ML + LLM + Session Graph) | Done |
| V7 | Architecture Refactoring: Entity Layer + Split Feature Pipeline + Embedding/Analyzer Plugin + Materialized View + Registries | Done |

## Design constraints

- Do not modify the user's prompt.
- Do not force dual-model running in the normal workflow.
- Keep evaluation independent, asynchronous, and mostly LLM-free.
- Rules and parsers are pluginable; new agent support only needs a parser.
