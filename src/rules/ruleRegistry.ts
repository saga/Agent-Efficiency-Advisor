import type { Rule } from '../types.js';
import { ContextTooLargeRule } from './ContextTooLargeRule.js';
import { ReadFileStormRule } from './ReadFileStormRule.js';
import { ToolLoopRule } from './ToolLoopRule.js';
import { RetryRule } from './RetryRule.js';
import { PromptExplosionRule } from './PromptExplosionRule.js';
import { LargeDiffRule } from './LargeDiffRule.js';
import { ModelSwitchRule } from './ModelSwitchRule.js';

export function defaultRules(): Rule[] {
  return [
    new ContextTooLargeRule(),
    new ReadFileStormRule(),
    new ToolLoopRule(),
    new RetryRule(),
    new PromptExplosionRule(),
    new LargeDiffRule(),
    new ModelSwitchRule(),
  ];
}
