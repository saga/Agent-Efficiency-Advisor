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
│   ├── cli-v4.ts              # V4 实时推荐 + Shadow + Feedback Demo
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
| **V4** | `src/ml/shadow/` `src/ml/feedback/` `src/cli-v4.ts` | 实时推荐 + Shadow Evaluation + Feedback 闭环：在线推荐、反事实验证、样本回流 | Done |

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

npm run demo      # 实时规则观测 Demo
npm run v4        # V4 实时推荐 + Shadow + Feedback
npm run train     # CatBoost 训练
npm run predict   # CatBoost 预测
npm run typecheck # TypeScript 类型检查
npm run build     # 编译到 dist/
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
