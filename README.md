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
  history/              # V1/V2 historical trace analysis
    collector.ts
    featureExtractor.ts
    evaluator.ts
    outcomeSignals.ts
  types.ts              # shared types
  cli.ts                # demo entry
```

## Quick start

```bash
npm install
npm run demo        # run mock-source CLI demo
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
| V3 | Historical ML model (CatBoost/Random Forest) | Planned |
| V4 | Real-time recommendation + shadow evaluation | Planned |

## Design constraints

- Do not modify the user's prompt.
- Do not force dual-model running in the normal workflow.
- Keep evaluation independent, asynchronous, and mostly LLM-free.
- Rules and parsers are pluginable; new agent support only needs a parser.
