// TrendAnalysis — time-series trend detection for daily metrics.
// v6.md Section 10: "Prophet / XGBoost / LightGBM / 或者直接 Rolling Window"
//
// Implements a lightweight rolling-window + linear regression approach.
// No external dependencies — sufficient for detecting drift in daily metrics.

import type { IDEEvent } from '../store/types.js';

export interface DailyMetric {
  date: string;       // YYYY-MM-DD
  acceptRate: number;
  retryRate: number;
  avgTokens: number;
  sessionCount: number;
  eventCount: number;
}

export interface TrendResult {
  metric: string;
  slope: number;          // per day (from linear regression)
  direction: 'increasing' | 'decreasing' | 'stable';
  magnitude: number;     // |slope| / mean — relative change per day
  rollingAvg: number;    // latest 7-day rolling average
  values: { date: string; value: number }[];
}

export interface TrendReport {
  dailyMetrics: DailyMetric[];
  trends: TrendResult[];
  summary: {
    daysAnalyzed: number;
    totalSessions: number;
    totalEvents: number;
    healthDirection: 'improving' | 'declining' | 'stable';
  };
}

const MS_PER_DAY = 86_400_000;

export class TrendAnalysis {
  /**
   * Analyze trends from events grouped by day.
   */
  analyze(events: IDEEvent[]): TrendReport {
    const dailyMap = new Map<string, IDEEvent[]>();

    for (const e of events) {
      const date = new Date(e.timestamp).toISOString().slice(0, 10);
      if (!dailyMap.has(date)) dailyMap.set(date, []);
      dailyMap.get(date)!.push(e);
    }

    const dailyMetrics: DailyMetric[] = [];
    const sortedDates = Array.from(dailyMap.keys()).sort();

    for (const date of sortedDates) {
      const dayEvents = dailyMap.get(date)!;
      const sessions = new Set(dayEvents.map((e) => e.sessionId));
      let completions = 0, retries = 0, accepts = 0, rejects = 0, totalTokens = 0;

      for (const e of dayEvents) {
        if (e.eventType === 'completion') completions++;
        if (e.eventType === 'retry') retries++;
        if (e.eventType === 'accept') accepts++;
        if (e.eventType === 'reject') rejects++;
        totalTokens += Number(e.metadata.tokenCount ?? e.metadata.promptTokens ?? 0);
      }

      dailyMetrics.push({
        date,
        acceptRate: accepts + rejects > 0 ? Number((accepts / (accepts + rejects)).toFixed(3)) : 0,
        retryRate: completions > 0 ? Number((retries / completions).toFixed(3)) : 0,
        avgTokens: dayEvents.length > 0 ? Math.round(totalTokens / dayEvents.length) : 0,
        sessionCount: sessions.size,
        eventCount: dayEvents.length,
      });
    }

    // Compute trends for key metrics
    const metrics: { name: string; values: { date: string; value: number }[] }[] = [
      { name: 'acceptRate', values: dailyMetrics.map((d) => ({ date: d.date, value: d.acceptRate })) },
      { name: 'retryRate', values: dailyMetrics.map((d) => ({ date: d.date, value: d.retryRate })) },
      { name: 'avgTokens', values: dailyMetrics.map((d) => ({ date: d.date, value: d.avgTokens })) },
      { name: 'sessionCount', values: dailyMetrics.map((d) => ({ date: d.date, value: d.sessionCount })) },
    ];

    const trends = metrics.map((m) => this.computeTrend(m.name, m.values));

    // Overall health direction: acceptRate increasing = improving, retryRate increasing = declining
    const acceptTrend = trends.find((t) => t.metric === 'acceptRate')!;
    const retryTrend = trends.find((t) => t.metric === 'retryRate')!;
    let healthDirection: 'improving' | 'declining' | 'stable' = 'stable';
    if (acceptTrend.direction === 'increasing' && retryTrend.direction !== 'increasing') healthDirection = 'improving';
    else if (retryTrend.direction === 'increasing' && acceptTrend.direction !== 'increasing') healthDirection = 'declining';

    const totalSessions = dailyMetrics.reduce((s, d) => s + d.sessionCount, 0);
    const totalEvents = dailyMetrics.reduce((s, d) => s + d.eventCount, 0);

    return {
      dailyMetrics,
      trends,
      summary: {
        daysAnalyzed: dailyMetrics.length,
        totalSessions,
        totalEvents,
        healthDirection,
      },
    };
  }

  private computeTrend(metric: string, values: { date: string; value: number }[]): TrendResult {
    if (values.length < 2) {
      return {
        metric,
        slope: 0,
        direction: 'stable',
        magnitude: 0,
        rollingAvg: values[0]?.value ?? 0,
        values,
      };
    }

    // Linear regression: y = slope * x + intercept
    const n = values.length;
    const xs = values.map((_, i) => i);
    const ys = values.map((v) => v.value);
    const sumX = xs.reduce((a, b) => a + b, 0);
    const sumY = ys.reduce((a, b) => a + b, 0);
    const sumXY = xs.reduce((s, x, i) => s + x * ys[i], 0);
    const sumX2 = xs.reduce((s, x) => s + x * x, 0);
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const mean = sumY / n;

    const direction = slope > 0.001 * mean ? 'increasing' : slope < -0.001 * mean ? 'decreasing' : 'stable';
    const magnitude = mean !== 0 ? Number((Math.abs(slope) / mean).toFixed(4)) : 0;

    // Rolling average (last 7 days or all if < 7)
    const windowSize = Math.min(7, values.length);
    const rollingAvg = values.slice(-windowSize).reduce((s, v) => s + v.value, 0) / windowSize;

    return {
      metric,
      slope: Number(slope.toFixed(6)),
      direction,
      magnitude,
      rollingAvg: Number(rollingAvg.toFixed(3)),
      values,
    };
  }
}
