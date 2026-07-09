// Unified Plugin Registry: rules, metric providers, predictors all live here.

import type { MetricProvider, Plugin, Predictor, RuntimeRule } from '../runtime/types.js';

export class PluginRegistry {
  private plugins = new Map<string, Plugin>();
  private rules: RuntimeRule[] = [];
  private metricProviders: MetricProvider[] = [];
  private predictors: Predictor[] = [];

  register(plugin: Plugin): () => void {
    if (this.plugins.has(plugin.id)) {
      throw new Error(`Plugin already registered: ${plugin.id}`);
    }
    this.plugins.set(plugin.id, plugin);

    if (plugin.rules) this.rules.push(...plugin.rules);
    if (plugin.metricProviders) this.metricProviders.push(...plugin.metricProviders);
    if (plugin.predictors) this.predictors.push(...plugin.predictors);

    return () => this.unregister(plugin.id);
  }

  unregister(pluginId: string): void {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return;

    if (plugin.rules) {
      const ids = new Set(plugin.rules.map((r) => r.id));
      this.rules = this.rules.filter((r) => !ids.has(r.id));
    }
    if (plugin.metricProviders) {
      const ids = new Set(plugin.metricProviders.map((m) => m.id));
      this.metricProviders = this.metricProviders.filter((m) => !ids.has(m.id));
    }
    if (plugin.predictors) {
      const ids = new Set(plugin.predictors.map((p) => p.id));
      this.predictors = this.predictors.filter((p) => !ids.has(p.id));
    }

    this.plugins.delete(pluginId);
  }

  getRules(): RuntimeRule[] {
    return [...this.rules];
  }

  getMetricProviders(): MetricProvider[] {
    return [...this.metricProviders];
  }

  getPredictors(): Predictor[] {
    return [...this.predictors];
  }

  list(): Plugin[] {
    return Array.from(this.plugins.values());
  }
}
