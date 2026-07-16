# ML 算法对比与选型

> 本文档记录 Agent Efficiency Advisor 项目的 ML 算法选型分析。
> 当前实现保留 CatBoost,同时新增 4 种纯 TS 算法,训练时同时产出所有模型。

## 数据画像(截至 2026-07-16)

| 维度 | 现状 |
|---|---|
| 真实样本数 | 6 个有效 session(25 个中事件充足的) |
| 特征数 | 17 个(含 autoModePredictedLabel / autoModeConfidence) |
| 类别数 | 3(mini / medium / large) |
| 标签来源 | 启发式规则 `heuristicLabel()` 生成(非真实标签) |
| 半监督信号 | 5 个 autoModeResolution(Copilot 内部 ML 预测) |
| promptTokens | 18k-97k,均值 47k |
| 预测延迟 | ~200ms(CatBoost Python 子进程) |

## 算法清单

### 1. CatBoost(保留)

- **类型**:梯度提升树
- **实现**:`src/ml/CatBoostTrainer.ts` + Python 子进程
- **优点**:非线性表达力强,自动处理特征交互
- **缺点**:
  - 6 样本 + 17 特征 + 300 棵树 → 严重过拟合
  - 标签是启发式造的,模型在"学自己"
  - Python 子进程开销 200ms/预测
- **适用**:样本 >50 后重新成为主力

### 2. Bayesian Logistic Regression(新增)

- **类型**:带 L2 正则的 softmax 回归 + 贝叶斯先验
- **实现**:`src/ml/LogisticRegressionModel.ts`(纯 TS)
- **优点**:
  - 线性模型在 6 样本下比树模型更不容易过拟合
  - 预测 <1ms(无 Python 子进程)
  - 天然输出概率,可直接作为置信度
  - 系数可解释(每个特征对每类的权重)
- **缺点**:线性假设可能欠拟合非线性关系
- **适用**:小样本主力模型,与 NB 互为 baseline

### 3. Gaussian Naive Bayes(新增)

- **类型**:朴素贝叶斯(高斯似然)
- **实现**:`src/ml/NaiveBayesModel.ts`(纯 TS)
- **优点**:
  - 6 样本足以估计均值/方差
  - 纯 JS ~80 行,预测 <0.1ms
  - 天然处理缺失特征(特征条件独立假设下)
  - 概率输出自然校准
- **缺点**:特征独立假设通常不成立(promptTokens 和 contextTokens 高度相关)
- **适用**:baseline,与 LR 对比防止过拟合

### 4. KNN 距离加权(新增)

- **类型**:K 最近邻 + 距离倒数加权投票
- **实现**:`src/ml/KnnModel.ts`(纯 TS)
- **优点**:
  - 零训练成本,新数据即时生效
  - 天然增量(新 session 直接加入参考集)
  - 6 样本时 K=3 即可
- **缺点**:需要特征归一化;高维下距离失效(curse of dimensionality)
- **适用**:冷启动阶段,样本极少时的默认模型

### 5. Label Propagation 半监督标签传播(新增)

- **类型**:基于特征相似度图的标签传播
- **实现**:`src/ml/LabelPropagation.ts`(纯 TS)
- **用途**:不是独立分类器,而是为其他模型生成更好的标签
- **原理**:
  1. 有弱标签 session(5 个):autoMode predictedLabel → 初始标签
  2. 无标签 session(20 个):通过特征相似度从有标签 session 传播标签
  3. 收敛后:所有 session 获得软标签(概率分布)
- **优点**:
  - 直接利用 Copilot 自己的 ML 预测作为信号源,而非自己造标签
  - 天然处理小样本 + 无标签数据
  - 纯 JS 实现(图算法 + 迭代传播)
- **适用**:标签增强层,改善所有下游模型的训练标签质量

### 6. Conformal Prediction(新增)

- **类型**:不确定性包裹器(非独立分类器)
- **实现**:`src/ml/ConformalPredictor.ts`(纯 TS)
- **用途**:包裹任意基础模型,输出校准的"我不确定"信号
- **原理**:
  - 用 calibration set 计算每个样本的 nonconformity score
  - 预测时:若 top-1 和 top-2 概率差 < threshold → 输出 "uncertain"
  - 保证:在 calibration set 上的覆盖率 = 1 - α
- **优点**:数学上保证覆盖率,不依赖模型假设
- **适用**:生产环境,防止过自信预测误导用户

## 推荐组合架构

```
                    autoModeResolution (Copilot 弱标签)
                           │
                           ▼
                   ┌───────────────┐
                   │  LabelProp    │  半监督标签传播
                   │  (标签增强)   │  → 改善训练标签
                   └───────┬───────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │   CatBoost│ │   LR     │ │   NB     │  3 个独立分类器
        │  (Python) │ │  (TS)    │ │  (TS)    │
        └─────┬────┘ └─────┬────┘ └─────┬────┘
              │            │            │
              └────────────┼────────────┘
                           ▼
                   ┌───────────────┐
                   │ Conformal     │  不确定性包裹
                   │ (校准 + 拒绝) │
                   └───────┬───────┘
                           │
                           ▼
                     最终预测 + 置信度
```

## 决策规则

训练时同时产出所有模型,预测时按以下规则选择:

1. 真实样本 < 10:用 **KNN**(冷启动)
2. 真实样本 10-50:用 **LR / NB**(对比选优)
3. 真实样本 > 50:用 **CatBoost**(主力)
4. 任何阶段:用 **Conformal** 包裹,低置信度时输出 "uncertain"
5. 标签始终由 **LabelPropagation** 增强(如果存在 autoModeResolution 信号)

## 关键改进

| 指标 | 仅 CatBoost | 多模型组合 |
|---|---|---|
| 预测延迟 | 200ms(Python) | <1ms(TS 模型) |
| 标签来源 | 启发式造标签 | Copilot 弱标签传播 |
| 置信度 | 99.8%(过自信) | 校准概率 + uncertain 信号 |
| 小样本表现 | 过拟合 | LR/NB/KNN 更稳健 |
| 增量更新 | 需重训 | KNN 即时,LR/NB 快速 |
