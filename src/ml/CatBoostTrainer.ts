import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { TrainingSample } from './dataset.js';
import { generateSyntheticDataset, saveDataset } from './dataset.js';
import { resolvePythonExecutable } from './pythonResolver.js';

export interface TrainOptions {
  trainCsv?: string;
  testCsv?: string;
  modelOut?: string;
  featureImportanceOut?: string;
  samples?: TrainingSample[];
  outDir?: string;
  iterations?: number;
  depth?: number;
  learningRate?: number;
  pythonScript?: string;
}

export interface TrainResult {
  modelOut: string;
  iterations: number;
  featureImportance: Record<string, number>;
}

function resolveScript(defaultRelative: string, override?: string): string {
  if (override) return path.resolve(override);
  return path.resolve(process.cwd(), defaultRelative);
}

export class CatBoostTrainer {
  async train(options: TrainOptions = {}): Promise<TrainResult> {
    let trainCsv = options.trainCsv;
    let outDir: string | undefined;

    if (!trainCsv && options.samples) {
      outDir = options.outDir ?? './data/ml';
      const paths = saveDataset(options.samples, outDir);
      trainCsv = paths.csvPath;
    }

    if (!trainCsv) {
      outDir = options.outDir ?? './data/ml';
      const samples = generateSyntheticDataset(2000);
      const paths = saveDataset(samples, outDir);
      trainCsv = paths.csvPath;
    }

    if (!fs.existsSync(trainCsv)) {
      throw new Error(`Training CSV not found: ${trainCsv}`);
    }

    const modelOut = options.modelOut ?? path.join(path.dirname(trainCsv), 'model.cbm');
    const featureImportanceOut = options.featureImportanceOut ?? path.join(path.dirname(trainCsv), 'feature_importance.json');

    const pythonScript = resolveScript('scripts/train_catboost.py', options.pythonScript);

    const args = [
      pythonScript,
      '--train-csv', trainCsv,
      '--model-out', modelOut,
      '--feature-importance-out', featureImportanceOut,
      '--iterations', String(options.iterations ?? 200),
      '--depth', String(options.depth ?? 6),
      '--learning-rate', String(options.learningRate ?? 0.1),
    ];

    if (options.testCsv) {
      args.push('--test-csv', options.testCsv);
    }

    const python = resolvePythonExecutable();
    const stdout = await execPython([python, ...args]);
    const result = JSON.parse(stdout) as TrainResult;
    return result;
  }
}

function execPython(command: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command[0], command.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`CatBoost training failed (${code}): ${stderr || stdout}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}
