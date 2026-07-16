// ModelsMetadataParser — 解析 debug-logs/{sessionId}/models.json
//
// models.json 是 GitHub Copilot 在每次会话开始时写出的模型权威元数据目录,
// 包含每个模型的 vendor、family、price category、token prices、capabilities。
// 这些元数据让我们能够:
//   1. 用权威数据替代 features.ts 中的模型大小推断
//   2. 精确计算单次会话成本 = input_tokens * input_price + output_tokens * output_price
//   3. 区分用户主动选模型 vs fallback 路由(is_chat_fallback)

import fs from 'node:fs';
import type { ModelEntry, ModelsMetadata } from './types.js';

export class ModelsMetadataParser {
  /**
   * 解析 models.json 文件。
   * @param filePath models.json 的绝对路径
   */
  parseFile(filePath: string): ModelsMetadata {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return this.parseString(raw);
  }

  /**
   * 解析 models.json 字符串内容。
   */
  parseString(raw: string): ModelsMetadata {
    const arr = JSON.parse(raw) as ModelEntry[];
    return this.buildIndex(arr);
  }

  private buildIndex(models: ModelEntry[]): ModelsMetadata {
    const byId = new Map<string, ModelEntry>();
    const byFamily = new Map<string, ModelEntry[]>();

    for (const m of models) {
      byId.set(m.id, m);
      const family = m.capabilities?.family ?? m.family ?? 'unknown';
      const list = byFamily.get(family) ?? [];
      list.push(m);
      byFamily.set(family, list);
    }

    return { models, byId, byFamily };
  }

  /**
   * 根据 model id 查询元数据。
   */
  lookup(metadata: ModelsMetadata, modelId: string): ModelEntry | undefined {
    // 精确匹配
    if (metadata.byId.has(modelId)) return metadata.byId.get(modelId);
    // 前缀匹配:Copilot 在 chatSessions 中可能用 "copilot/auto" 或 family 名
    for (const [id, entry] of metadata.byId) {
      if (id.startsWith(modelId) || modelId.startsWith(id)) return entry;
    }
    // family 匹配
    for (const [family, entries] of metadata.byFamily) {
      if (modelId.includes(family)) return entries[0];
    }
    return undefined;
  }

  /**
   * 计算单次请求的估算成本(美元)。
   * @param inputTokens 输入 token 数
   * @param outputTokens 输出 token 数
   * @param cachedTokens 缓存命中的 token 数
   */
  estimateCostUsd(
    metadata: ModelsMetadata,
    modelId: string,
    inputTokens: number,
    outputTokens: number,
    cachedTokens = 0,
  ): number {
    const entry = this.lookup(metadata, modelId);
    if (!entry?.billing?.token_prices?.default) return 0;
    const prices = entry.billing.token_prices.default;
    const batchSize = entry.billing.token_prices.batch_size ?? 1_000_000;
    const inputPrice = prices.input_price ?? 0;
    const outputPrice = prices.output_price ?? 0;
    const cachePrice = prices.cache_price ?? 0;

    const nonCachedInput = Math.max(0, inputTokens - cachedTokens);
    return (
      (nonCachedInput * inputPrice + outputTokens * outputPrice + cachedTokens * cachePrice) /
      batchSize
    );
  }

  /**
   * 判断模型是否属于轻量级(可用于"是否能降级到 mini"判断)。
   */
  isLightweight(metadata: ModelsMetadata, modelId: string): boolean {
    const entry = this.lookup(metadata, modelId);
    if (!entry) return false;
    return (
      entry.model_picker_category === 'lightweight' ||
      entry.model_picker_price_category === 'low'
    );
  }
}
