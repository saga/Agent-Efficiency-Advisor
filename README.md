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
  store/                # V6 SQLite-backed Event Store + Feature Store
    types.ts            # IDEEvent + 5 feature domain interfaces
    schema.ts           # SQLite migrations (events / feature_* / embeddings)
    EventStore.ts       # event insert/query
    FeatureStore.ts     # versioned feature read/write + training matrix
    FeatureRegistry.ts  # central feature catalog
    FeaturePipeline.ts  # 5 aggregators + 31 core feature definitions
  embedding/            # V6 Layer 3: Embedding Store
    EmbeddingStore.ts   # SQLite-backed vectors + cosine similarity search
    EmbeddingPipeline.ts# feature-based session/prompt vectors (log-scale + L2 norm)
  ml/                   # CatBoost + V6 Layer 4: Analytics Engine
    features.ts         # feature extraction for ML
    dataset.ts          # synthetic dataset generation + CSV export
    CatBoostTrainer.ts  # train CatBoost via Python bridge
    CatBoostModel.ts    # predict with trained .cbm model
    CatBoostAdvisor.ts  # real-time recommendation from SessionState
    BehaviorModel.ts    # first-order Markov chain over event sequences
    WorkflowMiner.ts    # Heuristic Miner for process discovery
    TrendAnalysis.ts    # linear-regression + 7-day rolling avg trend detection
    AnalyticsEngine.ts  # orchestrates ML + produces llmPayload for LLM layer
    shadow/             # shadow evaluation framework
      ShadowRunner.ts
    feedback/           # outcome → training data feedback loop
      FeedbackCollector.ts
  llm/                  # V6 Layer 5: LLM Insights Engine
    InsightsEngine.ts   # pi-ai driven natural-language insights (template fallback)
  history/              # V1/V2 historical trace analysis
    collector.ts
    featureExtractor.ts
    evaluator.ts
    outcomeSignals.ts
  types.ts              # shared types
  cli.ts                # real-time observability demo
  cli-train.ts          # CatBoost training demo
  cli-predict.ts        # CatBoost prediction demo
  cli-store.ts          # V6 Event Store + Feature Store demo
  cli-v6.ts             # V6 full 5-layer Observatory demo
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
npm run v6          # Full 5-layer Observatory demo (Event + Feature + Embedding + ML + LLM)
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
| V6 | AI Development Observatory (Event + Feature + Embedding + ML + LLM) | Done |

## Design constraints

- Do not modify the user's prompt.
- Do not force dual-model running in the normal workflow.
- Keep evaluation independent, asynchronous, and mostly LLM-free.
- Rules and parsers are pluginable; new agent support only needs a parser.
