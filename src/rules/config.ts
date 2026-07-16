// 规则阈值配置:集中管理所有规则的硬编码阈值,支持通过环境变量覆盖。

// 所有规则的阈值参数集合
export interface RuleConfig {
  // ContextTooLargeRule:上下文占用率阈值(0-1)
  contextTooLarge: {
    warningUtilization: number; // 触发 warning 的占用率
    criticalUtilization: number; // 触发 critical 的占用率
  };
  // ReadFileStormRule:读取文件风暴阈值
  readFileStorm: {
    threshold: number; // 触发告警的最小读取文件数
  };
  // ToolLoopRule:工具循环检测参数
  toolLoop: {
    window: number; // 检测窗口大小
    minRepeats: number; // 视为循环的最小重复次数
  };
  // RetryRule:重试告警阈值
  retry: {
    threshold: number; // 触发告警的最小连续失败次数
  };
  // PromptExplosionRule:prompt 爆炸阈值
  promptExplosion: {
    growthThresholdTokens: number; // prompt 增长 token 数阈值
  };
  // LargeDiffRule:大 diff 阈值
  largeDiff: {
    threshold: number; // 触发告警的最小 diff 行数
  };
  // ModelSwitchRule:模型切换告警关键词
  modelSwitch: {
    keywords: string[]; // 触发告警的模型名关键词列表(小写)
  };
}

// 默认阈值(提取自原硬编码值)
export const DEFAULT_RULE_CONFIG: RuleConfig = {
  contextTooLarge: {
    warningUtilization: 0.8,
    criticalUtilization: 0.95,
  },
  readFileStorm: {
    threshold: 20,
  },
  toolLoop: {
    window: 10,
    minRepeats: 4,
  },
  retry: {
    threshold: 3,
  },
  promptExplosion: {
    growthThresholdTokens: 10000,
  },
  largeDiff: {
    threshold: 100,
  },
  modelSwitch: {
    keywords: ['mini', 'large', 'sonnet'],
  },
};

// 从环境变量加载配置,环境变量前缀为 AEA_RULE_,未设置时使用默认值。
export function loadRuleConfig(): RuleConfig {
  // 深拷贝默认值,避免修改常量
  const config: RuleConfig = JSON.parse(JSON.stringify(DEFAULT_RULE_CONFIG));

  const num = (value: string | undefined): number | undefined => {
    if (value === undefined || value === '') return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  };

  // ContextTooLargeRule
  const ctxWarning = num(process.env.AEA_RULE_CONTEXT_TOO_LARGE_WARNING_UTILIZATION);
  if (ctxWarning !== undefined) config.contextTooLarge.warningUtilization = ctxWarning;
  const ctxCritical = num(process.env.AEA_RULE_CONTEXT_TOO_LARGE_CRITICAL_UTILIZATION);
  if (ctxCritical !== undefined) config.contextTooLarge.criticalUtilization = ctxCritical;

  // ReadFileStormRule
  const readFileThreshold = num(process.env.AEA_RULE_READ_FILE_STORM_THRESHOLD);
  if (readFileThreshold !== undefined) config.readFileStorm.threshold = readFileThreshold;

  // ToolLoopRule
  const loopWindow = num(process.env.AEA_RULE_TOOL_LOOP_WINDOW);
  if (loopWindow !== undefined) config.toolLoop.window = loopWindow;
  const loopMinRepeats = num(process.env.AEA_RULE_TOOL_LOOP_MIN_REPEATS);
  if (loopMinRepeats !== undefined) config.toolLoop.minRepeats = loopMinRepeats;

  // RetryRule
  const retryThreshold = num(process.env.AEA_RULE_RETRY_THRESHOLD);
  if (retryThreshold !== undefined) config.retry.threshold = retryThreshold;

  // PromptExplosionRule
  const growthThreshold = num(process.env.AEA_RULE_PROMPT_EXPLOSION_GROWTH_TOKENS);
  if (growthThreshold !== undefined) config.promptExplosion.growthThresholdTokens = growthThreshold;

  // LargeDiffRule
  const largeDiffThreshold = num(process.env.AEA_RULE_LARGE_DIFF_THRESHOLD);
  if (largeDiffThreshold !== undefined) config.largeDiff.threshold = largeDiffThreshold;

  // ModelSwitchRule:逗号分隔的关键词列表
  const modelKeywords = process.env.AEA_RULE_MODEL_SWITCH_KEYWORDS;
  if (modelKeywords && modelKeywords.trim() !== '') {
    config.modelSwitch.keywords = modelKeywords
      .split(',')
      .map((k) => k.trim().toLowerCase())
      .filter((k) => k !== '');
  }

  return config;
}
