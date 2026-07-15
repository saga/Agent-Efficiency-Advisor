// EmbeddingProvider — v7.md #3: Plugin 化接口。
// 以后 feature-v1 / text-embedding-3-small / nomic / bge-m3 全部不用修改 Pipeline。
//
//   interface EmbeddingProvider {
//     id: string;
//     generate(entity): Float32Array;
//   }
//
// 实践中拆分为 generateSession / generatePrompt 两个方法，因为两者的
// 特征空间不同（session 用 behavior+session 特征，prompt 用 context 特征）。

export interface EmbeddingProvider {
  /** 唯一标识，作为 embedding 表的 model 字段。 */
  id: string;
  /** 该 Provider 能处理的 Entity 类型。 */
  supportedEntities: ReadonlyArray<'session' | 'prompt' | 'workspace'>;
  /** 从 session 特征生成归一化向量。 */
  generateSession(features: Record<string, number>): Float32Array;
  /** 从 prompt 特征生成归一化向量。 */
  generatePrompt(features: Record<string, number>): Float32Array;
}
