import type { SessionState } from '../../types.js';

export interface ShadowResult {
  originalModel: string;
  shadowModel: string;
  originalSuccess: boolean;
  shadowSuccess: boolean;
  label: 'mini' | 'medium' | 'large';
  confidence: number;
}

export interface ShadowTaskRunner {
  run(state: SessionState, recommendedModel: string): Promise<ShadowResult>;
}

export interface ShadowRunnerOptions {
  sampleRate: number;
  shadowModel: string;
  runner: ShadowTaskRunner;
}

export class ShadowRunner {
  private total = 0;
  private sampled = 0;

  constructor(private options: ShadowRunnerOptions) {}

  shouldSample(): boolean {
    this.total++;
    if (Math.random() < this.options.sampleRate) {
      this.sampled++;
      return true;
    }
    return false;
  }

  async evaluate(state: SessionState, recommendedModel: string): Promise<ShadowResult | undefined> {
    if (!this.shouldSample()) return undefined;
    return this.options.runner.run(state, recommendedModel);
  }

  stats(): { total: number; sampled: number; rate: number } {
    return {
      total: this.total,
      sampled: this.sampled,
      rate: this.total > 0 ? this.sampled / this.total : 0,
    };
  }
}

export class MockShadowTaskRunner implements ShadowTaskRunner {
  async run(state: SessionState, recommendedModel: string): Promise<ShadowResult> {
    // Simulate outcomes based on task characteristics.
    const isSimple =
      state.promptTokens < 8000 &&
      state.toolCalls <= 5 &&
      state.filesEdited.size <= 2 &&
      state.retries === 0;

    const originalSuccess = true;
    const shadowSuccess = isSimple || Math.random() > 0.3;

    // If shadow succeeds, the recommended smaller model is sufficient.
    const label: ShadowResult['label'] = shadowSuccess
      ? (recommendedModel as ShadowResult['label'])
      : bumpModel(recommendedModel);

    return {
      originalModel: state.sessionId,
      shadowModel: this.options.shadowModel,
      originalSuccess,
      shadowSuccess,
      label,
      confidence: shadowSuccess ? 0.95 : 0.6,
    };
  }

  constructor(private options: { shadowModel: string }) {}
}

function bumpModel(model: string): 'mini' | 'medium' | 'large' {
  if (model === 'mini') return 'medium';
  if (model === 'medium') return 'large';
  return 'large';
}
