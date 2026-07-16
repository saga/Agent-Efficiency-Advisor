// 训练所有 ML 模型方案(CatBoost + LR + NB + KNN + Conformal)
//
// 用法:npm run train

import { loadRealTrainingSamples, loadRealTrainingSamplesWithMeta } from '../ml/realDataset.js';
import { generateSyntheticDataset } from '../ml/dataset.js';
import type { TrainingSample } from '../ml/dataset.js';
import { ModelTrainer } from '../ml/ModelTrainer.js';
import type { AutoModeSignal } from '../ml/LabelPropagation.js';
import { EventStore } from '../store/EventStore.js';
import { openDatabase } from '../store/schema.js';
import { encodeAutoModeLabel } from '../ml/features.js';

const REAL_DB_SOURCES = [
  './data/aea-real-copilot.db',
  './data/aea-session-store.db',
  './data/aea-transcripts.db',
];

function summarizeLabels(samples: TrainingSample[]): Record<string, number> {
  const byLabel = new Map<string, number>();
  for (const s of samples) {
    byLabel.set(s.label, (byLabel.get(s.label) ?? 0) + 1);
  }
  return Object.fromEntries(byLabel);
}

/**
 * 从 aea-real.db 中提取 autoModeResolution 信号,用于标签传播。
 */
function loadAutoModeSignals(dbPath: string): Map<string, AutoModeSignal> {
  const signals = new Map<string, AutoModeSignal>();
  if (!require('node:fs').existsSync(dbPath)) return signals;

  const db = openDatabase(dbPath);
  const eventStore = new EventStore(db);

  for (const sessionId of eventStore.getSessionIds()) {
    const events = eventStore.getBySession(sessionId);
    for (const e of events) {
      if (e.eventType !== 'completion') continue;
      const m = e.metadata ?? {};
      if (m.autoModePredictedLabel !== undefined && m.autoModeConfidence !== undefined) {
        signals.set(sessionId, {
          predictedLabel: String(m.autoModePredictedLabel),
          confidence: Number(m.autoModeConfidence),
        });
        break; // 每个 session 只取第一个 autoMode 信号
      }
    }
  }

  db.close();
  return signals;
}

async function main() {
  // 1. 收集真实数据（使用行为标签）
  const sourceSamples = new Map<string, TrainingSample[]>();
  const behaviorStats = { behavior: 0, heuristic: 0 };

  for (const dbPath of REAL_DB_SOURCES) {
    const samples = loadRealTrainingSamplesWithMeta({ dbPath, useBehaviorLabels: true });
    if (samples.length > 0) {
      for (const s of samples) {
        if (s.labelSource === 'behavior') behaviorStats.behavior++;
        else behaviorStats.heuristic++;
      }
      sourceSamples.set(dbPath, samples);
    }
  }

  const realById = new Map<string, TrainingSample>();
  for (const [, samples] of sourceSamples) {
    for (const s of samples) {
      if (!realById.has(s.sessionId)) {
        realById.set(s.sessionId, s);
      }
    }
  }
  const realSamples = Array.from(realById.values());
  let samples: TrainingSample[] = realSamples;

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Multi-Model Training (Behavior Labels + Stacking)');
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log(`Found ${realSamples.length} real session(s) across ${sourceSamples.size} source(s).`);
  for (const [dbPath, list] of sourceSamples) {
    console.log(`  ${dbPath}: ${list.length} session(s) -> ${JSON.stringify(summarizeLabels(list))}`);
  }
  if (realSamples.length > 0) {
    console.log('Real label distribution:', summarizeLabels(realSamples));
    console.log(`Label sources: behavior=${behaviorStats.behavior}, heuristic=${behaviorStats.heuristic}`);
  }

  // 2. 加载 autoModeResolution 信号
  const autoModeSignals = loadAutoModeSignals(REAL_DB_SOURCES[0]);
  console.log(`\nAutoMode signals: ${autoModeSignals.size} session(s) with Copilot ML predictions`);
  for (const [sid, sig] of autoModeSignals) {
    console.log(`  ${sid.slice(0, 8)}: ${sig.predictedLabel} (conf=${sig.confidence.toFixed(2)})`);
  }

  // 3. 如果真实数据不足,补充合成数据
  const minRealSamples = 50;
  if (realSamples.length < minRealSamples) {
    const synthSize = minRealSamples * 3;
    console.log(`\nReal data insufficient (${realSamples.length} < ${minRealSamples}); padding with ${synthSize} synthetic samples.`);
    samples = [...realSamples, ...generateSyntheticDataset(synthSize)];
  } else {
    console.log('\nTraining on real data only.');
  }

  console.log('Final label distribution:', summarizeLabels(samples));

  // 4. 用 ModelTrainer 训练所有模型
  console.log('\n───────── Training all models ─────────\n');

  const trainer = new ModelTrainer();
  const result = await trainer.trainAll({
    samples,
    realSamples: realSamples.length,
    outDir: './data/ml',
    autoModeSignals,
    enableLabelPropagation: autoModeSignals.size > 0,
  });

  // 5. 输出训练报告
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  Training Report');
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log(`Total samples: ${result.totalSamples} (real=${result.realSamples}, synthetic=${result.syntheticSamples})`);

  if (result.labelPropagation) {
    console.log(`Label propagation: ${result.labelPropagation.iterations} iterations, converged=${result.labelPropagation.converged}, autoMode anchors=${result.labelPropagation.autoModeAnchors}`);
  }

  console.log('\nModel comparison:');
  console.log('  ┌────────────────────────────┬──────────┬───────────┐');
  console.log('  │ Model                      │ Accuracy │ Samples   │');
  console.log('  ├────────────────────────────┼──────────┼───────────┤');
  for (const m of result.models) {
    const acc = m.accuracy !== undefined ? m.accuracy.toFixed(3) : 'n/a';
    console.log(`  │ ${m.modelName.padEnd(26)} │ ${acc.padEnd(8)} │ ${String(m.trainSamples).padEnd(9)} │`);
  }
  console.log('  └────────────────────────────┴──────────┴───────────┘');

  // 特征重要性对比
  for (const m of result.models) {
    if (m.featureImportance && Object.keys(m.featureImportance).length > 0) {
      console.log(`\n${m.modelName} feature importance:`);
      const sorted = Object.entries(m.featureImportance).sort((a, b) => b[1] - a[1]);
      for (const [name, score] of sorted.slice(0, 5)) {
        console.log(`  ${name}: ${score.toFixed(4)}`);
      }
    }
  }

  console.log('\nDone. Models saved to ./data/ml/');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
