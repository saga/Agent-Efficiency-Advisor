// Tests for ModelsMetadataParser

import { describe, it, expect } from 'vitest';
import { ModelsMetadataParser } from '../src/realtime/parsers/ModelsMetadataParser.js';
import type { ModelEntry } from '../src/realtime/parsers/types.js';

const SAMPLE_MODELS: ModelEntry[] = [
  {
    id: 'gpt-5-mini',
    name: 'GPT-5 mini',
    vendor: 'Azure OpenAI',
    model_picker_category: 'lightweight',
    model_picker_price_category: 'low',
    is_chat_fallback: true,
    capabilities: { family: 'gpt-5-mini', limits: { max_context_window_tokens: 264000 } },
    billing: {
      token_prices: {
        batch_size: 1_000_000,
        default: { input_price: 25, output_price: 200, cache_price: 2 },
      },
    },
  },
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    vendor: 'OpenAI',
    model_picker_category: 'powerful',
    model_picker_price_category: 'medium',
    capabilities: { family: 'gpt-5.4', limits: { max_context_window_tokens: 1050000 } },
    billing: {
      token_prices: {
        batch_size: 1_000_000,
        default: { input_price: 250, output_price: 1500 },
      },
    },
  },
];

describe('ModelsMetadataParser', () => {
  const parser = new ModelsMetadataParser();

  it('builds id and family indexes', () => {
    const meta = parser.parseString(JSON.stringify(SAMPLE_MODELS));
    expect(meta.models).toHaveLength(2);
    expect(meta.byId.has('gpt-5-mini')).toBe(true);
    expect(meta.byFamily.has('gpt-5-mini')).toBe(true);
    expect(meta.byFamily.get('gpt-5.4')).toHaveLength(1);
  });

  it('looks up by exact id', () => {
    const meta = parser.parseString(JSON.stringify(SAMPLE_MODELS));
    const entry = parser.lookup(meta, 'gpt-5-mini');
    expect(entry?.name).toBe('GPT-5 mini');
  });

  it('looks up by prefix match', () => {
    const meta = parser.parseString(JSON.stringify(SAMPLE_MODELS));
    const entry = parser.lookup(meta, 'gpt-5');
    expect(entry).toBeDefined();
  });

  it('looks up by family substring', () => {
    const meta = parser.parseString(JSON.stringify(SAMPLE_MODELS));
    const entry = parser.lookup(meta, 'some-prefix-gpt-5.4-suffix');
    expect(entry?.id).toBe('gpt-5.4');
  });

  it('estimates cost correctly', () => {
    const meta = parser.parseString(JSON.stringify(SAMPLE_MODELS));
    // gpt-5-mini: input=$25/M, output=$200/M
    // 1000 input + 500 output = 1000*25/1M + 500*200/1M = 0.025 + 0.1 = 0.125
    const cost = parser.estimateCostUsd(meta, 'gpt-5-mini', 1000, 500);
    expect(cost).toBeCloseTo(0.125, 5);
  });

  it('deducts cached tokens from input cost', () => {
    const meta = parser.parseString(JSON.stringify(SAMPLE_MODELS));
    // gpt-5-mini: input=$25/M, cache=$2/M
    // 1000 input (500 cached) + 500 output
    // = 500*25/1M + 500*2/1M + 500*200/1M = 0.0125 + 0.001 + 0.1 = 0.1135
    const cost = parser.estimateCostUsd(meta, 'gpt-5-mini', 1000, 500, 500);
    expect(cost).toBeCloseTo(0.1135, 5);
  });

  it('returns 0 cost for unknown model', () => {
    const meta = parser.parseString(JSON.stringify(SAMPLE_MODELS));
    const cost = parser.estimateCostUsd(meta, 'unknown-model', 1000, 500);
    expect(cost).toBe(0);
  });

  it('identifies lightweight models', () => {
    const meta = parser.parseString(JSON.stringify(SAMPLE_MODELS));
    expect(parser.isLightweight(meta, 'gpt-5-mini')).toBe(true);
    expect(parser.isLightweight(meta, 'gpt-5.4')).toBe(false);
  });
});
