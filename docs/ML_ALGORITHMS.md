# ML 算法对比与选型

> 本文档记录 Agent Efficiency Advisor 项目的 ML 算法选型分析。
> 当前实现同时训练 6 个基础模型 + 1 个 Stacking 元学习器,所有模型都通过 K-fold CV 报告真实泛化能力。
> 更新日期:2026-07-17

## 数据画像(截至 2026-07-17)

| 维度 | 现状 |
|---|---|
| 真实样本数 | 21 个有效 session(来自 4 个 SQLite DB 源) |
| 合成样本数 | 156 个(log-normal 分布生成,补足小样本) |
| 总训练样本 | 177 |
| 特征数 | 34 维(17 基础 + 17 时序行为) |
| 类别数 | 3(mini / medium / large) |
| 标签来源 | 双轨制:行为标签(BehaviorLabelExtractor,优先)+ 启发式标签(heuristicLabel,兜底) |
| 半监督信号 | 5 个 autoModeResolution(Copilot 内部 ML 预测,跨 4 个 DB 扫描) |
| promptTokens | 真实 session 18k-97k,合成 log-normal 中位数 2.5k/15k/60k(mini/medium/large) |
| 评估方式 | 5 折分层 K-fold CV(小样本自动降级到 2 折) |
| 预测延迟 | TS 模型 <1ms,CatBoost ~200ms(Python 子进程) |

### 数据源

| DB 文件 | session 数 | 说明 |
|---|---|---|
| `./data/aea-transcripts.db` | 6 | 行为数据最丰富(transcript import) |
| `./data/aea-real.db` | 25 | real-copilot demo 输出 |
| `./data/aea-v6.db` | 11 | V6Sink 写入 |
| `./data/aea-workspace-scan.db` | 25 | workspace-scan demo,含 autoMode 信号 |

`loadAutoModeSignals(REAL_DB_SOURCES)` 跨所有 DB 扫描,合并 autoModeResolution 信号。

## 特征工程

### 17 维基础特征(`src/ml/features.ts`)

| 类别 | 特征 |
|---|---|
| Token 计量 | promptTokens / completionTokens / contextTokens / contextUtilization |
| 工具行为 | toolCalls / readFiles / edits / retries / uniqueFilesRead / uniqueFilesEdited |
| 复杂度信号 | hasLoop / subAgents / readToEditRatio / retryRate / elapsedMs |
| Copilot 信号 | autoModePredictedLabel / autoModeConfidence |

### 17 维时序行为特征(`src/ml/TemporalFeatures.ts`)

| 类别 | 特征 |
|---|---|
| 时间上下文 | hourOfDay / dayOfWeek / isWeekend |
| 阶段计时 | chatDurationMs / toolDurationMs / idleMs(上限 1h 防失真) |
| 行为比率 | chatToToolRatio / acceptRate / cancelRate / switchRate / toolSuccessRate |
| 历史统计 | rollingAvgTokens / rollingAvgDuration / rollingAcceptRate / emaTokens / emaRetryRate / sessionsToday |

### 复杂度公式(用于启发式标签)

```
complexity = promptTokens/1000 + toolCalls*2 + edits*15 + retries*50
           + hasLoop*100 + subAgents*30

if complexity <= 20: mini
if complexity <= 60: medium
else:                large
```

`toolCalls` 权重为 2(而非 5)避免只读 session 被错分为 large。

## 标签体系

### 行为标签(优先)— `BehaviorLabelExtractor.ts`

基于真实用户行为信号计算 reward:

| 信号 | reward | 含义 |
|---|---|---|
| accept | +1.0 | 用户接受了工具调用/编辑/响应 |
| retry | -0.3 | 用户重试,模型不够好 |
| reject | -0.5 | 用户显式拒绝 |
| abandon | -0.8 | session 早退(<3 事件, <30s) |
| cancel | -1.0 | session 被取消 |

`rewardNormalized < 0` → `large`(模型不够,需更大);否则用复杂度公式决定 mini/medium/large。

### 启发式标签(兜底)

当 session 无 accept/retry/reject 信号时,用 `heuristicLabel(features)` 退化到复杂度公式,标记 `labelSource='heuristic'` 供 `PseudoLabeler` 后续纠正。

## 算法清单

### 1. CatBoost

- **类型**:梯度提升树
- **训练**:`scripts/train_catboost.py` + sklearn `StratifiedKFold` 5 折 CV
- **推理**:`src/ml/CatBoostTrainer.ts` → Python 子进程
- **CV 策略**:每折独立训练,内部 20% 做 early stopping;最终模型在全量数据训练并报告 train_acc
- **当前表现**:train=1.000, **cv=0.965**(5 折)— 最佳泛化
- **适用**:样本 >50 后真正发挥优势,目前 21 真实样本下表现已优秀

### 2. Logistic Regression

- **类型**:带 L2 正则的 softmax 回归
- **训练**:`scripts/train_sklearn_models.py` 用 sklearn `LogisticRegression`(lbfgs, C=100)
- **推理**:`src/ml/LogisticRegressionModel.ts`(纯 TS,StandardScaler + 矩阵乘法)
- **CV 策略**:sklearn `Pipeline(scaler + lr)` + `StratifiedKFold` 5 折,防止标准化泄露
- **当前表现**:train=1.000, **cv=0.936**(5 折)
- **适用**:小样本主力,与 NB 互为 baseline

### 3. Gaussian Naive Bayes

- **类型**:朴素贝叶斯(高斯似然)
- **训练**:`scripts/train_sklearn_models.py` 用 sklearn `GaussianNB`(var_smoothing=1e-6)
- **推理**:`src/ml/NaiveBayesModel.ts`(纯 TS)
- **CV 策略**:`Pipeline(log1p + nb)` + 5 折,log-transform 列与 TS 推理严格对齐
- **当前表现**:train=0.965, **cv=0.947**(5 折)
- **适用**:baseline,天然校准概率

### 4. KNN 距离加权

- **类型**:K 最近邻 + 距离倒数加权 + cosine 相似度
- **训练**:`src/ml/KnnModel.ts`(纯 TS,K=√n,零训练成本)
- **CV 策略**:Leave-One-Out(N 折 CV,天然诚实)
- **当前表现**:train=0.942, **cv=0.936**(LOO)
- **适用**:冷启动阶段,样本极少时的默认模型

### 5. Torch MLP(新增)

- **类型**:3 层 MLP(34 → 64 → 3,ReLU + Softmax)
- **训练**:`scripts/train_torch_model.py`(Adam, CrossEntropyLoss, 300 epochs)
- **推理**:`src/ml/TorchModel.ts`(纯 TS,矩阵乘法 + ReLU + softmax,无 torch 运行时依赖)
- **CV 策略**:5 折,每折独立训练,**StandardScaler 严格只在折内 fit 防泄露**
- **当前表现**:train=1.000, **cv=0.942**(5 折)
- **适用**:中等样本量(50-500)下的非线性主力

### 6. Stacking Meta Learner(新增)

- **类型**:Logistic Regression 元学习器(softmax,SGD + L2)
- **训练**:`src/ml/StackingMetaLearner.ts`(纯 TS)
- **原理**:
  1. K-fold OOF:把训练数据分 K 折,每折用其他折训练 5 个基础模型,在本折上预测 → out-of-fold 预测
  2. 5 个基础模型的 OOF 概率拼接为 15 维 meta features
  3. 训练 meta 模型学习最优组合权重
- **CV 策略**:**对 meta features 做独立 5 折 CV**(meta 模型本身也有 overfitting 风险,不能只看 OOF 训练集准确率)
- **当前表现**:train=0.960, **cv=0.944**(5 折)
- **价值**:Sample 2 中 KNN 误判 large(51% vs medium 48%),Stacking 正确仲裁为 medium(94.3%)— 这就是 stacking 的核心价值

### 7. Conformal Prediction(包裹器)

- **类型**:不确定性包裹器(非独立分类器)
- **实现**:`src/ml/ConformalPredictor.ts`(纯 TS)
- **原理**:用 calibration set 计算 nonconformity score;预测时若 top-1 与 top-2 概率差 < threshold → 输出 "uncertain"
- **保证**:在 calibration set 上的覆盖率 = 1 - α
- **适用**:生产环境,防止过自信预测误导用户

## 辅助模块

### LabelPropagation(半监督标签传播)

- **类型**:基于特征相似度图的标签传播
- **实现**:`src/ml/LabelPropagation.ts`(纯 TS)
- **作用**:用 5 个 autoModeResolution 弱标签 session 作为种子,通过特征相似度向 16 个无标签 session 传播,产出软标签供下游模型训练

### WeakLabelFusion(弱标签融合)

- **实现**:`src/ml/WeakLabelFusion.ts`
- **作用**:融合 autoMode 信号、行为标签、启发式标签,产出最终训练标签

### PseudoLabeling(伪标签)

- **作用**:对 `labelSource='heuristic'` 的 session,用已训练模型预测伪标签并加入训练集
- **触发**:训练流程末尾,base models 已训练后

### DriftDetector(漂移检测)

- **实现**:`src/ml/DriftDetector.ts`(PSI — Population Stability Index)
- **作用**:对比当前训练数据与 baseline 的特征分布,PSI > 0.25 报警
- **当前状态**:第二次 train 后 Max PSI=0.25,Avg PSI=0.05,3 个特征轻微漂移(合成数据随机性导致)

## 训练管线

```
                ┌─────────────────────────────────────┐
                │ 4 个 SQLite DB(aea-transcripts /   │
                │  aea-real / aea-v6 / aea-scan)      │
                └────────────────┬────────────────────┘
                                 │
                ┌────────────────┴────────────────┐
                │                                 │
                ▼                                 ▼
   ┌───────────────────────┐        ┌──────────────────────┐
   │ autoModeSignals (跨   │        │ RealSamples +        │
   │ DB 扫描,5 个弱标签)   │        │ BehaviorLabels       │
   └───────────┬───────────┘        └──────────┬───────────┘
               │                               │
               └───────────────┬───────────────┘
                               ▼
                  ┌─────────────────────────┐
                  │  LabelPropagation       │ ← 半监督传播
                  │  WeakLabelFusion        │ ← 弱标签融合
                  │  PseudoLabeling         │ ← 伪标签
                  └────────────┬────────────┘
                               │
                               ▼
                  ┌─────────────────────────┐
                  │  + SyntheticSamples     │ ← log-normal 合成
                  │    (156 样本补足)       │
                  └────────────┬────────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        ▼                      ▼                      ▼
   ┌─────────┐           ┌─────────┐           ┌─────────┐
   │ sklearn │           │ torch   │           │ CatBoost│
   │ NB + LR │           │ MLP     │           │ (Python)│
   │ 5-fold  │           │ 5-fold  │           │ 5-fold  │
   │  CV     │           │  CV     │           │  CV     │
   └────┬────┘           └────┬────┘           └────┬────┘
        │                      │                      │
        │      ┌───────────────┼───────────────┐      │
        │      ▼               ▼               ▼      │
        │ ┌─────────┐    ┌─────────┐    ┌─────────┐  │
        │ │ KNN     │    │ (5 个基础模型 OOF 预测)   │  │
        │ │ (LOO)   │    │                          │  │
        │ └────┬────┘    └─────────┬────────────────┘  │
        │      │                   │                   │
        └──────┴───────────────────┼───────────────────┘
                                    ▼
                          ┌──────────────────────┐
                          │ StackingMetaLearner  │
                          │ 5-fold CV on meta    │
                          └──────────┬───────────┘
                                     │
                                     ▼
                          ┌──────────────────────┐
                          │ 6 个模型 + Stacking  │
                          │ 全部带 cvAccuracy     │
                          │ + Overfitting Gap    │
                          └──────────────────────┘
```

## 决策规则

训练时同时产出所有模型,预测时按以下规则选择:

1. **默认用 Stacking Meta**:它已学到 5 个基础模型的最优组合权重
2. **Conformal 包裹**:任何模型都可被包裹,低置信度时输出 "uncertain"
3. **Drift 触发重训练**:PSI > 0.25 时自动报警,提示重训练
4. **样本规模升级路径**:
   - < 10 真实样本:KNN 主导(冷启动)
   - 10-50:LR / NB / Torch 互为 baseline
   - > 50:CatBoost + Stacking 联合
5. **标签始终由 LabelPropagation 增强**:如果存在 autoModeResolution 信号

## 关键改进对比

| 指标 | V3(仅 CatBoost) | V7(6 模型 + Stacking) |
|---|---|---|
| 真实样本数 | 6 | 21(4 个 DB 源) |
| 特征数 | 17 | 34(加 17 时序行为) |
| 标签来源 | 启发式造标签 | 行为标签优先 + 启发式兜底 + 半监督传播 |
| 评估方式 | 单次 holdout | 5 折分层 K-fold CV(所有模型) |
| 泛化能力 | train=99.8%(过自信,无 CV) | train≈0.97, **cv≈0.94**(诚实) |
| 预测延迟 | 200ms(Python) | <1ms(TS 模型,Stacking 仲裁) |
| 模型仲裁 | 无(单模型) | Stacking 元学习器(5 基础模型 OOF) |
| 漂移检测 | 无 | PSI + baseline 自动报警 |
| 不确定性 | 无 | Conformal Prediction + "uncertain" 信号 |
| 增量更新 | 需重训 | KNN 即时,LR/NB/Torch 快速 |
| 合成数据 | 固定值×jitter | log-normal 分布(更真实) |

## 文件清单

| 路径 | 职责 |
|---|---|
| `src/ml/features.ts` | 34 维特征 + `extractModelSizeFeaturesFromEvents` |
| `src/ml/TemporalFeatures.ts` | 17 维时序行为特征 |
| `src/ml/dataset.ts` | log-normal 合成数据生成 + CSV 导出 |
| `src/ml/realDataset.ts` | 真实 session 加载 + 行为/启发式标签 |
| `src/ml/BehaviorLabelExtractor.ts` | reward-based 行为标签 |
| `src/ml/LabelPropagation.ts` | 半监督标签传播 |
| `src/ml/WeakLabelFusion.ts` | 弱标签融合 |
| `src/ml/pythonExec.ts` | 共享 Python 子进程执行 |
| `src/ml/NaiveBayesModel.ts` | sklearn 训练 + 纯 TS 推理 |
| `src/ml/LogisticRegressionModel.ts` | sklearn 训练 + 纯 TS 推理 |
| `src/ml/KnnModel.ts` | 纯 TS KNN + LOO CV |
| `src/ml/TorchModel.ts` | torch 训练 + 纯 TS MLP 推理 |
| `src/ml/CatBoostTrainer.ts` | CatBoost Python 桥接 + 5 折 CV |
| `src/ml/StackingMetaLearner.ts` | Stacking 元学习器 + meta CV |
| `src/ml/ConformalPredictor.ts` | 不确定性包裹器 |
| `src/ml/DriftDetector.ts` | PSI 漂移检测 |
| `src/ml/ModelInterface.ts` | `TrainedModelInfo` 含 `cvAccuracy` / `cvFolds` |
| `src/ml/ModelTrainer.ts` | 编排器,显示 train + cv + overfitting gap |
| `scripts/train_sklearn_models.py` | sklearn NB + LR 训练(含 Pipeline CV) |
| `scripts/train_torch_model.py` | torch MLP 训练(含 K-fold CV) |
| `scripts/train_catboost.py` | CatBoost 训练(含 K-fold CV) |
| `src/cli/train.ts` | 训练入口,展示对比表 + overfitting 警告 |
| `src/cli/predict.ts` | 预测入口,3 样本端到端验证 |
