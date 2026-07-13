import * as fs from 'fs';
import * as path from 'path';
import type { EvalTrendSignal } from './types';
import { evalRunsDir } from '../eval/paths';

interface MetricsFile {
  suite?: string;
  run_id?: string;
  generated_at?: string;
  metrics?: Record<string, number>;
}

interface BaselineEntry {
  run_id?: string;
  metrics?: Record<string, number>;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return Number(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(4));
}

function readJson<T>(file: string): T | null {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

export function readEvalTrend(projectRoot: string, since?: string): EvalTrendSignal[] {
  const runsRoot = evalRunsDir(path.join(projectRoot, 'eval'));
  const baseline = readJson<Record<string, BaselineEntry>>(
    path.join(projectRoot, 'eval', 'baselines', 'main.json'),
  ) ?? {};
  if (!fs.existsSync(runsRoot)) return [];

  const sinceMs = since ? Date.parse(since) : Number.NEGATIVE_INFINITY;
  const runs = fs
    .readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const file = path.join(runsRoot, entry.name, 'metrics.json');
      const parsed = readJson<MetricsFile>(file);
      if (!parsed?.suite || !parsed.metrics) return [];
      const generatedAt = parsed.generated_at ? Date.parse(parsed.generated_at) : 0;
      if (!Number.isNaN(sinceMs) && generatedAt < sinceMs) return [];
      return [{ ...parsed, generatedAt }];
    })
    .sort((a, b) => a.generatedAt - b.generatedAt);

  const bySuiteMetric = new Map<string, number[]>();
  for (const run of runs) {
    for (const [metric, value] of Object.entries(run.metrics ?? {})) {
      if (typeof value !== 'number') continue;
      const key = `${run.suite}\0${metric}`;
      const arr = bySuiteMetric.get(key) ?? [];
      arr.push(value);
      bySuiteMetric.set(key, arr.slice(-5));
    }
  }

  return [...bySuiteMetric.entries()]
    .flatMap(([key, values]) => {
      const [suite, metric] = key.split('\0');
      const baselineValue = baseline[suite]?.metrics?.[metric];
      if (typeof baselineValue !== 'number') return [];
      const recent = median(values);
      return [{
        suite,
        metric,
        recent,
        baseline: baselineValue,
        delta: Number((recent - baselineValue).toFixed(4)),
      }];
    })
    .sort((a, b) => a.suite.localeCompare(b.suite) || a.metric.localeCompare(b.metric));
}
