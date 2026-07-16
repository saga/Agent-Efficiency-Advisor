// 数据保留策略 — 防止 SQLite 无限增长
//
// 用法:配置环境变量 AEA_RETENTION_DAYS=90(默认 90 天)
// 定期调用各 Store 的 prune() 方法清理旧数据

export const DEFAULT_RETENTION_DAYS = 90;

export function getRetentionDays(): number {
  const env = process.env.AEA_RETENTION_DAYS;
  if (env) {
    const n = Number(env);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_RETENTION_DAYS;
}
