import { spawn } from 'node:child_process';
import path from 'node:path';
import type { ModelSizeFeatures, ModelSizeLabel } from './features.js';
import { INDEX_LABEL } from './features.js';
import { resolvePythonExecutable } from './pythonResolver.js';

export interface PredictionResult {
  classIndex: number;
  label: ModelSizeLabel;
  probabilities: number[];
  confidence: number;
}

export interface CatBoostModelOptions {
  modelPath: string;
  pythonScript?: string;
}

export class CatBoostModel {
  constructor(private options: CatBoostModelOptions) {}

  async predict(features: ModelSizeFeatures): Promise<PredictionResult> {
    return this.predictBatch([features]).then((results) => results[0]);
  }

  async predictBatch(features: ModelSizeFeatures[]): Promise<PredictionResult[]> {
    const pythonScript = this.options.pythonScript
      ? path.resolve(this.options.pythonScript)
      : path.resolve(process.cwd(), 'scripts/predict_catboost.py');

    const python = resolvePythonExecutable();
    const args = [
      pythonScript,
      '--model', this.options.modelPath,
      '--features-json', JSON.stringify(features),
    ];

    const stdout = await execPython([python, ...args]);
    const parsed = JSON.parse(stdout) as { classIndex: number; probabilities: number[]; confidence: number } | Array<{ classIndex: number; probabilities: number[]; confidence: number }>;
    const raw = Array.isArray(parsed) ? parsed : [parsed];

    return raw.map((r) => ({
      classIndex: r.classIndex,
      label: INDEX_LABEL[r.classIndex],
      probabilities: r.probabilities,
      confidence: r.confidence,
    }));
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
        reject(new Error(`CatBoost prediction failed (${code}): ${stderr || stdout}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}
