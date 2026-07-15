# Agent-Efficiency-Advisor 发散性创新提升计划

> 基于 V1～V6 全代码通读后的分析与建议
> 日期：2026-07-15

---

## 现状总览

| 层 | 模块 | 数据模型 | 状态 |
|----|------|---------|------|
| V1/V2 | `src/history/` | `AgentTrace` JSONL | 离线，与 V6 数据模型不兼容 |
| V2.5 | `src/realtime/` + `rules/` + `metrics/` + `advisor/` + `dashboard/` | `AgentLogEvent` / `SessionState`（内存） | 实时，**不写 V6 SQLite** |
| V3 | `src/ml/`（CatBoost 系列） | `ModelSizeFeatures`（15 列） | 离线训练，**与 V6 FeatureStore 重复定义** |
| V4 | `src/ml/shadow/` + `feedback/` | CSV 文件 | **不写 V6 labels 表** |
| V5 | `src/v5/`（runtime + trust） | 自有 reducer / state machine | **与 V6 AnalyticsEngine 平行** |
| V6 | `src/store/` + `embedding/` + `ml/AnalyticsEngine` + `llm/` + `graph/` | `IDEEvent` SQLite | 完整六层，但**只用合成数据** |

**核心问题**：V6 基础设施已就绪，但 V1～V5 的能力没有接入 V6，形成"两套平行系统"。

---

## A. 整合统一（Priority: High）

把 V1～V5 的能力接入 V6 基础设施，消除重复定义与平行系统。

### A1. Realtime → V6 EventStore 桥接

**What**：在 `EventBus` 上加一个订阅者 `V6Sink`，把 `AgentLogEvent` 转换为 `IDEEvent` 实时写入 SQLite。

**Why**：当前 V2.5 的实时数据只在内存中流转（`SessionState.events`），session 结束后丢失。V6 的 EventStore 是空 的（只有合成数据）。这是"在线采集 → 离线训练 → 在线预测"闭环缺失的第一环。

**How**：
- 新建 `src/realtime/V6Sink.ts`，实现 `EventBus` 订阅接口
- 映射：`AgentLogEvent.type` → `IDEEvent.eventType`（如 `llm_request` → `chat`+`completion`，`tool_call` → `tool_call`，`edit` → `edit`）
- 映射：`AgentLogEvent.payload` → `IDEEvent.metadata`
- 在 `cli.ts` 中启动 V6Sink，让实时 demo 同时写 SQLite
- session 结束时触发 `FeaturePipeline.computeSession()`

**Files**: `src/realtime/V6Sink.ts`（新建）, `src/cli.ts`（修改）, `src/realtime/EventBus.ts`（可能加 subscribe 接口）

---

### A2. 统一特征定义（V3 ModelSizeFeatures → V6 FeatureStore）

**What**：让 V3 的 `CatBoostAdvisor` 从 V6 `FeatureStore` 读特征，而非自己从 `SessionState` 提取。

**Why**：当前有两套特征定义：
- V3 `src/ml/features.ts`：15 个特征（`FEATURE_COLUMNS`）
- V6 `src/store/FeaturePipeline.ts`：31 个特征（`CORE_FEATURE_DEFINITIONS`）

两者有大量重叠（`promptTokens`、`completionTokens`、`retries`、`retryRate`、`contextTokens`…），但定义略有差异（如 `retryRate` 的分母不同）。维护两套定义容易导致不一致。

**How**：
- 在 V6 FeatureStore 中加 `modelSize` domain，把 V3 的 15 个特征注册进去
- `CatBoostAdvisor.extractFeatures()` 改为 `featureStore.read('modelSize', sessionId)`
- V3 的 `extractModelSizeFeatures()` 标记为 deprecated，仅保留用于历史数据迁移
- 训练时用 `FeatureStore.getTrainingMatrix('modelSize', 'label')` 替代手动 CSV

**Files**: `src/ml/features.ts`（标记 deprecated）, `src/ml/CatBoostAdvisor.ts`（改读 FeatureStore）, `src/store/FeaturePipeline.ts`（加 modelSize aggregator）

---

### A3. CatBoost 作为 V6 失败分类器

**What**：V6 `AnalyticsEngine.classifyFailures()` 当前是规则版。把它替换为 CatBoost 分类器。

**Why**：规则版只能识别 4 种失败模式（retry_loop / context_explosion / wrong_context / user_cancel），且阈值硬编码。CatBoost 可以学习更细粒度的失败模式，并给出置信度。

**How**：
- 用 V6 GraphQueries 的失败聚类结果作为训练标签
- 训练一个多分类 CatBoost 模型（输入：behavior + session features，输出：failureType）
- `AnalyticsEngine.classifyFailures()` 改为调 `CatBoostModel.predict()`
- 保留规则版作为 fallback（无模型时用规则）

**Files**: `src/ml/AnalyticsEngine.ts`（修改）, `src/ml/FailureClassifier.ts`（新建，封装 CatBoost 调用）

---

### A4. Shadow Feedback → V6 labels 表

**What**：V4 `FeedbackCollector` 写 CSV。改为写 V6 SQLite `labels` 表。

**Why**：当前 feedback 数据在 `data/ml/feedback.csv`，与 V6 的 `labels` 表（已在 schema 中）分离。统一后可用 SQL JOIN 直接关联特征与标签，无需手动对齐。

**How**：
- `FeedbackCollector.record()` 改为 `featureStore.writeLabel(entityId, domain, label, source)`
- 保留 CSV 导出能力（`exportToCSV()` 方法）供 Python 训练用
- `FeatureStore.getTrainingMatrix()` 自动包含 shadow feedback 标签

**Files**: `src/ml/feedback/FeedbackCollector.ts`（修改）, `src/store/FeatureStore.ts`（确认 writeLabel 已实现）

---

### A5. V5 Trust Engine → V6 AnalyticsReport 增强

**What**：把 V5.2 的 `ConfidenceCalibration` / `DecisionFusion` / `Explainability` 接入 V6 `AnalyticsEngine`。

**Why**：V5.2 的可信决策能力（校准、融合、SHAP 解释）当前只在 `cli-trust.ts` 中独立运行。V6 的 `AnalyticsReport` 缺乏置信度校准和 SHAP 解释。

**How**：
- `AnalyticsEngine.analyze()` 末尾调用 `ConfidenceCalibration.calibrate(failures)`
- `ContextROI` 改用 V5.2 的 `FeatureImportance`（SHAP）替代当前 Pearson 相关系数
- `llmPayload` 增加 `calibratedConfidence` 和 `shapTopFeatures` 字段

**Files**: `src/ml/AnalyticsEngine.ts`（修改）, `src/v5/trust/`（复用）

---

## B. 创新功能（Priority: Medium-High）

### B1. 实时异常检测（Streaming Anomaly Detection）

**What**：在实时事件流上跑 Markov 模型，检测异常事件序列。

**Why**：当前 V6 的 `BehaviorModel` 是批量训练的。用户在 session 进行中无法知道"当前工作流是否异常"。实时检测可以在异常发生时立即告警。

**How**：
- `BehaviorModel` 加 `scoreSequenceIncremental(events: IDEEventType[])` 方法
- `V6Sink` 在每次事件到达时调 `scoreSequenceIncremental`
- 异常分超过阈值时通过 `Notifier` 发告警
- 复用 V2.5 的 `RuleEngine` 注册一个 `AnomalyRule`

**Files**: `src/ml/BehaviorModel.ts`（加方法）, `src/realtime/V6Sink.ts`（调方法）, `src/rules/AnomalyRule.ts`（新建）

---

### B2. 跨 Session 模式挖掘

**What**：用 Session Graph 发现跨 session 的因果模式。

**Why**：当前 GraphQueries 只做 4 个固定查询。真实场景中，用户可能想问"过去一周，哪些文件被频繁读取但从不编辑？"或"哪些 prompt pattern 总是导致 retry？"

**How**：
- `GraphQueries` 加 `findPattern(pattern: GraphPattern): Result[]` 通用查询
- 预定义几种 pattern：`frequent_read_no_edit`、`prompt_leads_to_retry`、`tool_before_failure`
- 用图遍历 + 频次统计实现

**Files**: `src/graph/GraphQueries.ts`（加方法）, `src/graph/GraphPattern.ts`（新建，pattern DSL）

---

### B3. Prompt 语义聚类

**What**：用 text embedding（而非 feature-based embedding）聚类相似 prompt。

**Why**：当前 `EmbeddingPipeline` 只用结构化特征生成向量。无法识别"帮我修这个 bug"和"修复错误"是同类 prompt。语义聚类可以发现 prompt pattern 与失败的相关性。

**How**：
- `EmbeddingPipeline` 加 `computePromptTextEmbeddings(model: string)` 方法
- 调用 OpenAI `text-embedding-3-small` 或本地 sentence-transformers
- 向量存入 `embeddings` 表，`model='text-embedding-3-small'`
- `findSimilarPrompts(promptText)` 用 cosine 检索
- 与失败分类关联：找出"总是导致 retry 的 prompt 语义簇"

**Files**: `src/embedding/EmbeddingPipeline.ts`（加方法）, `src/embedding/TextEmbedder.ts`（新建，调 OpenAI API）

---

### B4. Context ROI 优化器

**What**：基于 Context ROI 分析，主动推荐"应该从 context 中移除哪些文件"。

**Why**：当前 Context ROI 只输出"哪些特征与 acceptRate 正/负相关"。用户需要可操作的建议："移除 README.md，因为它对 accept 无贡献但消耗 2000 tokens"。

**How**：
- `AnalyticsEngine` 加 `optimizeContext(sessionId): ContextRecommendation[]`
- 输入：当前 session 的 prompt_file 边 + 每个 file 的 token 估算
- 输出：`{ file, tokens, roiScore, recommendation: 'keep'|'remove'|'truncate' }[]`
- 集成到 `llmPayload`，让 LLM 生成自然语言建议

**Files**: `src/ml/ContextOptimizer.ts`（新建）, `src/ml/AnalyticsEngine.ts`（集成）

---

### B5. 工作流漂移检测（Workflow Drift Detection）

**What**：比较当前 session 的工作流与历史典型工作流的偏离程度。

**Why**：`BehaviorModel.anomalyScore` 是全局的。用户需要知道"我这个 session 的工作流与过去 7 天的典型工作流差多远"。

**How**：
- `TrendAnalysis` 加 `detectWorkflowDrift(sessionId, windowDays=7): DriftReport`
- 用过去 N 天的 sessions 训练一个临时 Markov 模型
- 计算当前 session 在该模型下的对数概率
- 与基线（全量训练）对比，输出 drift score

**Files**: `src/ml/TrendAnalysis.ts`（加方法）, `src/ml/WorkflowDriftDetector.ts`（新建）

---

### B6. 自然语言图查询（NL Graph Query）

**What**：用 LLM 把自然语言问题转为 GraphQuery 调用。

**Why**：当前 `GraphQueries` 有 4 个固定方法。用户想问自定义问题（"上周哪些 session 因为读太多文件而失败？"）需要写代码。NL 接口让非技术用户也能查询。

**How**：
- `InsightsEngine` 加 `queryGraph(question: string): string` 方法
- LLM prompt 中包含 GraphQueries 的方法签名 + 当前图统计
- LLM 输出结构化 JSON：`{ "method": "failureClusterAnalysis", "args": {...} }`
- 执行后把结果再交给 LLM 生成自然语言回答

**Files**: `src/llm/GraphQueryEngine.ts`（新建）, `src/llm/InsightsEngine.ts`（集成）

---

### B7. 多 Agent 关系建模

**What**：扩展 Session Graph 支持子 Agent 关系。

**Why**：现代 AI 编程助手（如 Copilot Workspace、Claude Code）支持子 Agent。当前图模型只有 `session → tool`，无法表达"主 Agent 派生子 Agent 执行子任务"。

**How**：
- 加 `agent` 节点类型 + `agent_session` / `agent_parent`（子 Agent 关系）边类型
- `GraphBuilder` 解析 `session_start` metadata 中的 `parentSessionId`
- `GraphQueries` 加 `findSubAgentChains()` 查询

**Files**: `src/graph/types.ts`（加类型）, `src/graph/GraphBuilder.ts`（加逻辑）, `src/graph/GraphQueries.ts`（加查询）

---

### B8. 时间序列预测

**What**：用 Prophet / XGBoost 预测明天的 acceptRate / retryRate。

**Why**：当前 `TrendAnalysis` 只做线性回归 + 7 日滚动均值。无法预测"如果当前趋势持续，3 天后 acceptRate 会是多少"。

**How**：
- `TrendAnalysis` 加 `forecast(days=7): ForecastReport` 方法
- 简单版：用线性回归外推 + 置信区间
- 进阶版：调 Python XGBoost（复用 CatBoost 的 Python bridge）
- 输出加入 `llmPayload`，让 LLM 生成预警

**Files**: `src/ml/TrendAnalysis.ts`（加方法）, `src/scripts/forecast_xgb.py`（新建，可选）

---

## C. 代码质量（Priority: Medium）

### C1. 消除类型重复

**What**：统一 `AgentLogEvent`（V2.5）与 `IDEEvent`（V6）。

**Why**：当前两套事件类型并存，转换逻辑散落在各处。`AgentLogEvent.type` 是字符串联合，`IDEEvent.eventType` 也是字符串联合，但值不同（`llm_request` vs `chat`+`completion`）。

**How**：
- 以 `IDEEvent` 为唯一事件类型
- `LogParser` 直接输出 `IDEEvent`（而非 `AgentLogEvent`）
- `SessionState` 改为持有 `IDEEvent[]`
- V2.5 的 `updateState()` 改为消费 `IDEEvent`
- V1/V2 的 `AgentTrace` 标记为 legacy，加 `traceToEvents()` 迁移函数

**Files**: `src/types.ts`（标记 deprecated）, `src/realtime/LogParser.ts`（改输出）, `src/realtime/SessionState.ts`（改输入）

---

### C2. 规则阈值可配置化

**What**：把 7 个 rule 的硬编码阈值提取到配置文件。

**Why**：当前阈值散落在各 rule 文件中（如 `ContextTooLargeRule` 的 15000 tokens、`ReadFileStormRule` 的 20 次、`ToolLoopRule` 的 4 次重复）。用户无法在不改代码的情况下调整。

**How**：
- 新建 `src/rules/config.ts`，导出 `RuleConfig` 接口 + 默认值
- 每个 rule 从 config 读阈值
- 支持环境变量覆盖（如 `AEA_RULE_CONTEXT_TOO_LARGE=20000`）

**Files**: `src/rules/config.ts`（新建）, `src/rules/*.ts`（各改读 config）

---

### C3. 增量图更新

**What**：`GraphBuilder` 支持增量更新而非全量重建。

**Why**：当前 `build()` 调 `clear()` + 重建。session 数 > 1000 时重建耗时会显著增加。实时场景下，每个新 session 应只增量添加节点/边。

**How**：
- `GraphBuilder` 加 `addSession(sessionId)` 方法（只处理一个 session）
- `GraphStore` 加 `deleteSession(sessionId)` 方法（删除 session 相关节点/边）
- `V6Sink` 在 session 结束时调 `addSession`
- `build()` 保留为全量重建（用于修正数据不一致）

**Files**: `src/graph/GraphBuilder.ts`（加方法）, `src/graph/GraphStore.ts`（加 delete）

---

### C4. Embedding 近似最近邻

**What**：用 HNSW 替代线性扫描做 cosine 检索。

**Why**：当前 `EmbeddingStore.search()` 遍历全部向量。session 数 > 10k 时延迟会不可接受。

**How**：
- 引入 `hnswlib-node` 依赖
- `EmbeddingStore` 内部维护 HNSW 索引（启动时从 SQLite 加载）
- `write()` 同步更新 HNSW + SQLite
- `search()` 走 HNSW，返回近似 Top-K

**Files**: `src/embedding/EmbeddingStore.ts`（重构）, `package.json`（加依赖）

---

### C5. 数据保留策略

**What**：加 TTL / 归档机制，防止 SQLite 无限增长。

**Why**：当前所有事件、特征、向量、图节点都永久保留。长期运行后 SQLite 会膨胀到 GB 级。

**How**：
- `EventStore` 加 `prune(olderThan: number)` 方法
- `FeatureStore` 加 `pruneVersions(keepLatest: number)` 方法
- `EmbeddingStore` 加 `prune(olderThan: number)` 方法
- `GraphStore` 加 `prune(olderThan: number)` 方法
- 配置 `AEA_RETENTION_DAYS=90`（默认 90 天）

**Files**: 各 Store 文件（加 prune 方法）, `src/store/RetentionPolicy.ts`（新建）

---

### C6. 回归测试

**What**：为关键路径添加测试。

**Why**：当前项目零测试。V6 的 Feature 计算、Embedding 生成、Graph 构建都是纯函数，极易测试。

**How**：
- 引入 `vitest`（已在 dependencies 中）
- 测试目录结构：`tests/unit/`（纯函数）+ `tests/integration/`（跨模块）
- 优先测试：
  - `FeaturePipeline.computeBehaviorFeatures()`（8 个行为特征的正确性）
  - `EmbeddingPipeline.computeSessionVector()`（向量归一化 + log-scale）
  - `GraphBuilder.build()`（节点/边计数 + 去重逻辑）
  - `AnalyticsEngine.classifyFailures()`（4 种失败模式的判定）
  - `WorkflowMiner.mine()`（dependency metric 计算）

**Files**: `tests/`（新建目录）, `package.json`（加 `test` 脚本）

---

## D. 架构演进（Priority: Low-Medium）

### D1. CQRS 读写分离

**What**：明确 EventStore 为写模型，Feature/Embedding/Graph 为读模型。

**Why**：当前 EventStore 既是写入点又支持查询。读模型（Feature/Embedding/Graph）也从 EventStore 直接读，没有明确的 CQRS 边界。大规模下读写竞争会影响性能。

**How**：
- EventStore 只保留 `insert` / `insertBatch`（写）+ `getBySession`（读，仅用于重建）
- 新建 `EventReadModel` 封装所有查询（`getByType` / `getByWorkspace` / `getSessionIds`）
- Feature/Embedding/Graph Pipeline 只依赖 EventReadModel

**Files**: `src/store/EventStore.ts`（拆分）, `src/store/EventReadModel.ts`（新建）

---

### D2. 分析器插件化

**What**：把 ML 分析器（Markov / WorkflowMiner / Trend / Failure / ROI）注册为插件。

**Why**：当前 `AnalyticsEngine.analyze()` 硬编码 5 个分析步骤。新增分析器需要改 AnalyticsEngine。插件化后可以动态启用/禁用。

**How**：
- 定义 `Analyzer` 接口：`{ name, analyze(ctx): Partial<AnalyticsReport> }`
- `AnalyticsEngine` 维护 `analyzers: Analyzer[]`
- `analyze()` 遍历 analyzers，合并结果
- 配置 `AEA_ENABLED_ANALYZERS=markov,workflow,trend,failure,roi`（默认全开）

**Files**: `src/ml/Analyzer.ts`（新建接口）, `src/ml/AnalyticsEngine.ts`（重构）, 各分析器文件（实现接口）

---

### D3. 流式 Pipeline

**What**：用流式处理替代批量 `computeAllSessions()`。

**Why**：当前 Feature/Embedding/Graph 都是批量重建。实时场景下，session 结束时应立即触发计算。

**How**：
- `FeaturePipeline` 加 `onSessionEnd(sessionId)` 钩子
- `EmbeddingPipeline` 加 `onSessionEnd(sessionId)` 钩子
- `GraphBuilder` 加 `addSession(sessionId)`（见 C3）
- `V6Sink` 在 `session_end` 事件时调上述钩子

**Files**: `src/store/FeaturePipeline.ts`（加钩子）, `src/embedding/EmbeddingPipeline.ts`（加钩子）, `src/realtime/V6Sink.ts`（调钩子）

---

### D4. 多 Workspace 聚合

**What**：支持多 workspace 的跨域分析。

**Why**：当前 demo 只有一个 `ws-demo`。真实场景下用户有多个项目，需要跨 workspace 对比（"项目 A 的 accept rate 比项目 B 低，是因为什么？"）。

**How**：
- `AnalyticsEngine` 加 `compareWorkspaces(wsA, wsB): ComparisonReport`
- `GraphQueries` 加 `crossWorkspaceAnalysis()` 查询
- `TrendAnalysis` 支持按 workspace 分组

**Files**: `src/ml/AnalyticsEngine.ts`（加方法）, `src/graph/GraphQueries.ts`（加查询）

---

## 优先级排序

| 优先级 | 项目 | 预期收益 |
|--------|------|---------|
| P0 | A1. Realtime → V6 桥接 | 打通实时采集闭环 |
| P0 | C1. 消除类型重复 | 减少维护成本 |
| P0 | C6. 回归测试 | 防止回归 |
| P1 | A2. 统一特征定义 | 消除重复 |
| P1 | A3. CatBoost 失败分类器 | 提升 V6 分析能力 |
| P1 | A4. Shadow Feedback → labels | 统一数据源 |
| P1 | B1. 实时异常检测 | 实时价值 |
| P2 | A5. V5 Trust → V6 | 增强可信度 |
| P2 | B3. Prompt 语义聚类 | 深度洞察 |
| P2 | B4. Context ROI 优化器 | 可操作建议 |
| P2 | C2. 规则阈值配置化 | 可运维性 |
| P2 | C3. 增量图更新 | 性能 |
| P3 | B2. 跨 Session 模式挖掘 | 创新分析 |
| P3 | B5. 工作流漂移检测 | 趋势洞察 |
| P3 | B6. NL Graph Query | 用户体验 |
| P3 | B8. 时间序列预测 | 预警能力 |
| P3 | C4. HNSW 近似 NN | 规模化 |
| P3 | C5. 数据保留策略 | 长期运维 |
| P4 | B7. 多 Agent 关系建模 | 前瞻性 |
| P4 | D1. CQRS | 架构演进 |
| P4 | D2. 分析器插件化 | 扩展性 |
| P4 | D3. 流式 Pipeline | 实时性 |
| P4 | D4. 多 Workspace | 跨域分析 |

---

## 建议的下一步

1. **先做 A1 + C1 + C6**：打通实时采集闭环、统一类型、加测试保障
2. **再做 A2 + A3 + A4**：统一特征/标签/分类器，消除 V3/V4 与 V6 的重复
3. **然后做 B1 + B4**：实时异常检测 + Context ROI 优化器，让用户立即感受到 V6 的价值
4. **最后按需做其余项**

每个项目都应配一个端到端 demo（类似 `npm run v6`），让用户能直观验证效果。
