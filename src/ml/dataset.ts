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

function generateFeaturesForLabel(label: ModelSizeLabel): ModelSizeFeatures {
  const jitter = () => 0.8 + Math.random() * 0.4;

  if (label === 'mini') {
    return {
      promptTokens: Math.round(2000 * jitter()),
      completionTokens: Math.round(500 * jitter()),
      contextTokens: Math.round(2500 * jitter()),
      toolCalls: Math.round(3 * jitter()),
      readFiles: Math.round(3 * jitter()),
      edits: Math.round(1 * jitter()),
      retries: 0,
      uniqueFilesRead: 1,
      uniqueFilesEdited: 1,
      elapsedMs: Math.round(5000 * jitter()),
      contextUtilization: 0.05 * jitter(),
      readToEditRatio: 3,
      retryRate: 0,
      hasLoop: 0,
      subAgents: 0,
    };
  }

  if (label === 'medium') {
    return {
      promptTokens: Math.round(15000 * jitter()),
      completionTokens: Math.round(4000 * jitter()),
      contextTokens: Math.round(19000 * jitter()),
      toolCalls: Math.round(12 * jitter()),
      readFiles: Math.round(15 * jitter()),
      edits: Math.round(4 * jitter()),
      retries: Math.round(1 * jitter()),
      uniqueFilesRead: Math.round(5 * jitter()),
      uniqueFilesEdited: Math.round(3 * jitter()),
      elapsedMs: Math.round(30000 * jitter()),
      contextUtilization: 0.25 * jitter(),
      readToEditRatio: 4,
      retryRate: 0.05,
      hasLoop: Math.random() > 0.9 ? 1 : 0,
      subAgents: 0,
    };
  }

  return {
    promptTokens: Math.round(60000 * jitter()),
    completionTokens: Math.round(20000 * jitter()),
    contextTokens: Math.round(80000 * jitter()),
    toolCalls: Math.round(40 * jitter()),
    readFiles: Math.round(50 * jitter()),
    edits: Math.round(10 * jitter()),
    retries: Math.round(5 * jitter()),
    uniqueFilesRead: Math.round(20 * jitter()),
    uniqueFilesEdited: Math.round(8 * jitter()),
    elapsedMs: Math.round(120000 * jitter()),
    contextUtilization: 0.7 * jitter(),
    readToEditRatio: 5,
    retryRate: 0.15,
    hasLoop: Math.random() > 0.5 ? 1 : 0,
    subAgents: Math.round(2 * jitter()),
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
