import { CatBoostTrainer } from './ml/CatBoostTrainer.js';
import { loadRealTrainingSamples } from './ml/realDataset.js';
import { generateSyntheticDataset } from './ml/dataset.js';
import type { TrainingSample } from './ml/dataset.js';

const REAL_DB_SOURCES = [
  './data/aea-real-copilot.db',
  './data/aea-session-store.db',
];

function summarizeLabels(samples: TrainingSample[]): Record<string, number> {
  const byLabel = new Map<string, number>();
  for (const s of samples) {
    byLabel.set(s.label, (byLabel.get(s.label) ?? 0) + 1);
  }
  return Object.fromEntries(byLabel);
}

async function main() {
  const trainer = new CatBoostTrainer();

  // 1. Collect observed real sessions from all AEA data sources.
  const sourceSamples = new Map<string, TrainingSample[]>();
  for (const dbPath of REAL_DB_SOURCES) {
    const samples = loadRealTrainingSamples({ dbPath });
    if (samples.length > 0) {
      sourceSamples.set(dbPath, samples);
    }
  }

  // Merge and dedupe by sessionId; a session may appear in both debug logs
  // and session-store, but the EventStore session_id is the canonical key.
  const realById = new Map<string, TrainingSample>();
  for (const [dbPath, samples] of sourceSamples) {
    for (const s of samples) {
      // Prefer the richer debug-log representation if a session exists twice.
      if (!realById.has(s.sessionId)) {
        realById.set(s.sessionId, s);
      }
    }
  }
  const realSamples = Array.from(realById.values());
  let samples: TrainingSample[] = realSamples;

  console.log(`Found ${realSamples.length} real session(s) across ${sourceSamples.size} source(s).`);
  for (const [dbPath, list] of sourceSamples) {
    console.log(`  ${dbPath}: ${list.length} session(s) -> ${JSON.stringify(summarizeLabels(list))}`);
  }
  if (realSamples.length > 0) {
    console.log('Real label distribution:', summarizeLabels(realSamples));
  }

  // 2. If real data is too small or imbalanced, pad with synthetic samples.
  const minRealSamples = 50;
  if (realSamples.length < minRealSamples) {
    const synthSize = minRealSamples * 3;
    console.log(`Real data insufficient (${realSamples.length} < ${minRealSamples}); padding with ${synthSize} synthetic samples.`);
    samples = [...realSamples, ...generateSyntheticDataset(synthSize)];
  } else {
    console.log('Training on real data only.');
  }

  const byLabel = new Map<string, number>();
  for (const s of samples) {
    byLabel.set(s.label, (byLabel.get(s.label) ?? 0) + 1);
  }
  console.log('Final label distribution:', Object.fromEntries(byLabel));

  const result = await trainer.train({
    samples,
    outDir: './data/ml',
    modelOut: './data/ml/model.cbm',
    iterations: 300,
    depth: 6,
    learningRate: 0.1,
  });

  console.log('\nTraining complete:');
  console.log(`  Model: ${result.modelOut}`);
  console.log(`  Trees: ${result.iterations}`);
  console.log('\nFeature importance:');
  const sorted = Object.entries(result.featureImportance).sort((a, b) => b[1] - a[1]);
  for (const [name, score] of sorted) {
    console.log(`  ${name}: ${score.toFixed(2)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
