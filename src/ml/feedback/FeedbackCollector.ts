import fs from 'node:fs';
import path from 'node:path';
import type { OutcomeSignal, SessionState } from '../../types.js';
import { extractModelSizeFeatures, FEATURE_COLUMNS, type ModelSizeLabel } from '../features.js';

export interface FeedbackSample {
  sessionId: string;
  features: ReturnType<typeof extractModelSizeFeatures>;
  label: ModelSizeLabel;
  source: 'shadow' | 'outcome';
  confidence: number;
}

export class FeedbackCollector {
  private buffer: FeedbackSample[] = [];

  constructor(private csvPath: string) {}

  recordShadowResult(state: SessionState, label: ModelSizeLabel, confidence: number): void {
    this.buffer.push({
      sessionId: state.sessionId,
      features: extractModelSizeFeatures(state),
      label,
      source: 'shadow',
      confidence,
    });
  }

  recordOutcome(state: SessionState, outcome: OutcomeSignal, recommendedModel: ModelSizeLabel): void {
    const successScore =
      Number(outcome.testPassed) * 0.4 +
      Number(outcome.committed) * 0.3 +
      Number(outcome.noRetry) * 0.2 +
      Number(outcome.noRevert) * 0.1;

    // If outcome is good and we recommended a smaller model, confirm the label.
    // If outcome is bad, bump the label to a larger model.
    let label = recommendedModel;
    if (successScore >= 0.8) {
      // confirm current recommendation
    } else if (successScore < 0.5) {
      label = bumpModel(label);
    } else {
      return; // ambiguous, skip
    }

    this.buffer.push({
      sessionId: state.sessionId,
      features: extractModelSizeFeatures(state),
      label,
      source: 'outcome',
      confidence: successScore,
    });
  }

  flush(): void {
    if (this.buffer.length === 0) return;

    const dir = path.dirname(this.csvPath);
    fs.mkdirSync(dir, { recursive: true });

    const lines = this.buffer.map((s) => {
      const values = FEATURE_COLUMNS.map((col) => String(s.features[col]));
      values.push(String(labelIndex(s.label)));
      return values.join(',');
    });

    const needsHeader = !fs.existsSync(this.csvPath);
    if (needsHeader) {
      fs.writeFileSync(this.csvPath, [...FEATURE_COLUMNS, 'label'].join(',') + '\n', 'utf8');
    }

    fs.appendFileSync(this.csvPath, lines.join('\n') + '\n', 'utf8');
    this.buffer = [];
  }

  pendingCount(): number {
    return this.buffer.length;
  }
}

function labelIndex(label: ModelSizeLabel): number {
  return { mini: 0, medium: 1, large: 2 }[label];
}

function bumpModel(model: ModelSizeLabel): ModelSizeLabel {
  if (model === 'mini') return 'medium';
  if (model === 'medium') return 'large';
  return 'large';
}
