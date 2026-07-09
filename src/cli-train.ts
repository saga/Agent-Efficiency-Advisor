import { CatBoostTrainer } from './ml/CatBoostTrainer.js';

async function main() {
  const trainer = new CatBoostTrainer();
  console.log('Generating synthetic dataset and training CatBoost model...');

  const result = await trainer.train({
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
