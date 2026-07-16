import fs from 'node:fs';
import path from 'node:path';
import type { ModelSizeFeatures, ModelSizeLabel } from './features.js';
import { FEATURE_COLUMNS, LABEL_INDEX } from './features.js';

export interface TrainingSample {
  features: ModelSizeFeatures;
  label: ModelSizeLabel;
  sessionId: string;
}

export function generateSyntheticDataset(size = 1000): TrainingSample[] {
  const samples: TrainingSample[] = [];
  for (let i = 0; i < size; i++) {
    const label = pickLabel(i, size);
    samples.push({
      sessionId: `synth-${i}`,
      label,
      features: generateFeaturesForLabel(label),
    });
  }
  return samples;
}

function pickLabel(index: number, total: number): ModelSizeLabel {
  const r = index / total;
  if (r < 0.5) return 'mini';
  if (r < 0.8) return 'medium';
  return 'large';
}

/** Box-Muller 变换:生成标准正态分布随机数 */
function randn(): number {
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** 对数正态分布:median 是中位数,sigma 是 log 空间标准差(越大越分散) */
function logNormal(median: number, sigma: number): number {
  return Math.exp(Math.log(median) + sigma * randn());
}

/** 在 [min, max] 范围内均匀取整 */
function randInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

/** 以概率 p 返回 1,否则 0 */
function maybe(p: number): number {
  return Math.random() < p ? 1 : 0;
}

function generateFeaturesForLabel(label: ModelSizeLabel): ModelSizeFeatures {
  const randHour = () => randInt(0, 23);
  const randDay = () => randInt(0, 6);

  if (label === 'mini') {
    const promptTokens = Math.max(500, Math.round(logNormal(2500, 0.5)));
    const completionTokens = Math.max(100, Math.round(logNormal(600, 0.5)));
    const toolCalls = randInt(0, 6);
    const edits = randInt(0, 2);
    const acceptRate = 0.85 + Math.random() * 0.15;
    const elapsedMs = Math.max(1000, Math.round(logNormal(6000, 0.6)));
    return {
      promptTokens,
      completionTokens,
      contextTokens: promptTokens + completionTokens,
      toolCalls,
      readFiles: Math.max(0, toolCalls - edits),
      edits,
      retries: 0,
      uniqueFilesRead: Math.max(1, Math.round(toolCalls * 0.5)),
      uniqueFilesEdited: Math.min(edits, 2),
      elapsedMs,
      contextUtilization: Math.min(0.1, (promptTokens + completionTokens) / 200000),
      readToEditRatio: edits > 0 ? toolCalls / edits : toolCalls,
      retryRate: 0,
      hasLoop: 0,
      subAgents: 0,
      autoModePredictedLabel: 1,
      autoModeConfidence: 0.5 + Math.random() * 0.3,
      hourOfDay: randHour(),
      dayOfWeek: randDay(),
      isWeekend: maybe(0.3),
      chatDurationMs: Math.round(elapsedMs * 0.4),
      toolDurationMs: Math.round(elapsedMs * 0.3),
      idleMs: Math.round(elapsedMs * 0.2),
      chatToToolRatio: toolCalls > 0 ? 1 + Math.random() : 1,
      acceptRate,
      cancelRate: 0,
      switchRate: 0,
      toolSuccessRate: acceptRate,
      rollingAvgTokens: Math.round(promptTokens * (0.7 + Math.random() * 0.6)),
      rollingAvgDuration: Math.round(elapsedMs * (0.7 + Math.random() * 0.6)),
      rollingAcceptRate: acceptRate * (0.8 + Math.random() * 0.3),
      emaTokens: Math.round(promptTokens * (0.5 + Math.random() * 0.5)),
      emaRetryRate: 0,
      sessionsToday: randInt(1, 5),
    };
  }

  if (label === 'medium') {
    const promptTokens = Math.max(3000, Math.round(logNormal(15000, 0.6)));
    const completionTokens = Math.max(800, Math.round(logNormal(4000, 0.6)));
    const toolCalls = randInt(6, 25);
    const edits = randInt(2, 8);
    const retries = maybe(0.4) ? randInt(1, 2) : 0;
    const acceptRate = 0.65 + Math.random() * 0.2;
    const elapsedMs = Math.max(5000, Math.round(logNormal(40000, 0.7)));
    const retryRate = retries / Math.max(1, toolCalls + retries);
    return {
      promptTokens,
      completionTokens,
      contextTokens: promptTokens + completionTokens,
      toolCalls,
      readFiles: Math.max(0, toolCalls - edits),
      edits,
      retries,
      uniqueFilesRead: Math.round(toolCalls * 0.4),
      uniqueFilesEdited: Math.round(edits * 0.7),
      elapsedMs,
      contextUtilization: Math.min(0.5, (promptTokens + completionTokens) / 200000),
      readToEditRatio: edits > 0 ? toolCalls / edits : toolCalls,
      retryRate,
      hasLoop: maybe(0.1),
      subAgents: maybe(0.1) ? 1 : 0,
      autoModePredictedLabel: maybe(0.5) ? 1 : 2,
      autoModeConfidence: 0.4 + Math.random() * 0.3,
      hourOfDay: randHour(),
      dayOfWeek: randDay(),
      isWeekend: maybe(0.3),
      chatDurationMs: Math.round(elapsedMs * 0.35),
      toolDurationMs: Math.round(elapsedMs * 0.45),
      idleMs: Math.round(elapsedMs * 0.2),
      chatToToolRatio: 0.5 + Math.random() * 0.8,
      acceptRate,
      cancelRate: Math.random() * 0.08,
      switchRate: Math.random() * 0.05,
      toolSuccessRate: acceptRate * (0.9 + Math.random() * 0.1),
      rollingAvgTokens: Math.round(promptTokens * (0.7 + Math.random() * 0.6)),
      rollingAvgDuration: Math.round(elapsedMs * (0.7 + Math.random() * 0.6)),
      rollingAcceptRate: acceptRate * (0.8 + Math.random() * 0.3),
      emaTokens: Math.round(promptTokens * (0.5 + Math.random() * 0.5)),
      emaRetryRate: retryRate * (0.5 + Math.random()),
      sessionsToday: randInt(1, 6),
    };
  }

  // large
  const promptTokens = Math.max(10000, Math.round(logNormal(60000, 0.7)));
  const completionTokens = Math.max(3000, Math.round(logNormal(20000, 0.7)));
  const toolCalls = randInt(20, 80);
  const edits = randInt(5, 20);
  const retries = randInt(2, 10);
  const acceptRate = 0.45 + Math.random() * 0.25;
  const elapsedMs = Math.max(20000, Math.round(logNormal(150000, 0.8)));
  const retryRate = retries / Math.max(1, toolCalls + retries);
  return {
    promptTokens,
    completionTokens,
    contextTokens: promptTokens + completionTokens,
    toolCalls,
    readFiles: Math.max(0, toolCalls - edits),
    edits,
    retries,
    uniqueFilesRead: Math.round(toolCalls * 0.4),
    uniqueFilesEdited: Math.round(edits * 0.7),
    elapsedMs,
    contextUtilization: Math.min(0.95, (promptTokens + completionTokens) / 200000),
    readToEditRatio: edits > 0 ? toolCalls / edits : toolCalls,
    retryRate,
    hasLoop: maybe(0.5),
    subAgents: randInt(0, 4),
    autoModePredictedLabel: 2,
    autoModeConfidence: 0.7 + Math.random() * 0.2,
    hourOfDay: randHour(),
    dayOfWeek: randDay(),
    isWeekend: maybe(0.3),
    chatDurationMs: Math.round(elapsedMs * 0.3),
    toolDurationMs: Math.round(elapsedMs * 0.5),
    idleMs: Math.round(elapsedMs * 0.2),
    chatToToolRatio: 0.3 + Math.random() * 0.6,
    acceptRate,
    cancelRate: 0.05 + Math.random() * 0.1,
    switchRate: 0.02 + Math.random() * 0.06,
    toolSuccessRate: acceptRate * (0.85 + Math.random() * 0.15),
    rollingAvgTokens: Math.round(promptTokens * (0.7 + Math.random() * 0.6)),
    rollingAvgDuration: Math.round(elapsedMs * (0.7 + Math.random() * 0.6)),
    rollingAcceptRate: acceptRate * (0.8 + Math.random() * 0.3),
    emaTokens: Math.round(promptTokens * (0.5 + Math.random() * 0.5)),
    emaRetryRate: retryRate * (0.5 + Math.random()),
    sessionsToday: randInt(2, 8),
  };
}

export function saveDataset(samples: TrainingSample[], outDir: string): { csvPath: string; cdPath: string } {
  fs.mkdirSync(outDir, { recursive: true });
  const csvPath = path.join(outDir, 'train.csv');
  const cdPath = path.join(outDir, 'train.cd');

  const header = [...FEATURE_COLUMNS, 'label'].join(',');
  const lines = samples.map((s) => {
    const values = FEATURE_COLUMNS.map((col) => String(s.features[col]));
    values.push(String(LABEL_INDEX[s.label]));
    return values.join(',');
  });

  fs.writeFileSync(csvPath, [header, ...lines].join('\n'), 'utf8');

  // CatBoost column description: 0..n-1 are Num features, last is label (Categ label for multiclass)
  const cdLines = FEATURE_COLUMNS.map((_, idx) => `${idx}\tNum\tfeature_${idx}`);
  cdLines.push(`${FEATURE_COLUMNS.length}\tLabel`);
  fs.writeFileSync(cdPath, cdLines.join('\n'), 'utf8');

  return { csvPath, cdPath };
}

export function featuresToCsvRow(features: ModelSizeFeatures): string {
  return FEATURE_COLUMNS.map((col) => String(features[col])).join(',');
}
