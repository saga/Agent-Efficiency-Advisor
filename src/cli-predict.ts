import { CatBoostModel } from './ml/CatBoostModel.js';
import type { ModelSizeFeatures } from './ml/features.js';

const samples: ModelSizeFeatures[] = [
  // mini-like
  {
    promptTokens: 2500,
    completionTokens: 600,
    contextTokens: 3100,
    toolCalls: 3,
    readFiles: 3,
    edits: 1,
    retries: 0,
    uniqueFilesRead: 1,
    uniqueFilesEdited: 1,
    elapsedMs: 5000,
    contextUtilization: 0.05,
    readToEditRatio: 3,
    retryRate: 0,
    hasLoop: 0,
    subAgents: 0,
  },
  // large-like
  {
    promptTokens: 70000,
    completionTokens: 25000,
    contextTokens: 95000,
    toolCalls: 45,
    readFiles: 60,
    edits: 12,
    retries: 6,
    uniqueFilesRead: 25,
    uniqueFilesEdited: 10,
    elapsedMs: 150000,
    contextUtilization: 0.8,
    readToEditRatio: 5,
    retryRate: 0.18,
    hasLoop: 1,
    subAgents: 3,
  },
];

async function main() {
  const model = new CatBoostModel({ modelPath: './data/ml/model.cbm' });

  console.log('Predicting with trained CatBoost model...\n');
  const results = await model.predictBatch(samples);

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    console.log(`Sample ${i + 1}:`);
    console.log(`  Recommended model: ${r.label}`);
    console.log(`  Confidence: ${(r.confidence * 100).toFixed(1)}%`);
    console.log(`  Probabilities: mini=${(r.probabilities[0] * 100).toFixed(1)}% medium=${(r.probabilities[1] * 100).toFixed(1)}% large=${(r.probabilities[2] * 100).toFixed(1)}%`);
    console.log();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
