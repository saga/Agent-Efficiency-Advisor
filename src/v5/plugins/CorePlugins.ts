// Bundles the built-in plugins (rules, metrics, predictors) so the V5 CLI
// can register them in one shot.

import type { Plugin } from '../runtime/types.js';
import { CoreRulesPlugin } from './rules/index.js';
import { CoreMetricProviders } from './metrics/index.js';
import { RulePredictor, HeuristicPredictor } from './predictors/index.js';

export const CoreMetricsPlugin: Plugin = {
  id: 'core-metrics',
  name: 'Core Metrics',
  metricProviders: CoreMetricProviders,
};

export const CorePredictorsPlugin: Plugin = {
  id: 'core-predictors',
  name: 'Core Predictors',
  predictors: [new RulePredictor(), new HeuristicPredictor()],
};

export function corePlugins(): Plugin[] {
  return [CoreRulesPlugin, CoreMetricsPlugin, CorePredictorsPlugin];
}
