// Aggregates all registered MetricProviders into a name→value map.

import type { MetricProvider, RuntimeSnapshot } from '../../runtime/types.js';

export interface MetricSnapshot {
  values: Record<string, number>;
  descriptions: Record<string, string | undefined>;
}

export class MetricsPipeline {
  constructor(private providers: MetricProvider[]) {}

  compute(snapshot: RuntimeSnapshot): MetricSnapshot {
    const values: Record<string, number> = {};
    const descriptions: Record<string, string | undefined> = {};

    for (const provider of this.providers) {
      try {
        values[provider.id] = provider.compute(snapshot);
        descriptions[provider.id] = provider.description;
      } catch (err) {
        values[provider.id] = NaN;
        descriptions[provider.id] = `error: ${(err as Error).message}`;
      }
    }

    return { values, descriptions };
  }
}
