// src/eval/metrics.ts — Aggregate sample scores into suite-level metrics

import * as fs from 'fs';
import * as path from 'path';
import type { SampleScore, SuiteMetrics } from './types';
import { SuiteMetricsSchema } from './schemas';

export function aggregateScores(
  runDir: string,
  suiteName: string,
  runId: string
): SuiteMetrics {
  const samplesDir = path.join(runDir, 'samples');
  if (!fs.existsSync(samplesDir)) {
    throw new Error(`samples/ directory not found in run: ${runDir}`);
  }

  const sampleDirs = fs
    .readdirSync(samplesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  const allScores: SampleScore[] = [];

  for (const sampleId of sampleDirs) {
    const sampleDir = path.join(samplesDir, sampleId);
    // Take the last attempt's score.json (or attempt-0 for non-stability)
    const attemptDirs = fs
      .readdirSync(sampleDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('attempt-'))
      .map((e) => e.name)
      .sort();

    if (attemptDirs.length === 0) {
      allScores.push({
        sample_id: sampleId,
        status: 'error',
        metrics: {},
        error: 'No attempt directories found',
      });
      continue;
    }

    // For stability: aggregate across attempts; for others, take last attempt
    if (attemptDirs.length === 1) {
      const scoreFile = path.join(sampleDir, attemptDirs[0], 'score.json');
      allScores.push(readSampleScore(sampleId, scoreFile));
    } else {
      // Multiple attempts (stability): collect all scores and aggregate
      const attemptScores: SampleScore[] = [];
      for (const attemptDir of attemptDirs) {
        const scoreFile = path.join(sampleDir, attemptDir, 'score.json');
        attemptScores.push(readSampleScore(sampleId, scoreFile));
      }
      allScores.push(aggregateStabilityScores(attemptScores));
    }
  }

  return buildSuiteMetrics(allScores, suiteName, runId, runDir);
}

function readSampleScore(sampleId: string, scoreFile: string): SampleScore {
  if (!fs.existsSync(scoreFile)) {
    return {
      sample_id: sampleId,
      status: 'error',
      metrics: {},
      error: `score.json not found: ${scoreFile}`,
    };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(scoreFile, 'utf-8')) as SampleScore;
    if (!raw.sample_id) raw.sample_id = sampleId;
    return raw;
  } catch (err) {
    return {
      sample_id: sampleId,
      status: 'error',
      metrics: {},
      error: `Failed to parse score.json: ${(err as Error).message}`,
    };
  }
}

function aggregateStabilityScores(scores: SampleScore[]): SampleScore {
  const sampleId = scores[0].sample_id;
  const okScores = scores.filter((s) => s.status === 'ok');

  if (okScores.length === 0) {
    return {
      sample_id: sampleId,
      status: 'error',
      metrics: {},
      error: 'All attempts failed',
    };
  }

  // Collect all metric keys
  const metricKeys = new Set<string>();
  for (const s of okScores) {
    for (const k of Object.keys(s.metrics)) metricKeys.add(k);
  }

  const aggregated: Record<string, number> = {};
  for (const key of metricKeys) {
    const values = okScores
      .map((s) => s.metrics[key])
      .filter((v): v is number => typeof v === 'number');
    if (values.length === 0) continue;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    aggregated[key] = mean;
    // Also store worst-case and std for stability metrics
    aggregated[`${key}_min`] = Math.min(...values);
    aggregated[`${key}_max`] = Math.max(...values);
    const variance =
      values.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / values.length;
    aggregated[`${key}_std`] = Math.sqrt(variance);
  }

  return {
    sample_id: sampleId,
    status: okScores.length === scores.length ? 'ok' : 'inconclusive',
    metrics: aggregated,
  };
}

function buildSuiteMetrics(
  allScores: SampleScore[],
  suiteName: string,
  runId: string,
  runDir: string
): SuiteMetrics {
  const inconclusiveCount = allScores.filter((s) => s.status === 'inconclusive').length;
  const errorCount = allScores.filter((s) => s.status === 'error').length;
  const okScores = allScores.filter((s) => s.status === 'ok');

  // Aggregate per-metric means across ok samples
  const metricKeys = new Set<string>();
  for (const s of okScores) {
    for (const k of Object.keys(s.metrics)) {
      if (typeof s.metrics[k] === 'number') metricKeys.add(k);
    }
  }

  const suiteMetrics: Record<string, number> = {};
  for (const key of metricKeys) {
    const values = okScores
      .map((s) => s.metrics[key])
      .filter((v): v is number => typeof v === 'number');
    if (values.length === 0) continue;
    suiteMetrics[key] = values.reduce((a, b) => a + b, 0) / values.length;
  }

  const result: SuiteMetrics = {
    suite: suiteName,
    run_id: runId,
    sample_count: allScores.length,
    inconclusive_count: inconclusiveCount,
    error_count: errorCount,
    metrics: suiteMetrics,
  };

  const parsed = SuiteMetricsSchema.safeParse(result);
  if (!parsed.success) {
    throw new Error(`SuiteMetrics schema validation failed: ${parsed.error.message}`);
  }

  fs.writeFileSync(
    path.join(runDir, 'metrics.json'),
    JSON.stringify(result, null, 2)
  );

  return result;
}

export function readMetrics(runDir: string): SuiteMetrics {
  const metricsPath = path.join(runDir, 'metrics.json');
  if (!fs.existsSync(metricsPath)) {
    throw new Error(`metrics.json not found in ${runDir}`);
  }
  const raw = JSON.parse(fs.readFileSync(metricsPath, 'utf-8'));
  const result = SuiteMetricsSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`metrics.json schema invalid: ${result.error.message}`);
  }
  return result.data as SuiteMetrics;
}
