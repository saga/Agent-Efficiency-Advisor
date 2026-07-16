# Agent Efficiency Advisor 架构文档

> 版本：0.1.0  
> 更新日期：2026-07-10  
> 语言：中文

---

## 1. 项目目标与核心思想

### 1.1 项目目标

**Agent Efficiency Advisor（以下简称 AEA）** 是一个面向 AI 编程助手（如 GitHub Copilot、Claude Code、Codex CLI、Cursor 等）的实时可观测性代理。它通过持续监听被观测 Agent 的调试日志，实时评估任务复杂度与健康度，并给出模型规格（mini / medium / large）的选型建议，最终帮助用户降低成本、提升稳定性。

### 1.2 核心思想

传统思路是事后提问："这个任务能不能用小模型替代大模型？" 但这类问题没有反事实依据，难以回答。

AEA 采用 **在线采集 → 离线训练 → 在线预测** 的闭环：

1. **在线采集**：实时 tail Agent 调试日志，维护每个 Session 的运行状态。
2. **轻量规则**：基于可解释规则检测上下文膨胀、工具循环、重试风暴等异常。
3. **健康评分**：综合多项指标计算 Agent Health Score。
4. **模型建议**：结合规则与 CatBoost 机器学习模型，推荐合适的模型规格。
5. **影子评估 & 反馈**：通过 Shadow Evaluation 收集反事实结果，将真实 Outcome 回流为训练数据，持续校准推荐质量。

设计约束：

- 不修改用户原始 Prompt。
- 不在正常流程中强制并行运行双模型。
- 评估逻辑独立、异步、尽量脱离 LLM 调用，保持低成本与低延迟。

---

## 2. 总体架构图

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                              被观测 Agent                                    │
│            Copilot / Claude Code / Codex CLI / Cursor ...                   │
│                              │                                              │
│                              ▼                                              │
│                     ┌─────────────────┐                                     │
│                     │  Debug Log JSONL │                                    │
│                     └────────┬────────┘                                     │
└──────────────────────────────┼──────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              日志采集层 (Log Source)                          │
│  ┌──────────────┐     ┌─────────────┐     ┌─────────────┐                   │
│  │   Watcher    │────▶│ TailManager │────▶│  LogParser  │                   │
│  │  (chokidar)  │     │ (tail-file) │     │(per source) │                   │
│  └──────────────┘     └─────────────┘     └──────┬──────┘                   │
│                                                  │                          │
│  MockLogSource ──────────────────────────────────┘                          │
└─────────────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              事件总线 (EventBus)                              │
│                   解耦日志解析器与下游消费者，支持按类型订阅                      │
└─────────────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            Session 管理层                                    │
│  ┌─────────────────┐        ┌─────────────────┐                              │
│  │  SessionManager │───────▶│   SessionState  │                              │
│  │  (Session 注册表) │        │  (可变状态更新)  │                              │
│  └─────────────────┘        └─────────────────┘                              │
└─────────────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              推理与决策层                                     │
│  ┌─────────────────┐        ┌─────────────────┐        ┌─────────────────┐   │
│  │   RuleEngine    │───────▶│ Metrics+Health  │───────▶│     Advisor     │   │
│  │  (可插拔规则集)  │        │  (指标/健康评分) │        │ (规则/ML 建议)  │   │
│  └─────────────────┘        └─────────────────┘        └─────────────────┘   │
│                                                               │              │
│                          ┌────────────────────┐              │              │
│                          │   CatBoost Model   │◀─────────────┘              │
│                          │  (Python 桥接 .cbm) │                              │
│                          └────────────────────┘                              │
└─────────────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            影子评估与反馈层                                   │
│  ┌─────────────────┐        ┌─────────────────┐        ┌─────────────────┐   │
│  │   ShadowRunner  │───────▶│FeedbackCollector│───────▶│  feedback.csv   │   │
│  │   (反事实采样)   │        │  (训练样本累积)  │        │  (回流训练集)   │   │
│  └─────────────────┘        └─────────────────┘        └─────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              输出与通知层                                     │
│  ┌─────────────────┐        ┌─────────────────┐        ┌─────────────────┐   │
│  │    Dashboard    │        │    Notifier     │        │  NodeNotifier   │   │
│  │    (CLI 面板)   │        │   (控制台通知)  │        │  (系统级通知)   │   │
│  └─────────────────┘        └─────────────────┘        └─────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 分层说明

### 3.1 Log Source（日志采集层）

负责把不同 Agent 的原始调试日志转化为统一的 `AgentLogEvent` 事件流。

- **CopilotSource**：基于 `chokidar` 监听日志目录，基于 `tail-file` 对新增 JSONL 文件做增量 tail，按文件路径推断 `sessionId`。
- **MockLogSource**：生成模拟事件，用于演示与单元测试，不依赖真实 Agent。
- **TailManager**：管理每个被 tail 文件的实例，支持 add / remove / stopAll。
- **LogParser**：将原始 JSONL 行解析为结构化的 `AgentLogEvent`，当前提供 `CopilotParser`，未来可通过新增 Parser 支持其他 Agent。

统一事件类型包括：

- `session_start` / `session_end`
- `llm_request`
- `tool_call`
- `edit`

### 3.2 EventBus（事件总线）

轻量级发布-订阅实现，核心职责是解耦 Parser 与下游消费者。

- `on(type, handler)`：按事件类型订阅。
- `onAny(handler)`：订阅所有事件。
- `emit(event)`：广播事件。
- `offAll()`：清空所有订阅。

这样 Parser 无需知道谁会消费事件，SessionManager、RuleEngine、Metrics 等组件可以独立订阅。

### 3.3 Session State（会话状态）

每个 Session 维护一份可变状态，记录从始至终的运行指标。

关键字段：

- `sessionId`、`startedAt`、`elapsedMs`
- `promptTokens`、`completionTokens`、`contextTokens`、`cacheTokens`
- `toolCalls`、`readFiles`、`edits`、`retries`
- `contextBytes`、`contextTokens`、`modelLimit`
- `toolSequence`：工具调用序列，用于检测循环
- `filesRead`、`filesEdited`：已读/已编辑文件集合
- `events`：原始事件列表

`SessionState.ts` 提供：

- `createSessionState(sessionId)`：初始化状态。
- `updateState(state, event)`：根据事件增量更新状态。

`SessionManager` 负责维护 `Map<sessionId, SessionState>`，提供 `apply(event)` 自动获取或创建 Session。

### 3.4 Rule Engine（规则引擎）

可插拔的规则引擎，对每个事件在最新 Session 状态下求值，产出 `Alert`。

默认规则包括：

| 规则 | 触发条件 |
|------|---------|
| ContextTooLargeRule | 上下文达到模型上限的 80% |
| ReadFileStormRule | `read_file` 调用 >= 20 次 |
| ToolLoopRule | 工具序列出现 4 次以上重复模式 |
| RetryRule | 连续失败 >= 3 次 |
| PromptExplosionRule | Prompt 单次增长 >= 10k tokens |
| LargeDiffRule | 单次编辑 >= 100 行 |
| ModelSwitchRule | 会话中途切换模型 |

规则接口：

```ts
interface Rule {
  id: string;
  name: string;
  match(state: SessionState, event: AgentLogEvent): boolean;
  action(state: SessionState, event: AgentLogEvent): Alert | undefined;
}
```

新增规则只需实现 `Rule` 接口并在 `ruleRegistry.ts` 注册。

### 3.5 Metrics / Health（指标与健康评分）

#### Metrics

`Metrics.ts` 根据当前 `SessionState` 构建实时指标：

- `contextTokens`、`toolCalls`、`readFiles`、`edits`、`retries`
- `cost`：基于 $5 / 1M input tokens、$15 / 1M output tokens 粗略估算
- `latency`：会话已运行时间
- `loops`：工具序列循环次数
- `subAgents`、`cacheHit`

#### Health Score

`HealthScorer.ts` 综合五项子指标计算 0-100 的 Agent Health Score：

| 维度 | 权重 | 说明 |
|------|------|------|
| contextUtilization | 0.4 | 上下文占用率越低越好 |
| retryRate | 0.2 | 失败/重试比例越低越好 |
| loopDetected | 0.2 | 检测到循环则大幅扣分 |
| mcpLatency | 0.1 | 会话耗时越短越好 |
| promptGrowth | 0.1 | Prompt 增长越慢越好 |

输出标签：`Excellent` / `Good` / `Warning` / `Critical`。

### 3.6 Advisor（建议器）

Advisor 负责给出模型规格建议。项目提供两种实现：

#### 规则型 Advisor（`src/advisor/Advisor.ts`）

基于启发式规则：

- Prompt tokens < 8k、工具调用 <= 5、编辑文件 <= 2、无重试、无子 Agent → `mini`
- 复杂度 <= 60 → `medium`
- 否则 → `large`

输出 `Recommendation`：

```ts
interface Recommendation {
  model: 'mini' | 'medium' | 'large';
  confidence: number;
  estimatedSavingPercent: number;
  reasons: string[];
}
```

#### ML 型 Advisor（`src/ml/CatBoostAdvisor.ts`）

基于 CatBoost 分类模型，从 `SessionState` 提取 14 维特征，调用 Python 推理脚本返回类别概率，选择置信度最高的模型规格。

### 3.7 Shadow Evaluation（影子评估）

Shadow Evaluation 是 AEA 获取反事实证据的关键机制：不干扰主 Agent 运行，按采样率将部分 Session 在后台用推荐的小模型重跑，验证其是否也能成功。

- `ShadowRunner`：控制采样率、调用 `ShadowTaskRunner`、统计采样情况。
- `ShadowTaskRunner`：抽象接口，真实环境可接入真实小模型调用；当前提供 `MockShadowTaskRunner` 用于演示。
- `ShadowResult`：记录原始模型、影子模型、成功率、校准后的 label 与置信度。

若影子模型成功，则确认当前推荐；若失败，则将 label 向上调整（mini → medium → large）。

### 3.8 Feedback（反馈闭环）

`FeedbackCollector` 将两类信号回流为训练样本：

1. **Shadow 结果**：`recordShadowResult(state, label, confidence)`
2. **真实 Outcome**：`recordOutcome(state, outcome, recommendedModel)`

Outcome 信号包括：

- `testPassed`
- `committed`
- `noRetry`
- `noRevert`
- `followUpEditCount`
- `timeToNextPromptMs`

综合 successScore：

```text
successScore = testPassed*0.4 + committed*0.3 + noRetry*0.2 + noRevert*0.1
```

- `>= 0.8`：确认当前推荐 label
- `< 0.5`：将 label 上调一档
- 否则：模糊样本，跳过

样本写入 `data/ml/feedback.csv`，可用于重新训练 CatBoost 模型。

---

## 4. 数据流

```text
1. Agent 写入 Debug Log JSONL
        │
        ▼
2. CopilotSource (chokidar) 发现新文件
        │
        ▼
3. TailManager 启动 tail-file，逐行读取
        │
        ▼
4. CopilotParser 解析为 AgentLogEvent
        │
        ▼
5. EventBus 分发事件
        │
        ├──▶ SessionManager.apply(event) ──▶ 更新 SessionState
        │
        ├──▶ RuleEngine.evaluate(state, event) ──▶ 生成 Alert[]
        │
        ├──▶ Metrics.buildMetrics(state) ──▶ Metrics
        │
        └──▶ HealthScorer.computeHealthScore(state, metrics) ──▶ HealthScore
        │
        ▼
6. Advisor / CatBoostAdvisor 生成 Recommendation
        │
        ▼
7. Dashboard 渲染实时面板，Notifier 发送通知
        │
        ▼
8. session_end 时：
        ├── ShadowRunner 按采样率触发反事实评估
        ├── FeedbackCollector 记录 shadow / outcome 样本
        └── flush() 追加到 feedback.csv
        │
        ▼
9. 离线训练：feedback.csv + 合成数据 → CatBoostTrainer → model.cbm
        │
        ▼
10. 在线预测：CatBoostModel 加载 model.cbm，继续服务步骤 6
```

---

## 5. 项目结构

```text
Agent-Efficiency-Advisor/
├── src/
│   ├── realtime/              # 实时日志采集与 Session 管理
│   │   ├── LogSource.ts       # LogSource 抽象接口
│   │   ├── CopilotSource.ts   # Copilot 日志源（chokidar + tail-file）
│   │   ├── MockLogSource.ts   # 模拟日志源
│   │   ├── TailManager.ts     # tail 实例管理
│   │   ├── EventBus.ts        # 事件总线
│   │   ├── LogParser.ts       # JSONL 解析器
│   │   ├── SessionState.ts    # Session 状态创建与更新
│   │   └── SessionManager.ts  # Session 注册表
│   ├── rules/                 # 规则引擎与默认规则
│   │   ├── Rule.ts            # Rule 基类与 Alert 工厂
│   │   ├── RuleEngine.ts      # 规则求值器
│   │   ├── ruleRegistry.ts    # 默认规则注册
│   │   ├── ContextTooLargeRule.ts
│   │   ├── ReadFileStormRule.ts
│   │   ├── ToolLoopRule.ts
│   │   ├── RetryRule.ts
│   │   ├── PromptExplosionRule.ts
│   │   ├── LargeDiffRule.ts
│   │   └── ModelSwitchRule.ts
│   ├── metrics/               # 实时指标与健康评分
│   │   ├── Metrics.ts
│   │   └── HealthScorer.ts
│   ├── advisor/               # 基于规则的模型建议
│   │   └── Advisor.ts
│   ├── ml/                    # 机器学习模型建议
│   │   ├── features.ts        # 特征工程
│   │   ├── dataset.ts         # 数据集生成与 CSV 导出
│   │   ├── CatBoostTrainer.ts # 训练 Python 桥接
│   │   ├── CatBoostModel.ts   # 推理 Python 桥接
│   │   ├── CatBoostAdvisor.ts # 实时 ML 建议
│   │   ├── pythonResolver.ts  # Python 可执行文件解析
│   │   ├── shadow/
│   │   │   └── ShadowRunner.ts
│   │   └── feedback/
│   │       └── FeedbackCollector.ts
│   ├── dashboard/             # CLI 面板
│   │   └── Dashboard.ts
│   ├── notifications/         # 通知
│   │   ├── Notifier.ts
│   │   └── NodeNotifier.ts
│   ├── history/               # V1/V2 历史 trace 分析
│   │   ├── collector.ts
│   │   ├── featureExtractor.ts
│   │   ├── evaluator.ts
│   │   └── outcomeSignals.ts
│   ├── types.ts               # 共享类型定义
│   ├── index.ts               # 统一导出
│   ├── cli.ts                 # 实时可观测性 Demo
│   ├── cli-observatory.ts     # 完整 Observatory Demo
│   ├── cli-trust.ts           # Trustworthy Decision Engine Demo
│   ├── cli-store.ts           # Event Store + Feature Store Demo
│   ├── cli-train.ts           # CatBoost 训练 Demo
│   └── cli-predict.ts         # CatBoost 预测 Demo
├── scripts/
│   ├── train_catboost.py      # Python 训练脚本
│   └── predict_catboost.py    # Python 推理脚本
├── data/
│   ├── traces.jsonl           # 历史 trace 数据
│   └── ml/                    # 模型与训练数据
│       ├── model.cbm
│       ├── train.csv
│       ├── train.cd
│       ├── feedback.csv
│       └── feature_importance.json
├── package.json
├── pyproject.toml
├── tsconfig.json
├── README.md
└── ARCHITECTURE.md
```

---

## 6. V1-V4 演进

| 版本 | 模块位置 | 核心能力 | 状态 |
|------|---------|---------|------|
| **V1** | `src/history/` | 纯 trace 日志采集：将 Agent 运行轨迹以 JSONL 形式落盘 | Done |
| **V2** | `src/history/` | 异步评估器 + Outcome Signal：基于历史 trace 提取特征，评估任务复杂度与小模型替代可行性 | Done |
| **V2.5** | `src/realtime/` `src/rules/` `src/metrics/` | 实时 tail + 规则引擎 + Agent Health Score：从离线分析转向在线可观测 | Done |
| **V3** | `src/ml/` | 历史 ML 模型：使用 CatBoost / Random Forest 对模型规格进行分类 | Done |
| **V4** | `src/ml/shadow/` `src/ml/feedback/` | 实时推荐 + Shadow Evaluation + Feedback 闭环：在线推荐、反事实验证、样本回流（原独立 demo 已合并） | Done |

演进主线：

```text
离线 trace 记录  →  离线评估  →  实时规则观测  →  历史 ML 模型  →  实时 ML + 反事实反馈闭环
```

---

## 7. 技术栈

### 7.1 TypeScript / Node.js

- **TypeScript 5.5+**：主要业务语言。
- **tsx**：开发与 Demo 运行。
- **chokidar**：文件系统监听。
- **tail-file**：增量 tail 日志文件。
- **node-notifier**：系统级桌面通知。

### 7.2 Python

- **Python >= 3.9**
- **catboost >= 1.2.0**：梯度提升分类模型。
- **pandas >= 2.0.0**：训练数据处理。
- **uv**：虚拟环境与依赖管理（推荐）。

### 7.3 构建与运行

```bash
npm install
uv venv
uv pip install

npm run demo              # 实时规则观测 Demo
npm run demo:observatory  # 完整 Observatory Demo
npm run demo:store        # Event Store + Feature Store Demo
npm run train             # CatBoost 训练
npm run predict           # CatBoost 预测
npm run typecheck         # TypeScript 类型检查
npm run build             # 编译到 dist/
```

---

## 8. 扩展点

### 8.1 接入新的 Agent

只需新增 `LogParser` 实现，将目标 Agent 的日志格式转换为统一的 `AgentLogEvent`。

步骤：

1. 在 `src/realtime/LogParser.ts` 附近新增 Parser。
2. 实现 `AgentLogEvent` 的生成逻辑。
3. 创建对应的 `LogSource` 或在 `CopilotSource` 中替换 Parser。
4. 在 `src/index.ts` 导出。

### 8.2 新增规则

实现 `Rule` 接口，在 `ruleRegistry.ts` 注册即可。

### 8.3 自定义健康评分权重

调用 `computeHealthScore(state, metrics, customWeights)` 传入自定义 `HealthWeights`。

### 8.4 替换 ML 模型

当前通过 Python 脚本桥接 CatBoost。可替换为：

- 其他 Python 模型（LightGBM、XGBoost、Random Forest）。
- 本地 ONNX Runtime。
- 远程模型服务（HTTP API）。

只需保持 `ModelSizeFeatures` → `{ label, confidence, probabilities }` 的接口契约。

### 8.5 真实 Shadow Runner

实现 `ShadowTaskRunner` 接口，将 `MockShadowTaskRunner` 替换为真实的小模型调用逻辑。

### 8.6 Outcome 来源

当前 Demo 中 Outcome 由 `simulateOutcome` 模拟。生产环境可接入：

- Git 提交/回滚事件
- CI 测试结果
- 用户后续编辑次数
- 用户满意度信号

---

## 9. 生产化注意事项

### 9.1 日志采集

- 需要 Agent 输出结构化调试日志（JSONL）。
- 对高并发场景，建议按 `sessionId` 分目录或分文件，便于 CopilotSource 推断 Session。
- tail 文件句柄需及时清理，避免文件删除后句柄泄漏。

### 9.2 Session 生命周期

- `session_end` 事件必须可靠，否则 Session 会长期驻留内存。
- 建议为 SessionManager 增加超时清理策略（如 30 分钟无事件则清理）。

### 9.3 规则引擎

- 规则逐个串行执行，单个规则异常会被捕获，不影响其他规则。
- 规则数量增加后，可考虑按事件类型预过滤，减少无效计算。

### 9.4 ML 推理

- 当前每帧调用 Python 子进程推理，延迟较高。生产环境建议：
  - 使用 ONNX Runtime 在 Node.js 进程内推理。
  - 或启动常驻 Python 推理服务，通过 HTTP/gRPC 调用。
- 模型文件路径应可配置，支持模型热更新。

### 9.5 Shadow Evaluation

- 采样率需谨慎设置，避免成本失控。
- 真实 Shadow Runner 会引入额外模型调用成本，建议按任务复杂度或用户白名单采样。
- Shadow 结果应持久化，便于离线分析与模型再训练。

### 9.6 Feedback 与训练

- `feedback.csv` 持续增长，需定期归档、去重、平衡样本分布。
- 重新训练建议结合合成数据与真实反馈数据，避免分布偏移。
- 特征重要性（`feature_importance.json`）可用于监控模型行为，发现特征退化。

### 9.7 安全与隐私

- 调试日志可能包含代码、Prompt、文件路径等敏感信息。
- 日志传输与存储应加密，避免写入公开目录。
- Feedback CSV 中不应包含原始 Prompt 内容，仅保留特征数值。

### 9.8 可观测性

- AEA 本身也应被监控：规则执行耗时、推理延迟、Shadow 采样率、Feedback 样本量。
- 建议对自身关键路径增加 metrics 打点与日志记录。

---

## 10. 结语

Agent Efficiency Advisor 的核心价值在于：**在不干扰主 Agent 的前提下，通过实时观测、规则检测、健康评分、ML 推荐、影子评估与反馈闭环，持续优化 AI 编程助手的模型选型效率**。其模块化设计使得日志源、规则、模型、Shadow Runner、Outcome 来源均可独立演进，适合作为面向 Agent 的成本与质量优化基础设施。

---

## 11. V5 演进：Agent Runtime Intelligence Platform

V5 在 V4 的"实时推荐 + Shadow + Feedback 闭环"基础上做了根本性的架构升级：从"会话级计数器 + 单标量健康分"演进为"**事件溯源 + 状态机 + 多维健康 + 流式预测 + 插件化**"的 Agent Runtime Intelligence Platform。定位从单纯的 "Advisor"（给出模型选型建议）升级为面向 Agent 运行时的智能观测与决策平台。

### 11.1 架构图

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Agent Event Stream                                  │
│   Copilot / Claude Code / Cursor / Codex  →  RuntimeEvent                    │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          RuntimeEngine                                       │
│   ┌──────────────────────┐         ┌──────────────────────────────────┐      │
│   │   State Machine       │         │   Event Sourcing                 │      │
│   │  Idle→Planning→       │  reduce │   RuntimeEvent[] →               │      │
│   │  Thinking→CallingTool │◀────────│   不可变 RuntimeSnapshot          │      │
│   │  →Editing→Reviewing→  │         │   + replay / undo / time-travel  │      │
│   │  Finished/Failed      │         └──────────────────────────────────┘      │
│   └──────────────────────┘                                                   │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │ snapshot + events
        ┌──────────────────────────┼──────────────────────────┐
        ▼                          ▼                          ▼
┌──────────────────┐     ┌────────────────────┐     ┌──────────────────────┐
│ MetricsPipeline  │     │     RuleEngine      │     │  PredictionEngine     │
│ MetricProvider[] │     │   RuntimeRule[]     │     │   Predictor[]         │
│ (Prometheus 风格) │     │ (状态迁移感知规则)  │     │ Rule/Heuristic/ML/    │
│ ContextUsage     │     │  ctx-too-large      │     │ LLM Predictor         │
│ RetryRate        │     │  stuck-planning     │     │ → 置信度加权投票融合   │
│ LoopDetected     │     │  tool-loop-v5       │     │ → FusedPrediction     │
│ PromptGrowthRate │     │  phase-failed       │     │                       │
│ ToolDiversity    │     └─────────┬──────────┘     └──────────┬───────────┘
│ FileEntropy      │               │ Alert[]                    │
│ SubAgentPressure │               │                            │ Recommendation
│ StuckInPlanning  │               │                            │
└────────┬─────────┘               │                            │
         │ MetricSnapshot          │                            │
         ▼                         ▼                            ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                            MultiHealth (六维)                              │
│   Execution / Reasoning / Context / Tool / Planning / Memory              │
│   类 CPU / Memory / Disk / Network 多维系统健康                            │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                                Decision                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │Recommendation│  │    Alerts    │  │  V5Dashboard │  │ Feedback Loop│  │
│  │ (model 选型) │  │ (实时告警)    │  │ (Timeline)   │  │ (回流训练)   │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘  │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │ events / features
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                          离线训练闭环                                       │
│   FeatureStore  ──▶  OfflineTraining  ──▶  ModelRegistry  ──▶  PredictionEngine
│  (events 落盘)       (CatBoost / ML)        (model.cbm 热更新)   (MLPredictor) │
└──────────────────────────────────────────────────────────────────────────┘
```

### 11.2 核心改进

#### 11.2.1 Runtime State Machine

将 Agent 生命周期建模为显式状态机，状态迁移本身成为系统的核心信号源，而非依赖计数器阈值。

- **AgentPhase**：`Idle / Planning / Thinking / CallingTool / WaitingTool / Editing / Reviewing / Finished / Failed`
- 每个事件经 `derivePhase` 推导下一个 phase，并记录 `PhaseTransition { from, to, at, event }`。
- 规则可以基于"**状态迁移异常**"触发，例如：
  - `StuckInPlanningRule`：连续多次迁移到 `Planning` 即告警；
  - `PhaseFailedRule`：进入 `Failed` 状态即 critical 告警。
- 这让"Agent 卡在规划阶段"、"反复进/出同一阶段"等过去靠计数器难以捕捉的语义问题，变成一等公民。

类型定义见 `src/v5/runtime/types.ts`，迁移推导见 `src/v5/runtime/reducer.ts` 的 `derivePhase`。

#### 11.2.2 Event Sourcing

以不可变事件流为唯一事实来源，所有状态由 Reducer 派生，天然支持回放与时间旅行。

- `RuntimeSnapshot`：由 `reduce(prev, event)` 逐事件产出，调用方永不直接修改字段。
- `replay(events)`：从空快照重放全部事件，便于 schema 变更后重新水合。
- `snapshotAt(events, version)`：取出第 N 个事件后的快照，支持 undo / time-travel。
- `RuntimeEngine.getAtVersion(sessionId, version)`：在线时间旅行，定位历史任意时刻状态。
- 事件流可直接喂给离线 ML 管线（FeatureStore），ML 不再依赖"会话级汇总特征"，而是直接消费原始事件序列。

实现见 `src/v5/runtime/reducer.ts` 与 `src/v5/runtime/RuntimeEngine.ts`。

#### 11.2.3 Plugin Architecture

统一插件接口，规则、指标、预测器三类扩展点收敛到同一个 `Plugin` 概念，通过 `PluginRegistry` 注册。

```ts
interface Plugin {
  id: string;
  name: string;
  rules?: RuntimeRule[];
  metricProviders?: MetricProvider[];
  predictors?: Predictor[];
}
```

- `PluginRegistry.register(plugin)` 返回反注册函数，支持热插拔。
- `CorePlugins` 把内置 `CoreRulesPlugin / CoreMetricsPlugin / CorePredictorsPlugin` 打包，CLI 一行注册。
- 未来可接入：Copilot / Claude / Cursor / Codex 专用日志插件、Git 插件、Jira 插件、CI 插件，以及自定义 LLM/ML 预测插件。

实现见 `src/v5/plugins/PluginRegistry.ts` 与 `src/v5/plugins/CorePlugins.ts`。

#### 11.2.4 Derived Metrics Pipeline

引入 `MetricProvider` 抽象，类似 Prometheus Exporter：每个 Provider 只负责从一个 `RuntimeSnapshot` 计算一个派生指标。

```ts
interface MetricProvider {
  id: string;
  compute(snapshot: RuntimeSnapshot): number;
  description?: string;
}
```

`MetricsPipeline` 聚合所有 Provider，输出 `MetricSnapshot { values, descriptions }`，单个 Provider 异常不会污染其他指标（捕获后填 `NaN`）。

内置 MetricProvider（见 `src/v5/plugins/metrics/index.ts`）：

| Provider | 含义 |
|----------|------|
| `ContextUsageProvider` | 上下文 token 占用率（0-1） |
| `RetryRateProvider` | 工具调用与编辑的重试率 |
| `LoopDetectedProvider` | 近期工具序列是否出现循环（1/0） |
| `PromptGrowthRateProvider` | Prompt token 增长率（归一化到 50k） |
| `ToolDiversityProvider` | 唯一工具数 / 总调用数 |
| `FileEntropyProvider` | 读/写文件数熵（归一化到 30） |
| `SubAgentPressureProvider` | 子 Agent 数压力（归一化到 5） |
| `StuckInPlanningProvider` | 是否长期卡在 Planning 阶段（1/0） |

#### 11.2.5 Prediction Pipeline

`PredictionEngine` 聚合多个 `Predictor`，通过置信度加权投票融合出最终推荐，避免单预测器偏差。

```ts
interface Predictor {
  id: string;
  predict(ctx: PredictionContext): Promise<Recommendation> | Recommendation;
}
```

- `RulePredictor`：基于快照阈值的规则型预测。
- `HeuristicPredictor`：基于加权复杂度评分的启发式预测。
- 未来：`MLPredictor`（CatBoost / LightGBM）、`LLMPredictor`（直接调用 LLM 判断）。
- 融合策略：按 `confidence` 加权累计 `{mini, medium, large}` 三档票数，取最高权重档作为 `fused`，并归一化置信度，`source` 标注为 `fusion(rule+heuristic+...)`。
- `Recommendation` 新增 `source` 字段，便于追溯每个推荐的来源。

实现见 `src/v5/plugins/predictors/index.ts`。

#### 11.2.6 多维 Health

把 V4 的单一标量 HealthScore 拆成六维，类似操作系统的 CPU / Memory / Disk / Network 指标体系。

| 维度 | 关注点 |
|------|--------|
| Execution | 重试率、工具循环 |
| Reasoning | Prompt 增长、是否卡在规划 |
| Context | 上下文 token 占用率 |
| Tool | 工具多样性、循环 |
| Planning | 是否长期卡在 Planning |
| Memory | 文件熵、子 Agent 压力 |

每个维度输出 `0-100` 分与 `Excellent / Good / Warning / Critical` 标签，`overall` 取六维均值。`V5Dashboard` 直接渲染六维明细，便于定位"哪个维度在拖后腿"。

实现见 `src/v5/health/MultiHealth.ts`。

#### 11.2.7 Streaming Sliding Window

不再等 `session_end` 才出推荐，而是基于滑动窗口在事件流上实时触发预测。

`SlidingWindow` 支持三种触发条件：

- `maxEvents`：新增事件数阈值；
- `maxTokenDelta`：新增 token 阈值；
- `maxMs`：时间间隔阈值（且必须有新事件）。

`check(snapshot)` 返回 `{ shouldPredict, reason }`，`markPredicted(snapshot)` 重置基线。V5 demo 中曾以 `{ maxEvents: 3, maxMs: 1000, maxTokenDelta: 5000 }` 配置，实现"每 3 个事件或 5k token 或 1 秒"一次的流式刷新。

实现见 `src/v5/streaming/SlidingWindow.ts`，同时提供 `makeEvent` 辅助构造事件。

#### 11.2.8 Agent Timeline

类似 Chrome DevTools Performance 面板的时间线，把 phase 迁移与事件序列可视化。

- `buildTimeline(snapshot)`：为每个事件标注其发生时的 phase，并在发生迁移的事件上附加 `from → to` 注解。
- `renderTimeline(snapshot, width)`：用单字符 `· P T C W E R F X` 渲染 phase 条带，下方逐行列出 `时间 phase 事件摘要 [迁移注解]`。
- 便于复盘"Agent 在哪一步卡住、何时进入循环、何时失败"，是从"指标告警"到"根因定位"的关键桥梁。

实现见 `src/v5/timeline/Timeline.ts`。

#### 11.2.9 最终定位升级

从 "Agent Efficiency Advisor"（只负责给模型选型建议）升级为 **Agent Runtime Intelligence Platform**：

- 不只输出模型推荐，还输出实时告警、多维健康、时间线、反馈回流。
- 事件溯源 + 状态机让平台天然支持 replay / time-travel / 离线分析，ML 可直接读 events。
- 插件化让平台可承载 Copilot / Claude / Cursor / Codex / Git / Jira / CI 等多源生态。
- V5 引入独立 CLI 与仪表盘；后续版本演进中该独立 demo 已移除，核心能力（streaming、timeline、multi-health）保留在 `src/v5/`。

### 11.3 关键文件

| 路径 | 职责 |
|------|------|
| `src/v5/runtime/types.ts` | `RuntimeSnapshot` / `AgentPhase` / `Plugin` 等核心接口 |
| `src/v5/runtime/reducer.ts` | Event Sourcing reducer（reduce / replay / snapshotAt） |
| `src/v5/runtime/RuntimeEngine.ts` | 核心引擎，支持 time-travel / rehydrate / subscribe |
| `src/v5/plugins/PluginRegistry.ts` | 统一插件注册与反注册 |
| `src/v5/plugins/metrics/` | `MetricProvider` 实现 + `MetricsPipeline` 聚合 |
| `src/v5/plugins/predictors/` | `Predictor` 实现 + `PredictionEngine` 融合 |
| `src/v5/plugins/rules/index.ts` | 状态机感知的内置规则 |
| `src/v5/plugins/CorePlugins.ts` | 内置插件打包 |
| `src/v5/health/MultiHealth.ts` | 六维健康评分 |
| `src/v5/streaming/SlidingWindow.ts` | 流式预测滑动窗口 |
| `src/v5/timeline/Timeline.ts` | DevTools 风格时间线 |
| `src/v5/dashboard/V5Dashboard.ts` | V5 仪表盘渲染 |
| `src/cli-v5.ts` | V5 Demo 入口（已移除，能力并入 Observatory/Trust） |

### 11.4 V1-V5 演进对照

```text
V1 离线 trace
   → V2 离线评估
      → V2.5 实时规则观测
         → V3 历史 ML 模型
            → V4 实时 ML + Shadow + Feedback
               → V5 Runtime Intelligence（事件溯源 + 状态机 + 多维健康 + 流式预测 + 插件化）
```

V5 的本质变化是把"会话级聚合 + 单标量健康分"替换为"**事件级流式 + 状态机 + 多维健康 + 融合预测**"，并把所有扩展点统一到 Plugin 接口下，使平台具备承载多 Agent 生态与离线/在线 ML 闭环的能力。

---

## 12. V5.2 Trustworthy Decision Engine

V5.2 不再加新功能，而是把已有的 Recommendation / Confidence / Health / ML / Feedback 做到"**可信**"：有依据、可解释、可量化、可验证、可自我校准。核心理念是"从给出建议升级为给出可被审计的决策"。

### 12.1 设计理念

V5 已具备 Recommendation、Confidence、Health、ML、Feedback 等能力，但它们仍停留在"给一个数 / 给一个标签"的层面，缺乏可审计性与可校准性。V5.2 不再横向扩张功能，而是纵向深挖"可信度"：

- **有依据**：每个决策都要能追溯到具体特征贡献与反事实分析。
- **可解释**：不再是一个黑盒概率，而是给出 SHAP-like 特征贡献 + Counterfactual 反事实解释。
- **可量化**：置信度经过 Temperature Scaling 校准，并用 ECE / Brier Score 度量校准质量。
- **可验证**：通过 Shadow Sampling 与 Evaluation 持续验证决策质量，输出 A-F 等级的 Advisor Scorecard。
- **可自我校准**：通过 Online Learning + Drift Detection（Model Drift / Concept Drift）实现自我修正。

### 12.2 九大深挖方向

#### 12.2.1 Decision Engine

从 classifier 升级为 decision。原有的 `Recommendation` 只输出 `{ model, confidence, reasons }`，V5.2 在其上构建 **Rich Recommendation**，补充：

- **alternatives**：次优候选模型及其代价/风险。
- **risk**：`RiskAssessment`，量化选择该模型可能带来的失败/超时/成本风险。
- **expectedOutcome**：`ExpectedOutcome`，预测选择该模型后的预期表现（成功率、耗时、token 消耗）。
- **counterfactual**：`CounterfactualExplanation`，反事实解释"若改用另一档模型，结果会如何"。

实现方式：在 `DecisionEngine.decide()` 中串联 Fusion → Calibration → Explainability → Risk/ExpectedOutcome/Counterfactual，产出完整的 `TrustDecision`。

#### 12.2.2 Confidence Calibration

原始分类器输出的置信度往往 over-confident，V5.2 引入校准管线：

- **Temperature Scaling**：学习单一温度参数 `T`，对 logits 除以 `T` 后再 softmax，平滑过置信。
  - `calibrateTemperature(logits, labels)`：在验证集上通过牛顿法优化 `T`，最小化 NLL。
  - `applyTemperature(logits, T)`：在线推理时套用学到的 `T`。
- **ECE（Expected Calibration Error）**：将预测按置信度分桶，计算每桶"平均置信度 - 平均准确度"的加权绝对差，衡量校准误差。
  - `computeEce(predictions, labels, nBins=15)`。
- **Brier Score**：均方误差形式的概率校准指标，越低越好。
  - `computeBrierScore(probabilities, labels)`。

三者共同回答"模型的置信度是否可信"这一问题。

#### 12.2.3 Decision Fusion

V5 的 `PredictionEngine` 仅做置信度加权投票，V5.2 提供三种可切换的融合策略：

- **Weighted Voting**：按各 Predictor 的置信度或权重加权累计票数，取最高权重档。简单、可解释、鲁棒。
- **Bayesian Fusion**：把每个 Predictor 的输出视作独立似然，按贝叶斯公式融合为后验概率。适合 Predictor 间相互独立且各自有合理先验的场景。
- **Stacking**：训练一个元学习器（meta-learner）以各 Predictor 的输出为输入，学习最优组合权重。表达能力最强，但需要额外训练数据与离线流程。

实现方式：`fusePredictions(predictions, strategy, options)` 根据 `strategy` 分派到 `weightedVoting` / `bayesianFusion` / `stackingFusion`。

#### 12.2.4 Explainability

决策必须可解释，V5.2 提供两类解释：

- **SHAP-like 特征贡献**：`featureContributions(features, model)` 近似 SHAP，把最终决策分解为各特征的边际贡献，输出 `Reason[]`（含特征名、贡献值、方向）。用户能直接看到"上下文占用率贡献了 +0.3，重试率贡献了 -0.1"。
- **Counterfactual 反事实解释**：`findCounterfactual(features, model, desiredLabel)` 在特征空间中搜索"最小改动使得预测变为目标档位"的反事实样本，回答"如果上下文减少 X，就能降到 mini"这类问题。

两者结合，让决策从"模型说用 large"升级为"模型说用 large，因为 A/B/C 三个特征；若把 B 降下来，就能降到 medium"。

#### 12.2.5 Feature Engineering

不再依赖模型自带的 feature importance（容易被 correlated 特征误导），改用 **Permutation Importance** 衡量特征真实重要性：

- `permutationImportance(features, labels, predictFn, nRepeats=10)`：对每个特征，随机打乱其取值后重新预测，衡量指标下降幅度。下降越多说明该特征越重要。
- 输出按重要性排序的特征列表，可用于：特征筛选、监控特征退化、解释模型行为、指导数据采集。

#### 12.2.6 HealthScore

V4/V5 的 HealthScore 基于固定经验公式（如 `contextUtilization * 0.4 + retryRate * 0.2 + ...`），V5.2 升级为 **Composite Index**：

- 保留经验公式作为 baseline；
- 预留四种权重学习扩展点：
  - **AHP（层次分析法）**：领域专家两两比较维度重要性，推导权重。
  - **Entropy Weight**：根据各维度取值的离散程度自动赋权，离散度越大权重越高。
  - **PCA**：用主成分载荷作为权重，捕捉维度间共线性。
  - **ML 学习权重**：用回归/排序模型从 (维度值, 真实 outcome) 直接学权重。

接口上保留 `computeHealthScore(state, metrics, weights?)` 的可注入权重，使其从"固定公式"变为"可学习/可替换的复合指标"。

#### 12.2.7 Shadow Sampling

V4 的 Shadow 采样率是固定的，V5.2 提供四种采样策略，由 `decideSample(snapshot, strategy)` 决定是否采样：

- **Random**：按固定概率 `p` 采样，最简单、无偏。
- **Confidence**：对模型置信度处于"边界区"（既不高也不低）的样本优先采样，信息量最大。
- **Uncertainty**：对预测熵高 / 多预测器分歧大的样本优先采样，聚焦不确定区域。
- **Active**：结合置信度 + 不确定性 + 历史采样覆盖率，主动选择最值得标注的样本。

这样 Shadow 预算可被更聪明地分配，用更少的成本收集更有价值的反事实样本。

#### 12.2.8 Feedback

V5.2 把 Feedback 从"批量回流"升级为"在线学习 + 漂移检测"：

- **Online Learning**：新样本到达后增量更新模型权重（或触发增量重训练），缩短反馈到生效的延迟。
- **Drift Detection**：
  - **Model Drift**：`detectModelDrift(recentMetrics, baselineMetrics)` 比较近期预测分布与基线分布（如准确率、置信度均值、类别分布），若偏移超过阈值则告警。
  - **Concept Drift**：`detectConceptDrift(recentSamples, baselineSamples)` 比较 `P(Y|X)` 是否发生变化（如同样特征的真实 label 分布偏移），若发生则说明旧模型已失效，必须重训练。

漂移检测触发后，自动反馈到训练管线，形成"检测 → 重训练 → 校准 → 再评估"的闭环。

#### 12.2.9 Evaluation

V5.2 建立统一的评估体系，不再只看准确率：

- **统计指标**：Accuracy / Precision / Recall / F1 / Brier / ECE / ConfusionMatrix，由 `evaluate(predictions, labels)` 一次性产出。
- **业务指标**：成本节省率、推荐采纳率、Shadow 验证通过率、用户满意度等。
- **Advisor Scorecard**：`buildScorecard(metrics)` 把上述指标综合为 A-F 等级的评分卡：
  - **A**：各项指标均优秀，决策高度可信。
  - **B**：整体良好，个别维度需关注。
  - **C**：存在明显短板（如 ECE 过高 / Recall 偏低）。
  - **D**：多项指标不达标，需重训练或调参。
  - **F**：发生严重漂移或准确率崩塌，需立即介入。

Scorecard 既给运维一个"红黄绿灯"，也给模型治理提供可量化的准入/退出门槛。

### 12.3 架构图

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│                              Predictors                                       │
│   RulePredictor  HeuristicPredictor  MLPredictor  LLMPredictor  ...           │
└──────────────────────────────────┬───────────────────────────────────────────┘
                                   │  Recommendation[]
                                   ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                        DecisionFusion                                         │
│       weightedVoting  /  bayesianFusion  /  stackingFusion                    │
└──────────────────────────────────┬───────────────────────────────────────────┘
                                   │  fused logits / probabilities
                                   ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                    Temperature Scaling  (calibrate T)                         │
│                          applyTemperature(logits, T)                          │
└──────────────────────────────────┬───────────────────────────────────────────┘
                                   │  Calibrated Probabilities
                                   ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                            Explainability                                     │
│   SHAP-like Reasons  +  Counterfactual  +  Risk  +  ExpectedOutcome           │
│          featureContributions     findCounterfactual                          │
└──────────────────────────────────┬───────────────────────────────────────────┘
                                   │
                                   ▼
                           ┌────────────────┐
                           │  TrustDecision │
                           └───────┬────────┘
                                   │
        ┌──────────────────────────┴───────────────────────────┐
        ▼                                                      ▼
┌──────────────────────────────┐               ┌──────────────────────────────┐
│     EvaluationSamples        │               │       Feedback Loop          │
│  (Shadow Sampling 采样)      │               │   Online Learning            │
│  random/confidence/          │               │   + Drift Detection          │
│  uncertainty/active          │               │   (Model Drift +             │
└──────────┬───────────────────┘               │    Concept Drift)            │
           │                                   └──────────────┬───────────────┘
           ▼                                                  │
┌──────────────────────────────────────────┐                  │
│  ECE  /  Brier  /  F1  /  Scorecard      │                  │
│  (A-F 等级)                               │                  │
└──────────┬───────────────────────────────┘                  │
           │                                                  │
           └──────────────▶ 触发 Drift Detection ──────────────┘
                                   │
                                   ▼
                          反馈重训练 / 重校准
```

### 12.4 关键文件

| 路径 | 职责 |
|------|------|
| `src/v5/trust/types.ts` | `TrustDecision` / `Reason` / `RiskAssessment` / `ExpectedOutcome` / `CounterfactualExplanation` 等类型定义 |
| `src/v5/trust/ConfidenceCalibration.ts` | `calibrateTemperature` / `applyTemperature` / `computeEce` / `computeBrierScore` |
| `src/v5/trust/DecisionFusion.ts` | `fusePredictions` + `weightedVoting` / `bayesianFusion` / `stackingFusion` |
| `src/v5/trust/Explainability.ts` | `featureContributions`（SHAP-like） + `findCounterfactual` |
| `src/v5/trust/FeatureImportance.ts` | `permutationImportance` 排序真实重要特征 |
| `src/v5/trust/Evaluation.ts` | `evaluate`（Accuracy / P / R / F1 / Brier / ECE / ConfusionMatrix） + `buildScorecard` |
| `src/v5/trust/SamplingStrategy.ts` | `decideSample`（random / confidence / uncertainty / active） |
| `src/v5/trust/DriftDetector.ts` | `detectModelDrift` + `detectConceptDrift` |
| `src/v5/trust/DecisionEngine.ts` | `DecisionEngine.decide()` 整合 Fusion + Calibration + Explainability + Risk + Counterfactual |
| `src/v5/trust/TrustRenderer.ts` | `renderTrustDecision` / `renderScorecard` / `renderEvaluationMetrics` / `renderDrift` |
| `src/cli-trust.ts` | `npm run demo:trust` 端到端 Demo 入口 |

### 12.5 演进总结

```text
V1  Trace Collection        采集 Agent 运行轨迹，落盘 JSONL
   → V2  Offline Evaluation  离线评估任务复杂度与小模型替代可行性
      → V3  Realtime Observability  实时 tail + 规则引擎 + Health Score
         → V4  ML + Shadow + Feedback  CatBoost 推荐 + 反事实验证 + 样本回流
            → V5  Agent Runtime Intelligence  事件溯源 + 状态机 + 多维健康 + 流式预测 + 插件化
               → V5.2  Trustworthy Decision Engine  可信决策：校准 + 融合 + 可解释 + 可验证 + 自我校准
```

V5.2 的本质是把 V5 已有的"给出推荐"能力，升级为"给出**可信、可解释、可校准、可验证**的决策"。不再追求功能广度，而是把每一条决策都打磨到"有依据、可解释、可量化、可验证、可自我校准"的标准，使 Advisor 真正成为可被审计、可被信任的决策引擎。

---

## 13. V6 Event Store + Feature Store (SQLite)

V6 不再横向扩张决策能力，而是向下夯实基础设施层。核心论断来自 `v6.md`：**CatBoost + Embedding 只能完成约 60% 的能力**，真正阻碍后续行为建模、工作流挖掘、失败分类、Context ROI、相似 Session 检索与趋势分析的是缺一个**统一事件模型**与一套可版本化的特征存储。V6 的第一步就是把 Event Store 与 Feature Store 落到 SQLite，作为后续所有分析能力的共同基础。

### 13.1 设计理念

基于 `v6.md` 的"AI Development Observatory"构想，V6 确立两条原则：

1. **统一事件模型（Unified Event Model）是基础**。目前 Copilot、Cursor、Continue、Claude Code 各自的日志格式互不兼容，后续的 ML、Embedding、分析都受限。必须先把所有 Agent 源归一化为同一份 `IDEEvent`，再在其上做聚合。
2. **真正需要长期保存的数据只有两类：Event 与 Feature**。
   - **Event**：原始事实，不可变、可重放。
   - **Feature**：由 Event 聚合而来，可版本化、可重算。
   - **Embedding** 可以从 Event / Feature 重新计算，不必作为长期真相源。
   - **CatBoost** 可以从 Feature + Label 重新训练，模型文件只是派生产物。
   - **GPT** 输出的是解释，根本不需要保存。

存储选型上，**SQLite 足够个人 / 开源项目规模**：单文件、零运维、事务安全、WAL 模式下并发读良好；未来数据量增长到几十 GB 时，可平滑迁移到 DuckDB，SQL 接口几乎不变。无需引入 Redis / Elastic / ClickHouse / Feast 这类重型基础设施。

### 13.2 五层架构图

```text
┌──────────────────────────────────────────────────────────────────────────┐
│  Sources                                                                  │
│   Copilot  /  Cursor  /  Git  /  MCP  /  Terminal  /  Editor              │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │  归一化为 IDEEvent
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  Event Collector                                                          │
│   各源 Parser → 统一 IDEEvent 流                                           │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │  批量插入 (transaction)
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  Event Store (SQLite)                                                     │
│   events(id, timestamp, session_id, workspace_id, event_type, metadata)  │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │  bySession / byWorkspace / getSessionIds
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  Feature Pipeline (Aggregators)                                           │
│   Workspace / Session / Prompt / Tool / Behavior                          │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │  versioned write
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  Feature Store (SQLite) — 5 domain tables                                 │
│   feature_workspace  feature_session  feature_prompt                      │
│   feature_tool       feature_behavior                                     │
│   + feature_registry + labels                                             │
└──────────────┬───────────────────────────┬────────────────────────────────┘
               │                           │
               ▼                           ▼
   ┌────────────────────┐     ┌────────────────────────┐
   │  CatBoost 训练/推理  │     │  Dashboard / GPT 解释  │
   │  (getTrainingMatrix)│     │  (查 FeatureRegistry)  │
   └────────────────────┘     └────────────────────────┘
```

### 13.3 统一事件模型 IDEEvent

所有 Agent 源（Copilot / Cursor / Git / MCP / Terminal / Editor）最终都归一化为同一份 `IDEEvent`。定义见 `src/store/types.ts`：

```ts
export type IDEEventType =
  | 'open_file' | 'read_file' | 'edit' | 'completion' | 'accept' | 'reject'
  | 'retry' | 'tool_call' | 'terminal' | 'chat' | 'run_test' | 'commit'
  | 'session_start' | 'session_end' | 'error';   // 共 15 种

export interface IDEEvent {
  id?: number;
  timestamp: number;
  sessionId: string;
  workspaceId: string;
  eventType: IDEEventType;
  metadata: Record<string, unknown>;
}
```

- `eventType` 收敛为 15 种，覆盖文件操作、补全交互、工具调用、终端、测试、提交、会话生命周期与错误。
- `metadata` 是自由 JSON，承载各源特有的细节（路径、语言、token、diff、tool 名等），归一化层负责把源格式塞进去。
- 后续所有能力（Feature、Embedding、Graph、Mining）都是 `IDEEvent` 的不同聚合，不再各自重新解析原始日志。

### 13.4 Event Store (SQLite)

表结构（见 `src/store/schema.ts` 的 `migrate`）：

```sql
CREATE TABLE events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp    INTEGER NOT NULL,
  session_id   TEXT    NOT NULL,
  workspace_id TEXT    NOT NULL,
  event_type   TEXT    NOT NULL,
  metadata     TEXT    NOT NULL DEFAULT '{}'   -- JSON
);
```

索引覆盖四种典型查询路径：

| 索引 | 用途 |
|------|------|
| `idx_events_session` | 按 session 回放事件流 |
| `idx_events_type` | 按事件类型聚合（如统计所有 retry） |
| `idx_events_time` | 时间窗口扫描 / 趋势分析 |
| `idx_events_workspace` | 跨 session 的 workspace 级分析 |

`EventStore`（`src/store/EventStore.ts`）提供：

- `insert(event)`：单条插入，返回自增 id。
- `insertBatch(events)`：**事务批量插入**，避免逐条提交的开销。
- `getBySession(sessionId)`：按 session 取全部事件并按时间排序，供 Feature Pipeline 聚合。
- `getByType(eventType, limit)`：按事件类型查询。
- `getByWorkspace(workspaceId, from?, to?)`：按 workspace 查询，支持时间区间。
- `getSessionIds(workspaceId?)`：枚举（某 workspace 下的）所有 session。
- `count()`：事件总数，便于快速校验。

### 13.5 Feature Store (SQLite)

每个 domain 一张表，共 5 张：`feature_workspace` / `feature_session` / `feature_prompt` / `feature_tool` / `feature_behavior`。统一表结构：

```sql
CREATE TABLE feature_<domain> (
  entity_id    TEXT    NOT NULL,
  version      INTEGER NOT NULL,
  computed_at  INTEGER NOT NULL,
  features     TEXT    NOT NULL,         -- JSON blob
  PRIMARY KEY (entity_id, version)
);
```

设计要点：

- **主键 `(entity_id, version)` —— 版本化、不可覆盖**。同一实体可以同时存在 v1 / v2 多版本特征，老模型训练用的 v1 数据不会被新算法覆盖而作废。
- **`features` 字段存 JSON**。无需为每个新特征改 schema，新增特征只需在 `FeatureDefinition` 注册并在 Aggregator 里产出。
- **`labels` 表用于 ML 训练标签**：

  ```sql
  CREATE TABLE labels (
    entity_id TEXT, domain TEXT, label TEXT, source TEXT, created_at INTEGER,
    PRIMARY KEY (entity_id, domain, source)
  );
  ```

- **`getTrainingMatrix(domain, version, labelSource)` 自动 join features + labels**：先 `readAll(domain, version)` 取该版本全部特征，再用 `labels` 表过滤出有标签的样本，输出 `{ features, label, entityId }[]`，可直接喂给 CatBoost。

`FeatureStore`（`src/store/FeatureStore.ts`）提供：`write` / `writeBatch` / `read`（取最新或指定版本）/ `readAll`（取全部或指定版本）/ `getTrainingMatrix` / `writeLabel` / `latestVersion`。

### 13.6 Feature Registry

`feature_registry` 表统一管理所有 `FeatureDefinition`：

```sql
CREATE TABLE feature_registry (
  name        TEXT PRIMARY KEY,
  domain      TEXT NOT NULL,
  description TEXT NOT NULL,
  version     INTEGER NOT NULL,
  owner       TEXT NOT NULL
);
```

`FeatureRegistry`（`src/store/FeatureRegistry.ts`）提供 `register` / `registerBatch` / `getAll` / `getByDomain`。**Dashboard、CatBoost、GPT 三个消费方都查 Registry**，而不是各自硬编码特征名：Dashboard 据此渲染特征列表，CatBoost 据此对齐特征列序，GPT 据此知道每个数值的含义。新增特征只需在 Registry 注册一次，三个消费方同步可见。

### 13.7 Feature Pipeline (5 个 Aggregator)

`FeaturePipeline`（`src/store/FeaturePipeline.ts`）在 session 结束或周期性触发时，从 EventStore 取出 `IDEEvent[]`，分别聚合为 5 个 domain 的特征并版本化写入 FeatureStore。Aggregator 与对应特征如下：

| Aggregator | 关键特征 |
|------------|---------|
| **WorkspaceFeature** | `totalFiles` / `totalLOC` / `languageCount` / `dependencyCount` / `gitBranchCount` / `workspaceComplexity`（`0.4*log(fileCount)+0.3*lang+0.3*deps`） |
| **SessionFeature** | `duration` / `completionCount` / `retryCount` / `acceptCount` / `rejectCount` / `acceptRate`（`accept/(accept+reject)`）/ `retryRate`（`retry/completion`） |
| **PromptFeature** | `tokenCount` / `historyLength` / `retrievedFiles` / `retrievedSymbols` / `promptDensity`（`promptToken/contextToken`）/ `historyRatio`（`historyToken/promptToken`） |
| **ToolFeature** | `terminalCalls` / `gitCalls` / `mcpCalls` / `filesystemCalls` |
| **BehaviorFeature（核心创新）** | `avgReadBeforeAsk` / `avgRetryDistance` / `toolSwitchFrequency` / `contextExpansionSpeed` / `workflowEntropy` / `retryBurstScore` / `editAfterAcceptRatio` / `workflowLength` |

`CORE_FEATURE_DEFINITIONS` 共注册 **31 个特征定义**（6 + 7 + 6 + 4 + 8 = 31），在 `FeaturePipeline.initializeRegistry()` 时一次性写入 Registry。

### 13.8 Behavior Feature 详解 —— 为什么这是创新点

绝大多数 Copilot Analytics 项目停留在**事件统计层**（retryCount、acceptRate、latency 这类 Aggregation Feature）。V6 的核心创新是引入 **BehaviorFeature**：它描述的是**开发行为的动态模式**，而非事件计数。统计量回答"发生了多少次"，行为特征回答"过程长什么样"。

| Feature | 含义 |
|---------|------|
| `avgReadBeforeAsk` | 每次提问前平均读几个文件 —— 反映提问前的上下文准备 |
| `avgRetryDistance` | 相邻 retry 之间平均间隔多少事件 —— 反映重试是零星还是密集 |
| `toolSwitchFrequency` | 相邻事件类型切换频率 —— 反映工作流是否频繁跳转 |
| `contextExpansionSpeed` | 每个事件平均带来多少 token —— 反映上下文膨胀速度 |
| `workflowEntropy` | 事件类型分布的香农熵（归一化到 0..1）—— 反映工作流是否混乱 |
| `retryBurstScore` | 最长连续 retry / 总 retry —— 反映是否出现 retry 爆发 |
| `editAfterAcceptRatio` | accept 后立即 edit 的比例 —— 反映 AI 建议被接受后被立刻修改的程度 |
| `workflowLength` | session 总事件数 —— 反映工作流长度 |

以 `cli-store.ts` 中的三个合成 session 为例，三者事件计数可能相近，但行为特征差异显著：

- **sess-good（smooth workflow）**：`read → ask → accept → run → commit`，`workflowEntropy` 低、`retryBurstScore` 为 0、`toolSwitchFrequency` 平稳、`editAfterAcceptRatio` 低。一个流畅、可预测的会话。
- **sess-retry-storm（retry storm）**：反复 `retry`，`avgRetryDistance` 极小、`retryBurstScore` 接近 1、`workflowEntropy` 偏低（事件类型高度集中在 retry）。一个卡在某一步、反复撞墙的会话。
- **sess-context-explosion（context explosion）**：大量 `read_file` 与 `chat`，`contextExpansionSpeed` 高、`avgReadBeforeAsk` 高、`workflowEntropy` 偏高（事件类型分散）。一个上下文不断膨胀、提问准备过度的会话。

这三类 session 用传统计数特征难以区分，但用 BehaviorFeature 可以被清晰分离。这些特征是后续 CatBoost 失败分类、Embedding 聚类、Session 相似性、GPT 根因分析都可以共享的高价值输入。

### 13.9 特征版本化

特征算法会演进（如 `workspaceComplexity` 从 v1 的 `0.4*log+0.3*lang+0.3*deps` 升级为 v2 的更复杂公式）。若直接覆盖旧特征，所有用旧特征训练的模型会立即作废。V6 的做法：

- Feature 表主键含 `version`，**同一 entity 可并存多版本**，写入不覆盖。
- `FeatureDefinition` 自带 `version` 字段，Registry 里同名特征可以有多版本定义。
- `FeatureStore.read(domain, entityId, version?)` 可显式取指定版本，缺省取最新。
- `getTrainingMatrix(domain, version, labelSource)` 强制指定版本，保证一次训练内所有样本特征口径一致。

这样算法升级后，新版本特征与旧版本特征共存，老模型继续用老版本训练，新模型用新版本训练，过渡期可对比两版效果，避免一刀切作废全部历史训练数据。

### 13.10 关键文件表

| 路径 | 职责 |
|------|------|
| `src/store/types.ts` | `IDEEvent` / `IDEEventType`（15 种）/ `FeatureDefinition` / `FeatureRow` / 5 个 Feature 接口（`WorkspaceFeature` / `SessionFeature` / `PromptFeature` / `ToolFeature` / `BehaviorFeature`） |
| `src/store/schema.ts` | `openDatabase`（WAL + foreign_keys）+ `migrate`（建 `events` / `feature_*` / `feature_registry` / `labels` / `schema_meta` 表与索引） |
| `src/store/EventStore.ts` | `insert` / `insertBatch`（事务）/ `getBySession` / `getByType` / `getByWorkspace` / `getSessionIds` / `count` |
| `src/store/FeatureRegistry.ts` | `register` / `registerBatch` / `getAll` / `getByDomain` |
| `src/store/FeatureStore.ts` | `write` / `writeBatch` / `read` / `readAll` / `getTrainingMatrix`（join labels）/ `writeLabel` / `latestVersion` |
| `src/store/FeaturePipeline.ts` | 5 个 Aggregator（`computeWorkspaceFeatures` / `computeSessionFeatures` / `computePromptFeatures` / `computeToolFeatures` / `computeBehaviorFeatures`）+ `CORE_FEATURE_DEFINITIONS`（31 个定义）+ `computeSession` / `computeAllSessions` |
| `src/cli-store.ts` | `npm run demo:store` 端到端 demo：合成事件流 → 落 SQLite → 跑 Feature Pipeline → 查特征 → 物化训练矩阵 |

### 13.11 演进意义

V6 的定位是从 V5.2 的"**可信决策**"进一步下沉为"**AI Development Observatory**"的基础设施层。Event Store + Feature Store 不是又一个决策模块，而是后续所有分析能力的共同底座：

- **Embedding Store**：从 Event / Feature 生成 Session / Prompt / Workflow 向量，做相似 Session 检索。
- **Session Graph**：把 Session ↔ Prompt ↔ Workspace ↔ GitCommit ↔ Completion 之间的关係建模为时序属性图，许多分析可直接转化为图查询。
- **Workflow Mining**：直接吃 Event Log，用 Alpha / Heuristic / Inductive Miner 自动恢复真实工作流。
- **Context ROI**：用 CatBoost + SHAP 量化每类 Context（README / Git / History / Neighbor / Search）对 accept 的贡献，自动剔除低价值上下文。
- **趋势分析**：基于 Feature Store 的时间序列做 Accept Rate / Retry Rate 漂移检测（CatBoost 不擅长时序，需 Prophet / XGBoost / TFT）。
- **GPT 解释**：GPT 不再被浪费去读全量 Log，而是只读 Feature Store 产出的几百 token 摘要，输出自然语言根因分析与日报。

```text
V1  Trace Collection
  → V2  Offline Evaluation
    → V2.5  Realtime Observability
      → V3  ML Model
        → V4  ML + Shadow + Feedback
          → V5  Runtime Intelligence
            → V5.2  Trustworthy Decision
              → V6  Event Store + Feature Store（统一事件模型 + 版本化特征基础设施）
```

V6 的本质变化是把"决策能力"暂时放下，先把**统一事件模型**与**可版本化的特征存储**这两块基础设施落到 SQLite。从此 Embedding、CatBoost、GPT、Workflow Mining、Session Graph、Context ROI、趋势分析都不再各自重新解析日志，而是建立在同一份 Event 与 Feature 之上，使平台真正具备"AI Development Observatory"的底座。

---

## 14. V6 全五层架构（Embedding + ML + LLM）

V6 第 13 章把 Event Store 与 Feature Store 落到 SQLite。本章覆盖 `v6.md` 的第 3～11 节，把剩余三层补齐：

```
Layer 1  Event Store        ─┐
Layer 2  Feature Store      ─┤  见第 13 章
Layer 3  Embedding Store    ─┤  本章 14.1
Layer 4  ML / Analytics     ─┤  本章 14.2
Layer 5  LLM Insights       ─┘  本章 14.3
```

三层共享同一个 SQLite 文件（默认 `./data/aea-v6.db`），通过 `schema.ts` 的 `SCHEMA_VERSION=2` 增加 `embeddings` 表。

### 14.1 Layer 3：Embedding Store

**目标**：把 Session / Prompt / Workflow / Error / Workspace 实体转化为向量，支持 cosine 相似度检索，实现"相似 Session 召回"与"异常 Session 比对"。核心约束：**不依赖外部向量数据库**，纯 SQLite + TypeScript 实现。

#### 14.1.1 Schema

`schema.ts` 在 `SCHEMA_VERSION < 2` 时建 `embeddings` 表：

```sql
CREATE TABLE IF NOT EXISTS embeddings (
  entity_id   TEXT    NOT NULL,
  entity_type TEXT    NOT NULL,   -- session | prompt | workflow | error | workspace
  model       TEXT    NOT NULL,   -- e.g. 'feature-v1'
  dim         INTEGER NOT NULL,
  vector      TEXT    NOT NULL,   -- JSON float array
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (entity_id, entity_type, model)
);
CREATE INDEX IF NOT EXISTS idx_embeddings_type ON embeddings(entity_type);
```

向量以 JSON 浮点数组存储，避免引入 blob 编码成本。规模在数千 session 量级时，全表扫描 + TypeScript cosine 计算足够快；超过该量级再考虑 sqlite-vec 或迁移到专用向量库。

#### 14.1.2 EmbeddingStore

`src/embedding/EmbeddingStore.ts` 提供：

| 方法 | 作用 |
|------|------|
| `write(row)` | upsert 一条向量 |
| `read(entityId, entityType, model?)` | 读取单条 |
| `readAll(entityType, model?)` | 全量读取 |
| `search(queryVector, entityType, topK=10, model?)` | cosine 相似度 Top-K |
| `count(entityType, model?)` | 计数 |

`search` 的实现：读出该类型全部向量 → 逐条 `cosineSimilarity` → 降序排序 → 取前 K。同时导出 `cosineSimilarity(a, b)` 与 `normalize(v)` 工具函数，供其他模块复用。

#### 14.1.3 EmbeddingPipeline：Feature-based Embedding

`src/embedding/EmbeddingPipeline.ts` 采用 **Feature-based Embedding** 策略：不调用 Embedding API，直接从 BehaviorFeature + SessionFeature 抽取归一化向量。

**Session 向量（10 维）**——`SESSION_VECTOR_KEYS`：

```
workflowEntropy, retryBurstScore, toolSwitchFrequency, editAfterAcceptRatio,
avgReadBeforeAsk, avgRetryDistance, contextExpansionSpeed, workflowLength,
acceptRate, retryRate
```

其中 count-like 特征（`avgReadBeforeAsk` / `avgRetryDistance` / `contextExpansionSpeed` / `workflowLength` / `retryRate`）用 `Math.log1p` 压缩量纲，所有向量 L2 归一化。最终向量是 Session 的"行为指纹"——同样的事件计数可以产生截然不同的向量，这正是 V6 区别于传统 Aggregation Feature 的关键。

**Prompt 向量（5 维）**——`PROMPT_VECTOR_KEYS`：`promptTokens, completionTokens, retryCount, acceptCount, editDistance`。

`computeAll()` 一次性为所有 session / prompt 生成向量并写入 Store；`findSimilarSessions(sessionId, topK)` 排除自身后返回相似 session 列表。

#### 14.1.4 设计取舍

- **为何不调用 Embedding API**：v6.md 第 3 节明确说"Embedding 可以从 Event / Feature 重新计算，不必作为长期真相源"。Feature-based 方案完全离线、零成本、可复现。当需要语义级相似（如自然语言 prompt 聚类）时，可在同表用不同 `model`（如 `text-embedding-3-small`）并存一份语义向量，两套互不干扰。
- **为何不用 sqlite-vec**：当前数据规模（session 数 < 10k）下纯 TS 实现足够；引入 native 扩展会增加部署复杂度。架构上预留了替换空间——`EmbeddingStore.search` 是唯一需要替换的方法。

### 14.2 Layer 4：ML / Analytics Engine

**目标**：在 Feature / Embedding 之上做行为建模、工作流挖掘、趋势分析、失败分类、Context ROI，最终产出一份结构化 `AnalyticsReport`，供 LLM 层解释。

#### 14.2.1 BehaviorModel（一阶 Markov）

`src/ml/BehaviorModel.ts` 实现 v6.md 第 5 节。从所有 session 的事件类型序列学习转移矩阵 `P(next | current)`，输出：

- `states`：所有出现过的 `IDEEventType`
- `transitions`：`(from, to, count, probability)` 排序表
- `startDistribution`：首事件分布
- `topWorkflows`：从 top start state 贪心生成典型路径
- `anomalyScore`：所有 session 平均负对数似然（归一化到 [0,1]）

`scoreSequence(types)` 给定一段事件序列，返回其对数概率，用于异常检测。

#### 14.2.2 WorkflowMiner（Heuristic Miner）

`src/ml/WorkflowMiner.ts` 实现 v6.md 第 6 节。算法：

1. 遍历所有 session 事件序列，统计 **directly-follows 频率** `freq[A→B]`。
2. 计算 **dependency metric**：`(freq[A→B] - freq[B→A]) / (freq[A→B] + freq[B→A] + 1)`，范围 (-1, 1)，越接近 1 表示 A 真正"导致" B。
3. 抽取 **frequent paths**：从依赖强度 top 起贪心延伸，输出 top 5。
4. 抽取 **failure patterns**：含 retry 且无 accept，或以 reject 结尾的路径。

输出 `WorkflowGraph`：`nodes`（含 inDegree / outDegree / frequency）、`edges`（含 frequency / dependency）、`frequentPaths`、`failurePatterns`。这是后续 LLM 根因分析与日报的核心素材。

#### 14.2.3 TrendAnalysis

`src/ml/TrendAnalysis.ts` 实现 v6.md 第 10 节。按 `YYYY-MM-DD` 聚合事件，每天计算：

- `acceptRate` / `retryRate` / `avgTokens` / `sessionCount`

对每个时间序列做线性回归求 `slope`，按 `0.001 * mean` 阈值判定 `increasing / decreasing / stable`；再用 7 日滚动窗口平滑。`healthDirection` 的判定规则：

- acceptRate 上升 且 retryRate 未上升 → `improving`
- retryRate 上升 且 acceptRate 未上升 → `declining`
- 否则 → `stable`

#### 14.2.4 AnalyticsEngine（编排器）

`src/ml/AnalyticsEngine.ts` 是 Layer 4 的入口。它接收 EventStore + FeatureStore + EmbeddingStore，依次跑：

1. `BehaviorModel.train(sessions)`
2. `WorkflowMiner.mine(sessions)`
3. `TrendAnalysis.analyze(events)`
4. **Failure Classification**（规则版，CatBoost 可插拔）：
   - `retry_loop`：`retryBurstScore > 0.5 && retryRate > 0.3`
   - `context_explosion`：`contextExpansionSpeed > 500`
   - `wrong_context`：`workflowEntropy < 0.7 && retryRate > 0.2`
   - `user_cancel`：以 reject 结尾且无 accept
5. **Context ROI**：对每个数值特征计算与 `acceptRate` 的 Pearson 相关系数，过滤 `|corr| > 0.1`，作为 SHAP 的轻量替代。

最终产出 `AnalyticsReport`，其中 `llmPayload` 是约 500 token 的紧凑 JSON：

```json
{
  "sessions": 8, "events": 76,
  "avgAcceptRate": 0.389, "avgRetryRate": 1.611,
  "healthDirection": "declining",
  "topWorkflow": "session_start→read_file→...",
  "topFailure": "retry_loop",
  "topFailurePattern": "session_start→chat→completion→retry→reject→session_end",
  "anomalyScore": 0.083,
  "contextROI": [{"editAfterAcceptRatio": 1}, {"retryBurstScore": -1}],
  "trendAcceptRate": "decreasing", "trendRetryRate": "increasing"
}
```

这是 Layer 4 → Layer 5 的唯一契约。LLM 不再读全量 Log，只读这份摘要。

### 14.3 Layer 5：LLM Insights Engine

**目标**：v6.md 第 11 节明确"GPT 只负责解释"。`InsightsEngine` 接收 `AnalyticsReport.llmPayload`，用 LLM 生成自然语言根因分析与建议。

#### 14.3.1 框架选型：pi-ai

LLM 调用统一走 `@earendil-works/pi-ai`（pi-mono 框架）。选用理由：

- **多 provider 统一 API**：OpenAI / Anthropic / Google / Mistral / Bedrock 等 20+ provider 共用 `complete(model, context)` 接口。
- **env 自动注入 API key**：compat 模块读取 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` 等环境变量，无需手动传 key。
- **未来可平滑迁移到 `createModels()`**：当前用 deprecated 的 compat 顶层 API 是过渡方案，等 coding-agent ModelManager 迁移完成后再切到新 API，业务代码只需改 import 路径。

#### 14.3.2 实现

`src/llm/InsightsEngine.ts` 核心流程：

1. `ensureInitialized()`：lazy `import('@earendil-works/pi-ai/compat')`，调 `getModel(provider, id)` 解析模型。
2. `generate(report)`：构造 `Context`（systemPrompt + 1 条 user message 携带 `llmPayload`），调 `complete(model, context)`。
3. 从 `response.content` 提取 `text` block。
4. **Fallback 判定**：若 `text` 为空 或 `usage.input === 0 && usage.output === 0`（典型无 API key 场景），回退到 `templateExplanation(report)`。
5. 异常时同样回退 template，并附 `[LLM fallback: <err>]` 标注。

**关键 workaround**：tsx 无法解析 `package.json` 的 `exports` 子路径（即使 `./compat` 在 exports map 中）。改用 **dynamic `import()`** 让 Node.js 原生 ESM loader 处理，绕过 tsx 的 resolver。静态 `import type` 只取类型，不触发运行时解析。

#### 14.3.3 配置

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `AEA_LLM_PROVIDER` | `openai` | pi-ai provider id |
| `AEA_LLM_MODEL` | `gpt-4o-mini` | 模型 id（轻量优先） |
| `OPENAI_API_KEY` | — | 由 compat 自动读取 |

未配置 API key 时自动回退到 `templateExplanation`，按 v6.md 第 11 节示例格式输出中文结构化分析（健康度 / 主要失败 / Context ROI / 趋势 / 工作流 / 建议）。

#### 14.3.4 Template Explanation

`templateExplanation(report)` 按 v6.md 第 11 节示例输出：

- 会话与事件总数
- 健康度方向（improving / declining / stable）
- 主要失败模式 + 典型失败路径
- Context ROI 正/负向特征
- 趋势（acceptRate / retryRate）
- 最常见工作流
- 针对性建议（按 `topFailure` 分支：retry_loop / context_explosion / wrong_context）

### 14.4 端到端 Demo

`npm run demo:observatory` 跑 `src/cli-observatory.ts`，生成 3 天 × 8 session × 76 event 的合成数据，依次过 5 层：

```
─── Layer 1: Event Store ───            76 events, 8 sessions
─── Layer 2: Feature Store ───          40 feature rows
─── Layer 3: Embedding Store ───        8 session + 8 prompt vectors, cosine search
─── Layer 4: ML / Analytics ───         Markov + Heuristic Miner + Trend + Failure + ROI
─── Layer 5: LLM Insights ───           pi-ai (template fallback when no API key)
```

输出包含：行为特征样本、相似 session Top-5、Markov 转移表与异常分、工作流图与失败模式、趋势方向与斜率、失败分类标签、Context ROI 相关系数、`llmPayload` JSON、最终自然语言 insight。

### 14.5 文件清单

| 路径 | 职责 |
|------|------|
| `src/store/schema.ts` | `SCHEMA_VERSION=2`，新增 `embeddings` 表迁移 |
| `src/embedding/types.ts` | `EmbeddingEntityType` / `EmbeddingRow` / `SimilarityResult` |
| `src/embedding/EmbeddingStore.ts` | SQLite 向量存储 + cosine 检索 + `cosineSimilarity` / `normalize` |
| `src/embedding/EmbeddingPipeline.ts` | Feature-based 10 维 session 向量 + 5 维 prompt 向量 |
| `src/embedding/index.ts` | barrel export |
| `src/ml/BehaviorModel.ts` | 一阶 Markov 链 + 异常分 + 典型工作流生成 |
| `src/ml/WorkflowMiner.ts` | Heuristic Miner：directly-follows + dependency metric |
| `src/ml/TrendAnalysis.ts` | 日级指标 + 线性回归 + 7 日滚动均值 + health direction |
| `src/ml/AnalyticsEngine.ts` | 编排 ML 全家桶 + 失败分类 + Context ROI + `llmPayload` |
| `src/llm/InsightsEngine.ts` | pi-ai 调用 + template fallback |
| `src/llm/index.ts` | barrel export |
| `src/cli-observatory.ts` | `npm run demo:observatory` 端到端 demo |

### 14.6 演进意义

V6 全五层补齐后，AEA 真正成为 **AI Development Observatory**：

- **统一底座**：Event Store 是唯一真相源，Feature / Embedding / ML / LLM 都是其上聚合。
- **离线可重建**：Embedding 与 Feature 都可从 Event 重新计算，不是长期真相源。
- **LLM 受控**：GPT 只解释几百 token 的结构化摘要，不读全量 Log，成本与延迟可控。
- **可插拔**：失败分类当前是规则版，后续可换 CatBoost；Embedding 当前是 Feature-based，后续可并存语义向量；LLM 层当前用 compat，后续可切 `createModels()`。

```text
V1  Trace Collection
  → V2  Offline Evaluation
    → V2.5  Realtime Observability
      → V3  ML Model
        → V4  ML + Shadow + Feedback
          → V5  Runtime Intelligence
            → V5.2  Trustworthy Decision
              → V6  Event Store + Feature Store
                → V6 Full  Embedding + ML + LLM（五层闭环）
```

V6 全五层完成的本质，是把 V6 第 13 章落下的基础设施真正转化为可观测、可分析、可解释的闭环。Event → Feature → Embedding → ML → LLM 的单向数据流，使任何一层都可以独立替换或升级，而不影响其他层。

---

## 15. V6 Session Graph（时序属性图）

V6 第 14 章完成五层闭环后，v6.md 第 12 节提出"还缺一层"——**Session Graph**。这一层不引入新的数据源，而是把 Event / Feature / Embedding 已有的实体与关系建模为**时序属性图（Temporal Property Graph）**，使许多原本需要扫描全量日志的分析直接转化为图查询。

### 15.1 动机

第 13、14 章的 Feature Store 擅长"统计型"分析（每个 session 的 acceptRate、retryBurstScore 等），但不擅长"关系型"分析：

- "找出所有最终成功但经历三次以上 Retry 的 Session"——需要追踪 session→completion→outcome 的链路。
- "分析某类 Workspace 是否更容易触发 Context Explosion"——需要聚合 workspace→session→failure 的多跳关系。
- "统计某个 Tool 对 Accept Rate 的长期影响"——需要 tool→session→feature 的跨域关联。
- "发现某类失败是否集中发生在特定语言、依赖版本或工作流阶段"——需要 failure→session→workspace→language 的多维聚类。

这些问题用 SQL JOIN 写出来又长又难维护，用图遍历表达则一目了然。

### 15.2 数据模型

#### 15.2.1 节点类型

| 类型 | entityId | 关键属性 | 来源 |
|------|----------|---------|------|
| `session` | sessionId | startTime / endTime / acceptRate / retryRate | EventStore + FeatureStore |
| `prompt` | promptId | tokenCount / retrievedFiles / contextToken / historyToken | `chat` 事件 |
| `workspace` | workspaceId | （属性从 FeatureStore 补充） | EventStore |
| `commit` | `commit:${sessionId}:${eventId}` | branch / author | `commit` 事件 |
| `completion` | `completion:${sessionId}:${eventId}` | tokenCount | `completion` 事件 |
| `accept` / `reject` / `retry` | `${type}:${sessionId}:${eventId}` | — | 对应事件 |
| `file` | path | path | `read_file` 事件 |
| `language` | language name | name | `session_start` metadata.languages |
| `dependency` | dependency name | name | `session_start` metadata.dependencies |
| `tool` | `${toolName}@${sessionId}` | name / sessionId | `run_test` / `terminal` / `tool_call` 事件 |

节点 id 为 `${type}:${entityId}`，upsert 语义保证同一实体只存一份。

#### 15.2.2 边类型

| 边类型 | 方向 | 语义 |
|--------|------|------|
| `session_workspace` | session → workspace | 该 session 运行在此 workspace |
| `session_prompt` | session → prompt | 该 session 发出此 prompt |
| `session_completion` | session → completion | 该 session 产生此 completion |
| `session_commit` | session → commit | 该 session 产生此 commit |
| `session_file` | session → file | 该 session 读取过此文件 |
| `session_tool` | session → tool | 该 session 使用过此工具（按 session 去重） |
| `completion_outcome` | completion → accept\|reject\|retry | 该 completion 的最终结果 |
| `prompt_file` | prompt → file | 该 prompt 之前读取的文件作为上下文 |
| `workspace_language` | workspace → language | workspace 包含此语言（去重，非每 session 重复） |
| `workspace_dependency` | workspace → dependency | workspace 依赖此包（去重） |

边带 `timestamp` 与 `properties` JSON，支持时序查询。

#### 15.2.3 Schema

`schema.ts` 在 `SCHEMA_VERSION < 3` 时建图表：

```sql
CREATE TABLE graph_nodes (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  properties  TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_graph_nodes_type   ON graph_nodes(type);
CREATE INDEX idx_graph_nodes_entity ON graph_nodes(entity_id);

CREATE TABLE graph_edges (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id   TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  type        TEXT NOT NULL,
  properties  TEXT NOT NULL DEFAULT '{}',
  timestamp   INTEGER NOT NULL,
  FOREIGN KEY (source_id) REFERENCES graph_nodes(id),
  FOREIGN KEY (target_id) REFERENCES graph_nodes(id)
);
CREATE INDEX idx_graph_edges_source ON graph_edges(source_id);
CREATE INDEX idx_graph_edges_target ON graph_edges(target_id);
CREATE INDEX idx_graph_edges_type   ON graph_edges(type);
```

图与 Event / Feature / Embedding 共享同一个 SQLite 文件，事务一致性好，备份与迁移成本为零。

### 15.3 GraphStore

`src/graph/GraphStore.ts` 提供节点/边 CRUD 与邻居遍历：

| 方法 | 作用 |
|------|------|
| `clear()` | 清空图（重建前调用） |
| `upsertNode(node)` / `upsertNodeBatch(nodes)` | 节点 upsert（按 id） |
| `insertEdge(edge)` / `insertEdgeBatch(edges)` | 边 append |
| `getNode(id)` / `getNodesByType(type)` | 节点查询 |
| `getEdgesByType(type)` / `getEdgesFrom(sid)` / `getEdgesTo(tid)` | 边查询 |
| `getNeighbors(sourceId, edgeType?)` | 一跳正向邻居（节点） |
| `getReverseNeighbors(targetId, edgeType?)` | 一跳反向邻居（节点） |
| `count()` / `stats()` | 计数与按类型分组统计 |

邻居遍历通过 `graph_nodes ⋈ graph_edges` 的 JOIN 实现，索引覆盖 source / target / type 三列，单跳查询在千节点规模下亚毫秒。

### 15.4 GraphBuilder

`src/graph/GraphBuilder.ts` 从 EventStore + FeatureStore 重建图。流程：

1. `clear()` + 清空内部 `edgesAdded` 去重集合。
2. 对每个 sessionId：
   - 建 session 节点（携带 acceptRate / retryRate 快照）
   - 建 workspace 节点 + `session_workspace` 边
   - 从 `session_start` metadata 提取 `languages` / `dependencies`，建 language / dependency 节点 + `workspace_language` / `workspace_dependency` 边（**去重**：同一 workspace 的语言/依赖只建一次边）
   - 遍历事件，按 eventType 建 prompt / completion / accept / reject / retry / file / commit / tool 节点及对应边
   - `read_file` 事件中读的文件缓冲到 `filesBufferedForPrompt`，下一个 `chat` 事件到达时一次性建 `prompt_file` 边（捕获"该 prompt 的上下文文件"语义）
   - `run_test` / `terminal` / `tool_call` 按 `${toolName}@${sessionId}` 去重，避免同一 session 内多次调用同一工具产生重复边

**关键去重**：`addEdge` 用 `Set<string>` 跟踪 `${source}|${target}|${type}`，防止 `workspace_language` 这类固有关系被每个 session 重复插入。修复前 demo 中 `workspace_language` 边数 = sessions × languages（24），修复后 = unique workspaces × languages（3），查询计数才正确。

### 15.5 GraphQueries — v6.md 第 12 节的四个典型问题

`src/graph/GraphQueries.ts` 把第 12 节列出的四个分析问题实现为图遍历 + FeatureStore 查找的混合查询。

#### 15.5.1 Query 1：成功但经历多次 Retry 的 Session

```ts
findSessionsSucceededAfterRetries(minRetries = 3): SessionsWithRetriesResult[]
```

遍历所有 session 节点 → 取 `session_completion` 邻居 → 对每个 completion 取 `completion_outcome` 邻居 → 统计 retry / accept / reject 计数 → 过滤 `retryCount >= minRetries && acceptCount > 0`。

返回：sessionId / retryCount / acceptCount / rejectCount / succeeded。

#### 15.5.2 Query 2：Workspace 失败相关性

```ts
workspaceFailureAnalysis(failures: FailureClassification[]): WorkspaceFailureResult[]
```

对每个 workspace 节点 → 反向 `session_workspace` 邻居得到所有 session → 用传入的 `failures` 数组按 sessionId 查失败类型 → 聚合为 `{ workspaceId, totalSessions, failureBreakdown }`。

回答"大型 TS Monorepo 是否更易触发 Context Explosion"这类问题。

#### 15.5.3 Query 3：Tool 对 Accept Rate 的长期影响

```ts
toolAcceptRateImpact(): ToolImpactResult[]
```

对所有 tool 节点按 `properties.name` 分组 → 反向 `session_tool` 邻居得到 sessions → 查 FeatureStore 取每个 session 的 acceptRate / retryRate → 求均值。

返回：toolName / sessionCount / avgAcceptRate / avgRetryRate。

#### 15.5.4 Query 4：失败聚类分析

```ts
failureClusterAnalysis(failures: FailureClassification[]): FailureClusterResult[]
```

按 failureType 分组 sessions → 对每个 session：
- `session_workspace` → workspace → `workspace_language` → 收集语言
- `session_workspace` → 收集 workspace
- `session_file` → 收集文件

聚合并按频次排序，返回：failureType / sessionCount / commonLanguages / commonWorkspaces / commonFiles。

回答"某类失败是否集中在特定语言 / 文件 / workspace"。

### 15.6 端到端 Demo

`npm run demo:observatory` 在 Layer 6 输出：

```
─── Layer 6: Session Graph (Temporal Property Graph) ───
  Built 89 nodes / 115 edges from 11 sessions
  Nodes by type:  retry=22, completion=11, prompt=11, session=11, file=7,
                  accept=6, commit=6, reject=5, dependency=3, language=3, tool=3, workspace=1
  Edges by type:  completion_outcome=33, prompt_file=17, session_file=17,
                  session_completion=11, session_prompt=11, session_workspace=11,
                  session_commit=6, session_tool=3, workspace_dependency=3, workspace_language=3

  [Query 1] Sessions that succeeded after 3+ retries
    sess-recover             retries=3 accepts=1 rejects=0
    sess-recover-d1          retries=3 accepts=1 rejects=0
    sess-recover-d2          retries=3 accepts=1 rejects=0

  [Query 2] Workspace failure correlation
    ws-demo              sessions=11  failures: retry_loop=8

  [Query 3] Tool long-term impact on Accept Rate
    vitest           sessions=3  avgAcceptRate=1  avgRetryRate=0

  [Query 4] Failure cluster analysis
    [retry_loop] affects 8 sessions
      languages: TypeScript(8), JSON(8), Markdown(8)
      workspaces: ws-demo(8)
      files: src/graph/GraphBuilder.ts(3), README.md(2), package.json(2), ...
```

Query 1 找到 3 个 recover session（3 次重试后成功）；Query 3 显示用 vitest 的 session 全部成功（avgAcceptRate=1）；Query 4 揭示 retry_loop 在 ws-demo 集中，且 `src/graph/GraphBuilder.ts` 是最常关联的文件。

### 15.7 文件清单

| 路径 | 职责 |
|------|------|
| `src/store/schema.ts` | `SCHEMA_VERSION=3`，新增 `graph_nodes` / `graph_edges` 表与索引 |
| `src/graph/types.ts` | `GraphNodeType`（12 种）/ `GraphEdgeType`（10 种）/ `GraphNode` / `GraphEdge` / `GraphStats` |
| `src/graph/GraphStore.ts` | SQLite 节点/边存储 + `getNeighbors` / `getReverseNeighbors` 图遍历 |
| `src/graph/GraphBuilder.ts` | 从 EventStore + FeatureStore 重建图 + 边去重 |
| `src/graph/GraphQueries.ts` | 4 个典型查询：retry-recovery / workspace failure / tool impact / failure clusters |
| `src/graph/index.ts` | barrel export |
| `src/cli-observatory.ts` | `npm run demo:observatory` 新增 Layer 6 demo（含 recover session 类型用于 Query 1 验证） |

### 15.8 设计取舍

- **为何纯 SQLite 而不用 Neo4j / Apache AGE**：节点规模 < 10k、边规模 < 100k，单跳查询用 JOIN + 索引足够快。引入图数据库会显著增加部署复杂度，与 V6"轻量基础设施"理念相悖。后续若需要多跳路径查询（如 3 跳因果链），可考虑迁移或用递归 CTE。
- **为何图与 Event / Feature 共享同一 SQLite 文件**：事务一致性、备份简化、迁移零成本。图是 Event / Feature 的派生视图，可随时 `GraphBuilder.build()` 重建。
- **为何把 languages / dependencies 放在 session_start metadata 而非独立扫描**：避免引入 workspace 扫描器。session_start 事件天然携带 workspace 快照，足够支撑大多数分析。未来需要精确的 workspace 索引时，可加一个 `WorkspaceScanner` 异步填充。
- **为何失败分类作为 GraphQueries 的入参而非内部计算**：保持关注点分离。`AnalyticsEngine` 负责分类，`GraphQueries` 负责图遍历。这样失败分类算法升级（如换 CatBoost）不需要改 GraphQueries。

### 15.9 演进意义

Session Graph 补齐后，V6 真正成为 v6.md 第 12 节设想的"AI Development Observatory"：

```text
V1  Trace Collection
  → V2  Offline Evaluation
    → V2.5  Realtime Observability
      → V3  ML Model
        → V4  ML + Shadow + Feedback
          → V5  Runtime Intelligence
            → V5.2  Trustworthy Decision
              → V6  Event Store + Feature Store
                → V6 Full  Embedding + ML + LLM
                  → V6 Graph  Session Graph（时序属性图，关系型分析的统一入口）
```

- **统计型分析**走 Feature Store（acceptRate、retryBurstScore 等）。
- **语义型分析**走 Embedding Store（相似 session 召回）。
- **序列型分析**走 ML（Markov、WorkflowMiner、Trend）。
- **关系型分析**走 Session Graph（多跳关联、聚类、影响传播）。
- **解释型分析**走 LLM（pi-ai 把上述输出转自然语言）。

五种分析视角共享同一份 Event 真相源，互不重叠、互相补充。任何一层都可独立替换或升级。

---

## 16. V6Sink — Realtime → V6 桥接

### 16.1 问题

V6 六层基础设施（Event Store / Feature Store / Embedding / ML / LLM / Graph）完成后，仍缺一个关键环节：**实时事件流没有写入 V6 SQLite**。V2.5 的 `cli.ts` 用 `MockLogSource` 产生 `AgentLogEvent`，经 `SessionManager` 更新内存状态、触发 `RuleEngine`、渲染 Dashboard，但 session 结束后所有数据丢失。V6 的 EventStore 只能靠 `cli-observatory.ts` 的合成数据填充。

这是"在线采集 → 离线训练 → 在线预测"闭环断裂的第一环。

### 16.2 方案

新建 `src/realtime/V6Sink.ts`，在 V2.5 事件循环中同步把每个 `AgentLogEvent` 转为 `IDEEvent` 写入 V6 SQLite。session 结束时自动触发 `FeaturePipeline.computeSession()` 计算特征。

### 16.3 事件映射

| AgentLogEvent (V2.5) | IDEEvent (V6) | 说明 |
|----------------------|---------------|------|
| `session_start` | `session_start` | 携带 model / languages / dependencies |
| `session_end` | `session_end` | 触发特征计算 |
| `llm_request` | `chat` + `completion` | 拆分为用户 prompt 和 AI 响应两个事件 |
| `tool_call(read_file)` | `read_file` | 文件读取 |
| `tool_call(run_test)` | `run_test` | 测试运行 |
| `tool_call(terminal)` | `terminal` | 终端命令 |
| `tool_call(commit)` | `commit` | Git 提交 |
| `tool_call(other)` | `tool_call` | 通用工具调用 |
| `edit(success: true)` | `accept` | 编辑成功 → 接受变更 |
| `edit(success: false)` | `retry` | 编辑失败 → 将重试 |

`llm_request` 拆分为 `chat` + `completion` 是关键设计：V6 的 FeaturePipeline 需要分别统计 prompt 和 completion 的 token。每个 `llm_request` 自动生成唯一 `promptId`（`${sessionId}-prompt-${n}`）。

`edit` 映射到 `accept`/`retry` 是启发式推断：V2.5 的 MockLogSource 不显式跟踪 AI completion 的 accept/reject，但 edit 的 success 状态是合理的代理。

### 16.4 集成

`cli.ts` 在 V2.5 事件循环中加一行 `v6sink.ingest(event)`：

```ts
const db = openDatabase('./data/aea-realtime.db');
const v6sink = new V6Sink(eventStore, pipeline, { workspaceId: 'realtime-workspace' });

for await (const event of source.watch()) {
  const state = sessions.apply(event);      // V2.5: 内存状态
  const alerts = engine.evaluate(state, event);
  v6sink.ingest(event);                     // V6: 写 SQLite + session_end 时算特征
  // ... dashboard rendering
}
```

Session 结束后，cli.ts 打印 V6 分析摘要：事件数、事件类型分布、session features、behavior features。

### 16.5 效果

`npm run demo` 现在同时产出：
- V2.5 实时 Dashboard（health score / alerts / advisor）
- V6 SQLite 数据库（`./data/aea-realtime.db`），含 18 个 IDEEvent + 完整 session/behavior features

这标志着 **AEA 首次实现实时采集闭环**：V2.5 的实时观测能力与 V6 的存储/分析能力不再割裂。

---

## 17. 回归测试

### 17.1 框架

使用 `vitest`（Vite 原生测试框架），零配置支持 TypeScript + ESM。`npm run test` 运行全部测试，`npm run test:watch` 进入 watch 模式。

### 17.2 测试覆盖

| 文件 | 测试数 | 覆盖内容 |
|------|--------|---------|
| `tests/V6Sink.test.ts` | 6 | 事件转换：session_start / llm_request 拆分 / read_file / edit→accept|retry / session_end 触发特征计算 |
| `tests/FeaturePipeline.test.ts` | 9 | session features（acceptRate / retryRate / retryCount）+ behavior features（workflowEntropy / retryBurstScore / avgReadBeforeAsk / workflowLength / contextExpansionSpeed）+ computeAllSessions |
| `tests/EmbeddingPipeline.test.ts` | 9 | normalize 单位范数 / cosine 相似度（相同=1 / 正交=0 / 相反=-1）/ 10 维 session 向量 / 相似 session 检索 |
| `tests/GraphBuilder.test.ts` | 8 | 节点创建 / 边创建 / workspace_language 去重 / file 去重 / prompt_file 边 / session_tool 边 / GraphQueries（retry-recovery 查询 / tool 影响查询） |
| `tests/WorkflowMiner.test.ts` | 5 | directly-follows 频率 / dependency metric（单向=2/3 / 双向≈0）/ 失败模式识别 / 节点度数 |
| `tests/AnalyticsEngine.test.ts` | 5 | 失败分类（retry_loop / context_explosion / none）/ llmPayload 字段完整性 / healthDirection / contextROI |
| **合计** | **45** | 覆盖 V6 全六层关键纯函数 |

### 17.3 测试策略

- **内存 SQLite**：每个测试用 `openDatabase(':memory:')` 创建独立数据库，无文件 I/O，测试间无状态泄漏。
- **Seed helpers**：`tests/helpers.ts` 提供 `seedGoodSession` / `seedRetrySession` / `seedExplodeSession` 三种典型 session 模式，复用率高。
- **纯函数优先**：优先测试无副作用的纯函数（cosineSimilarity / normalize / WorkflowMiner.mine），再测试有状态的 Store/Pipeline。
- **不测试 LLM 调用**：LLM 层依赖外部 API，测试中不触发真实调用，仅验证 fallback 逻辑。

### 17.4 文件清单

| 路径 | 职责 |
|------|------|
| `tests/helpers.ts` | createTestContext / dispose / seedGoodSession / seedRetrySession / seedExplodeSession |
| `tests/V6Sink.test.ts` | V6Sink 事件转换测试 |
| `tests/FeaturePipeline.test.ts` | Feature 计算（session + behavior）测试 |
| `tests/EmbeddingPipeline.test.ts` | Embedding 生成 + cosine 相似度测试 |
| `tests/GraphBuilder.test.ts` | Graph 构建 + 去重 + GraphQueries 测试 |
| `tests/WorkflowMiner.test.ts` | Heuristic Miner 算法测试 |
| `tests/AnalyticsEngine.test.ts` | 失败分类 + summary (AnalyticsSummary) 测试 |

---

# Chapter 18 — V7 Architecture Refactoring

V7 不是新增分析能力，而是对 V6 架构边界进行系统性梳理，目标：让系统具备长期演进级的可插件化、可查询、可解释能力。核心变更来自 `v7.md`。

## 18.1 核心架构演进

```
V6: Event → Feature → Embedding → ML → LLM + Graph
V7: Event → Entity → Feature → Embedding → ML → Graph → LLM
```

新增 **Canonical Entity Layer** 作为事件与特征/嵌入/图/LLM 之间的统一领域模型，让整个系统真正变成 DDD。

## 18.2 十大架构变更

### 1. Feature Pipeline 拆成三层 (`src/store/aggregators/` + `src/store/calculators/`)

- **Aggregator** (`WorkspaceAggregator` / `SessionAggregator` / `PromptAggregator`): 只做 `Event → Intermediate Aggregate`，输出原始事实集合。
- **FeatureCalculator** (`WorkspaceFeatureCalculator` / `ContextFeatureCalculator` / `BehaviorFeatureCalculator`): 只做 `Aggregate → Feature`，计算派生指标。
- **FeatureStore**: 只做 Persistence + Materialized View。
- `FeaturePipeline` 变为薄编排器，未来增加 Feature 无需修改 Aggregator。

### 2. Event 与 Session Graph 解耦

`GraphBuilder` 不再直接解析 Event 语义，而是通过 `EntityBuilder` 生成 `EntityBundle`，从 Entity 构建图。Graph 只知道 Session/Prompt/Workspace/Completion/Tool/Failure 这些 Entity。

### 3. Graph 不存 Feature，只存 Reference

Session Node 的 properties 中只保存 `featureVersion`（Reference），真正的 Feature 仍然存储在 `FeatureStore`。Feature 更新时无需重建 Graph。

### 4. Embedding Provider 插件化 (`src/embedding/EmbeddingProvider.ts`)

```typescript
interface EmbeddingProvider {
  id: string;
  supportedEntities: ReadonlyArray<'session' | 'prompt' | 'workspace'>;
  generateSession(features: Record<string, number>): Float32Array;
  generatePrompt(features: Record<string, number>): Float32Array;
}
```

默认实现 `FeatureEmbeddingProvider` (`feature-v1`)，未来可接入 `text-embedding-3-small` / `nomic` / `bge-m3` 而无需修改 `EmbeddingPipeline`。

### 5. Feature Materialized View (`session_feature_view`)

保留 JSON Blob 的同时，将 `acceptRate` / `retryRate` / `workflowEntropy` / `retryBurstScore` 等 14 个高频分析字段物化为真实列，可直接用 SQL/DuckDB/CatBoost 查询，无需 `JSON_EXTRACT`。

### 6. LabelStore 独立 (`src/store/LabelStore.ts`)

Label 的生命周期与 Feature 完全不同，独立存储、独立查询。`FeatureStore` 不再负责 `writeLabel` 和 `getTrainingMatrix`，Training Matrix 由 `LabelStore.getTrainingMatrix()` 组装。

### 7. Workflow Mining 直接读 Event

`WorkflowAnalyzer` 直接从 `AnalyzerContext.sessions`（事件序列）挖掘工作流，不走 Feature。因为工作流本质是 Sequence，Feature 已经损失信息。

### 8. AnalyticsEngine 拆分为 5 个 Analyzer + 薄编排器 (`src/ml/analyzers/`)

| Analyzer | 职责 |
|----------|------|
| `BehaviorAnalyzer` | 一阶 Markov 链 + 行为模式 |
| `WorkflowAnalyzer` | Heuristic Miner 工作流挖掘 |
| `TrendAnalyzer` | 线性回归 + 7 日滚动平均 |
| `FailureAnalyzer` | 规则驱动的失败分类 |
| `ROIAnalyzer` | Context ROI 特征贡献度 |

`AnalyticsEngine` 只负责调用各 Analyzer 并 Merge 结果。

### 9. LLM Payload Schema 化 (`src/ml/AnalyticsSummary.ts`)

```typescript
interface AnalyticsSummary {
  sessions: number;
  events: number;
  avgAcceptRate: number;
  avgRetryRate: number;
  healthDirection: 'improving' | 'declining' | 'stable';
  trendAcceptRate: 'up' | 'down' | 'stable';
  trendRetryRate: 'up' | 'down' | 'stable';
  topWorkflow: string;
  anomalyScore: number;
  topFailure: string;
  topFailurePattern: string;
  contextROI: { feature: string; contribution: number }[];
}
```

`AnalyticsReport.llmPayload: Record<string, unknown>` 被替换为 `summary: AnalyticsSummary`。`InsightsEngine` 使用强类型 `summary` 生成模板解释。

### 10. 三个 Registry

| Registry | 文件 | 作用 |
|----------|------|------|
| Feature Registry | `src/store/FeatureRegistry.ts` | Feature 定义 |
| Event Registry | `src/store/EventRegistry.ts` | Event Schema、Provider Mapping、版本管理 |
| Analyzer Registry | `src/ml/AnalyzerRegistry.ts` | 注册 Behavior/Trend/Workflow/Failure/ROI Analyzer |

## 18.3 文件清单

| 新增/修改 | 路径 | 职责 |
|-----------|------|------|
| 新增 | `src/entity/types.ts` | 7 个 Entity 接口 + EntityBundle + EntityType |
| 新增 | `src/entity/EntityBuilder.ts` | Event → EntityBundle |
| 新增 | `src/store/aggregators/types.ts` | Aggregate 类型定义 |
| 新增 | `src/store/aggregators/WorkspaceAggregator.ts` | Event → WorkspaceAggregate |
| 新增 | `src/store/aggregators/SessionAggregator.ts` | Event → SessionAggregate |
| 新增 | `src/store/aggregators/PromptAggregator.ts` | Event → PromptAggregate[] |
| 新增 | `src/store/calculators/WorkspaceFeatureCalculator.ts` | WorkspaceAggregate → features |
| 新增 | `src/store/calculators/ContextFeatureCalculator.ts` | PromptAggregate → features |
| 新增 | `src/store/calculators/BehaviorFeatureCalculator.ts` | SessionAggregate → session/tool/behavior features |
| 新增 | `src/store/LabelStore.ts` | Label 独立存储 + Training Matrix |
| 新增 | `src/store/EventRegistry.ts` | Event Schema + Provider Mapping |
| 新增 | `src/embedding/EmbeddingProvider.ts` | Embedding Provider 接口 |
| 新增 | `src/embedding/FeatureEmbeddingProvider.ts` | feature-v1 provider |
| 新增 | `src/ml/AnalyticsSummary.ts` | 强类型 LLM payload |
| 新增 | `src/ml/AnalyzerRegistry.ts` | Analyzer 注册表 |
| 新增 | `src/ml/analyzers/types.ts` | Analyzer 接口 |
| 新增 | `src/ml/analyzers/BehaviorAnalyzer.ts` | 行为分析插件 |
| 新增 | `src/ml/analyzers/WorkflowAnalyzer.ts` | 工作流分析插件 |
| 新增 | `src/ml/analyzers/TrendAnalyzer.ts` | 趋势分析插件 |
| 新增 | `src/ml/analyzers/FailureAnalyzer.ts` | 失败分类插件 |
| 新增 | `src/ml/analyzers/ROIAnalyzer.ts` | ROI 分析插件 |
| 修改 | `src/store/FeaturePipeline.ts` | 薄编排器 |
| 修改 | `src/store/FeatureStore.ts` | 新增 `session_feature_view` 物化视图 |
| 修改 | `src/store/schema.ts` | SCHEMA_VERSION = 4，新增 `session_feature_view` 表 |
| 修改 | `src/store/index.ts` | 导出 LabelStore / EventRegistry |
| 修改 | `src/embedding/EmbeddingPipeline.ts` | Provider 注册表编排器 |
| 修改 | `src/embedding/index.ts` | 导出 EmbeddingProvider / FeatureEmbeddingProvider |
| 修改 | `src/ml/AnalyticsEngine.ts` | 薄编排器，输出 `summary: AnalyticsSummary` |
| 修改 | `src/ml/index.ts` | 导出 AnalyticsEngine / AnalyticsSummary / AnalyzerRegistry / analyzers |
| 修改 | `src/graph/GraphBuilder.ts` | 从 Entity 构建，Node 存 featureVersion Reference |
| 修改 | `src/llm/InsightsEngine.ts` | 使用 `report.summary` 替代 `report.llmPayload` |
| 修改 | `src/cli-store.ts` | 使用 LabelStore 写入 Label 和 Training Matrix |
| 修改 | `src/cli-observatory.ts` | 传入 EntityBuilder 到 GraphBuilder，使用 `report.summary` |
| 修改 | `src/cli.ts` | 适配新的 FeaturePipeline 构造函数 |
| 修改 | `tests/helpers.ts` | 增加 `entityBuilder` 到 TestContext |
| 修改 | `tests/GraphBuilder.test.ts` | 传入 `entityBuilder` |
| 修改 | `tests/AnalyticsEngine.test.ts` | 测试 `summary` 替代 `llmPayload` |

## 18.4 验证结果

```bash
npm run typecheck  # 通过
npm test           # 6 files, 45 tests 全部通过
npm run demo:store      # SQLite + Feature + LabelStore demo 通过
npm run demo:observatory         # 6-layer demo 通过：95 nodes / 121 edges / 11 sessions
npm run demo       # Realtime V2.5 + V6Sink bridge 通过
```

---

# Chapter 19 — V6 ML Pipeline Deepening

V7 完成架构边界梳理后,本章聚焦把 V6/V7 留下的"ML 管线骨架"打磨为可生产化的完整闭环。核心问题来自 `ML_ALGORITHMS.md` 的旧画像:**6 真实样本、单 CatBoost、无 CV、启发式造标签**——这不足以支撑可信的模型选型决策。本章不新增架构层,而是横向加深 V6 Layer 4(ML / Analytics)的 ML 训练管线与评估体系。

## 19.1 动机

V7 结束时 ML 管线存在四类问题:

1. **数据规模不足**:仅 6 真实 session + 单一 DB 源,不足以训练任何严肃模型
2. **标签来源单一**:仅启发式 `heuristicLabel()` 自造标签,模型在"学自己"
3. **无泛化评估**:CatBoost 单次 holdout,NB/LR/KNN 报告训练集准确率("97.4%+" 是拟合度不是泛化)
4. **算法覆盖窄**:仅有 CatBoost + 4 个 TS 模型,无元学习器仲裁,无不确定性量化

V6 ML Pipeline Deepening 的目标是把以上四点全部补齐,使 ML 管线从"演示原型"升级为"可被审计的训练系统"。

## 19.2 数据层加深:多 DB 源 + 行为标签

### 19.2.1 多 DB 源扫描

`src/cli/train.ts` 把训练数据源从单一 DB 扩展为 4 个 DB:

```typescript
const REAL_DB_SOURCES = [
  './data/aea-transcripts.db',    // 6 sessions, 行为数据最丰富
  './data/aea-real.db',            // 25 sessions
  './data/aea-v6.db',              // 11 sessions (V6Sink)
  './data/aea-workspace-scan.db',  // 25 sessions (含 autoMode 信号)
];
```

`loadAutoModeSignals(REAL_DB_SOURCES)` 跨所有 DB 扫描 `autoModeResolution` 信号,合并为统一的弱标签 Map,从原来 0 个提升到 5 个。

### 19.2.2 行为标签(BehaviorLabelExtractor)

`src/ml/BehaviorLabelExtractor.ts` 引入 reward-based 标签:

| 信号 | reward | 含义 |
|---|---|---|
| accept | +1.0 | 用户接受了工具调用/编辑/响应 |
| retry | -0.3 | 用户重试,模型不够好 |
| reject | -0.5 | 用户显式拒绝 |
| abandon | -0.8 | session 早退(<3 事件, <30s) |
| cancel | -1.0 | session 被取消 |

`rewardNormalized < 0` → `large`(模型不够,需更大);否则用复杂度公式决定 mini/medium/large。当无行为信号时退化为 `heuristicLabel`,标记 `labelSource='heuristic'` 供 `PseudoLabeler` 后续纠正。

### 19.2.3 复杂度公式调优

`toolCalls` 权重从 5 降为 2,避免只读 session(14 个 toolCalls 全是 read)被误标 large。统一 mini 阈值为 `complexity <= 20`。

```
complexity = promptTokens/1000 + toolCalls*2 + edits*15 + retries*50
           + hasLoop*100 + subAgents*30
```

修复后标签分布从 mini=5,medium=2,large=14 改善为 mini=5,medium=4,large=12。

### 19.2.4 log-normal 合成数据

`src/ml/dataset.ts` 用 Box-Muller 变换生成 log-normal 分布的合成数据,替换原本固定值×jitter 的不真实分布:

```typescript
function randn(): number {
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function logNormal(median: number, sigma: number): number {
  return Math.exp(Math.log(median) + sigma * randn());
}
```

填充所有 rolling/EMA 特征为合理非零值(原本全 0,导致 Drift Detector 误报)。156 合成样本补足 21 真实样本。

## 19.3 模型层加深:6 模型 + Stacking 仲裁

### 19.3.1 sklearn 训练管线

NB / LR 训练从纯 TS 迁移到 `scripts/train_sklearn_models.py`,通过 sklearn `Pipeline` 保证标准化与 log-transform 不泄露到 CV 验证集。推理仍保留纯 TS,无跨进程开销。

### 19.3.2 Torch MLP(新增第 5 个基础模型)

`scripts/train_torch_model.py` 训练 3 层 MLP(34→64→3),导出 W1.T/b1/W2.T/b2/scaler 为 JSON,`src/ml/TorchModel.ts` 用纯 TS 矩阵乘法 + ReLU + softmax 推理,**运行时无 torch 依赖**。

### 19.3.3 Stacking Meta Learner(新增元学习器)

`src/ml/StackingMetaLearner.ts` 实现 K-fold OOF + 元学习器:

1. 把训练数据分 K 折,每折用其他折训练 5 个基础模型,在本折上预测 → OOF 预测
2. 5 个基础模型的 OOF 概率拼接为 15 维 meta features
3. 训练 softmax 元学习器学习最优组合权重

Sample 2 中 KNN 误判 large(51% vs medium 48%),Stacking 正确仲裁为 medium(94.3%)——这正是 stacking 的核心价值。

## 19.4 评估层加深:K-fold CV + Overfitting Gap

### 19.4.1 TrainedModelInfo 扩展

`src/ml/ModelInterface.ts` 增加两个字段:

```typescript
export interface TrainedModelInfo {
  // ... 原有字段
  accuracy?: number;        // 训练集准确率(拟合程度)
  cvAccuracy?: number | null;  // 交叉验证/holdout 准确率(泛化能力)
  cvFolds?: number;          // CV 折数(0=未做, 1=单次holdout, K=K-fold)
}
```

### 19.4.2 各模型 CV 策略

| 模型 | CV 策略 | 防泄露措施 |
|---|---|---|
| CatBoost | 5 折 StratifiedKFold,每折独立训练 | 每折内部 20% 做 early stopping |
| LR | 5 折 StratifiedKFold | sklearn `Pipeline(StandardScaler + LR)` |
| NB | 5 折 StratifiedKFold | sklearn `Pipeline(log1p + NB)`,log 列与 TS 推理对齐 |
| KNN | Leave-One-Out(N 折) | 天然诚实,无需额外处理 |
| Torch MLP | 5 折 StratifiedKFold | 每折独立训练,StandardScaler 严格只在折内 fit |
| Stacking Meta | 5 折在 OOF meta features 上 | 重构 `trainMetaModelPure`/`metaForwardPure` 纯函数 |

### 19.4.3 Overfitting Gap 报告

`src/cli/train.ts` 模型对比表新增 CV/Folds 列,自动检测 `train - CV > 0.10` 并报警:

```
Model comparison:
  ┌────────────────────────────┬──────────┬──────────┬─────────┬───────────┐
  │ Model                      │ Train    │ CV       │ Folds   │ Samples   │
  ├────────────────────────────┼──────────┼──────────┼─────────┼───────────┤
  │ Logistic Regression        │ 1.000    │ 0.936    │ 5       │ 177       │
  │ Naive Bayes                │ 0.965    │ 0.947    │ 5       │ 177       │
  │ KNN Distance Weighted      │ 0.942    │ 0.936    │ 171     │ 177       │
  │ Torch MLP                  │ 1.000    │ 0.942    │ 5       │ 177       │
  │ CatBoost                   │ 1.000    │ 0.965    │ 5       │ 177       │
  │ Stacking Meta Learner      │ 0.960    │ 0.944    │ 5       │ 177       │
  └────────────────────────────┴──────────┴──────────┴─────────┴───────────┘
```

之前的 "97.4%+" 是训练集拟合度;真实 CV 在 0.936-0.965 之间,overfitting gap 0.02-0.06 健康。

## 19.5 监控层加深:PSI Drift Detection

`src/ml/DriftDetector.ts` 实现 Population Stability Index,对比当前训练数据与 baseline 的特征分布:

- **PSI < 0.1**:无显著漂移
- **0.1 ≤ PSI < 0.25**:轻微漂移,持续观察
- **PSI ≥ 0.25**:显著漂移,触发重训练

baseline 自动保存到 `./data/ml/drift-baseline.json`,每次 train 后更新。

**实际验证**:第一次修复合成数据后 train,Max PSI=4.85(24 特征漂移)— 因为旧 baseline 还在用 rolling features=0 的合成数据。第二次 train 后 Max PSI=0.25(3 特征漂移),Avg PSI=0.05,基本收敛。剩余漂移来自合成数据随机性。

## 19.6 共享基础设施:pythonExec.ts

`src/ml/pythonExec.ts` 提供共享的 Python 子进程执行:

```typescript
execPython(scriptPath: string, args: string[]): Promise<string>
execPythonCommand(command: string): Promise<string>
```

`CatBoostTrainer` / `NaiveBayesModel` / `LogisticRegressionModel` / `TorchModel` 全部复用,消除原本各自重复的 spawn 逻辑。Python 可执行文件解析由 `pythonResolver.ts` 统一处理(优先 `.venv/bin/python`,支持 `AEA_PYTHON` 环境变量覆盖)。

## 19.7 完整训练管线

```text
4 个 SQLite DB ─┐
                │
   ┌────────────┴───────────┐
   │                        │
   ▼                        ▼
autoModeSignals       RealSamples +
(5 个弱标签)          BehaviorLabels
   │                        │
   └───────────┬────────────┘
               ▼
   LabelPropagation + WeakLabelFusion + PseudoLabeling
               │
               ▼
   + SyntheticSamples (log-normal, 156 个)
               │
   ┌───────────┼───────────┐
   ▼           ▼           ▼
 sklearn    torch      CatBoost
 NB + LR    MLP        (Python)
 5-fold CV  5-fold CV  5-fold CV
   │           │           │
   │  ┌────────┼────────┐  │
   │  ▼        ▼        ▼  │
   │ KNN    (5 个基础模型 OOF 预测)
   │ LOO         │
   └─────────────┼─────────┘
                 ▼
       StackingMetaLearner
       (5 折 CV on meta features)
                 │
                 ▼
       6 模型 + Stacking 全部带
       cvAccuracy + Overfitting Gap
                 │
                 ▼
       DriftDetector (PSI) → baseline
```

## 19.8 验证结果

```bash
npm run typecheck  # 通过
npm test           # 141 tests 全部通过
npm run train      # 6 模型 + Stacking 全部带 CV,无 overfitting 警告
npm run predict    # 3 样本(mini/medium/large)6 模型 + Conformal 全部正确
```

## 19.9 文件清单

| 路径 | 职责 |
|---|---|
| `src/ml/features.ts` | 34 维特征(17 基础 + 17 时序)+ `extractModelSizeFeaturesFromEvents` |
| `src/ml/TemporalFeatures.ts` | 17 维时序行为特征(新增) |
| `src/ml/dataset.ts` | log-normal 合成数据生成 + CSV 导出 |
| `src/ml/realDataset.ts` | 真实 session 加载 + 行为/启发式标签 |
| `src/ml/BehaviorLabelExtractor.ts` | reward-based 行为标签(新增) |
| `src/ml/LabelPropagation.ts` | 半监督标签传播 |
| `src/ml/WeakLabelFusion.ts` | 弱标签融合 |
| `src/ml/pythonExec.ts` | 共享 Python 子进程执行(新增) |
| `src/ml/NaiveBayesModel.ts` | sklearn 训练 + 纯 TS 推理(重写) |
| `src/ml/LogisticRegressionModel.ts` | sklearn 训练 + 纯 TS 推理(重写) |
| `src/ml/KnnModel.ts` | 纯 TS KNN + LOO CV(加 cvAccuracy) |
| `src/ml/TorchModel.ts` | torch 训练 + 纯 TS MLP 推理(新增) |
| `src/ml/CatBoostTrainer.ts` | CatBoost Python 桥接 + 5 折 CV(加 cvAccuracy) |
| `src/ml/StackingMetaLearner.ts` | Stacking 元学习器 + meta CV(重构 pure 函数) |
| `src/ml/ConformalPredictor.ts` | 不确定性包裹器 |
| `src/ml/DriftDetector.ts` | PSI 漂移检测 |
| `src/ml/ModelInterface.ts` | `TrainedModelInfo` 加 `cvAccuracy` / `cvFolds` |
| `src/ml/ModelTrainer.ts` | 编排器,显示 train + cv + overfitting gap |
| `scripts/train_sklearn_models.py` | sklearn NB + LR 训练(含 Pipeline CV,新增) |
| `scripts/train_torch_model.py` | torch MLP 训练(含 K-fold CV,新增) |
| `scripts/train_catboost.py` | CatBoost 训练(加 K-fold CV) |
| `src/cli/train.ts` | 训练入口,展示对比表 + overfitting 警告 |
| `src/cli/predict.ts` | 预测入口,3 样本端到端验证 |

## 19.10 演进意义

V6 ML Pipeline Deepening 不是新增架构层,而是横向加深 V6 Layer 4(ML / Analytics)的 ML 训练管线。其本质变化:

```text
V6 / V7: 1 CatBoost + 4 TS 模型 + 启发式标签 + 单次 holdout
   → V6 Deepening: 6 模型 + Stacking 仲裁 + 行为标签 + 半监督传播
                  + 5 折 K-fold CV + PSI 漂移检测 + log-normal 合成数据
```

- **从单模型到元学习器**:Stacking 学到 5 个基础模型的最优组合权重,在 KNN 误判时正确仲裁
- **从启发式到行为标签**:用真实用户 accept/retry/reject 信号生成标签,模型不再"学自己"
- **从训练准确率到 K-fold CV**:所有模型都报告真实泛化能力,overfitting gap 可视化
- **从无监控到 PSI 漂移检测**:特征分布偏移自动报警,触发重训练

```text
V1  Trace Collection
  → V2  Offline Evaluation
    → V2.5  Realtime Observability
      → V3  ML Model
        → V4  ML + Shadow + Feedback
          → V5  Runtime Intelligence
            → V5.2  Trustworthy Decision
              → V6  Event Store + Feature Store
                → V6 Full  Embedding + ML + LLM
                  → V6 Graph  Session Graph
                    → V7  Architecture Refactoring
                      → V6 Deepening  ML Pipeline Deepening(多源数据 + 6模型 + Stacking + K-fold CV + 行为标签 + 漂移检测)
```

下一阶段的改进方向是**数据规模**(继续收集真实 session 到 50+)与**真实 holdout 集**(预留若干真实 session 完全不参与训练,作为最终 sanity check)。

