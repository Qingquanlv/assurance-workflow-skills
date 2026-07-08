// src/eval/gate.ts — Evaluate thresholds and hard gates → EvalGateResult
// CONSTRAINT: Must NOT import anything from src/eval/scorers/*

import * as fs from 'fs';
import * as path from 'path';
import type { EvalGateResult, EvalVerdict, EvalSuite, SuiteMetrics } from './types';
import { EvalGateResultSchema } from './schemas';
import { readMetrics } from './metrics';
import { readManifest } from './manifest';

const MAX_INCONCLUSIVE_RATE = 0.20; // 20% inconclusive → verdict: inconclusive

// ── Threshold expression parser ───────────────────────────────────────────────

export function evaluateThreshold(
  expr: string,
  value: number | undefined
): boolean {
  if (value === undefined || isNaN(value)) return false;

  const match = expr.trim().match(/^(>=|<=|>|<|==|!=)\s*([\d.]+)$/);
  if (!match) {
    throw new Error(`Invalid threshold expression: '${expr}'`);
  }

  const op = match[1];
  const threshold = parseFloat(match[2]);

  switch (op) {
    case '>=': return value >= threshold;
    case '<=': return value <= threshold;
    case '>':  return value > threshold;
    case '<':  return value < threshold;
    case '==': return Math.abs(value - threshold) < 1e-9;
    case '!=': return Math.abs(value - threshold) >= 1e-9;
    default:   throw new Error(`Unknown operator: ${op}`);
  }
}

// ── Gate logic ────────────────────────────────────────────────────────────────

export function computeGateResult(
  suite: EvalSuite,
  metrics: SuiteMetrics,
  runId: string,
  runDir: string
): EvalGateResult {
  const hardGateFailures: string[] = [];
  const thresholdFailures: string[] = [];

  // Check evidence integrity
  const manifest = readManifest(runDir);
  if (manifest.run_id !== path.basename(runDir)) {
    hardGateFailures.push('evidence_integrity');
  }
  if (manifest.executed_samples !== manifest.total_samples) {
    hardGateFailures.push('evidence_integrity');
  }
  if (metrics.run_id !== manifest.run_id) {
    hardGateFailures.push('evidence_integrity');
  }
  if (metrics.sample_count !== manifest.selected_sample_ids.length) {
    hardGateFailures.push('evidence_integrity');
  }

  // Check hard gates and thresholds
  for (const [metric, expr] of Object.entries(suite.thresholds)) {
    const value = metrics.metrics[metric];
    const passes = evaluateThreshold(expr, value);
    if (!passes) {
      if (suite.hard_gates.includes(metric)) {
        hardGateFailures.push(metric);
      } else {
        thresholdFailures.push(metric);
      }
    }
  }

  // Fail-closed: any sample execution error → suite fail
  if (metrics.error_count > 0) {
    hardGateFailures.push('sample_execution_error');
  }

  // Check hard gates that aren't thresholds (e.g. evidence_integrity, special metrics)
  for (const gate of suite.hard_gates) {
    if (gate === 'evidence_integrity') continue; // already checked above
    if (suite.thresholds[gate]) continue; // already checked via thresholds loop
    // For non-threshold hard gates: check if metric value === 0 (count metrics)
    const value = metrics.metrics[gate];
    if (value !== undefined && value !== 0) {
      hardGateFailures.push(gate);
    }
  }

  // Determine verdict
  let verdict: EvalVerdict;
  const inconclusiveRate =
    metrics.sample_count > 0
      ? metrics.inconclusive_count / metrics.sample_count
      : 0;

  if (hardGateFailures.length > 0) {
    verdict = 'fail';
  } else if (inconclusiveRate > MAX_INCONCLUSIVE_RATE) {
    verdict = 'inconclusive';
  } else if (thresholdFailures.length > 0) {
    verdict = 'pass_with_warnings';
  } else {
    verdict = 'pass';
  }

  const result: EvalGateResult = {
    run_id: runId,
    suite: suite.name,
    verdict,
    hard_gate_failures: hardGateFailures,
    threshold_failures: thresholdFailures,
    inconclusive_count: metrics.inconclusive_count,
  };

  const parsed = EvalGateResultSchema.safeParse(result);
  if (!parsed.success) {
    throw new Error(`EvalGateResult schema validation failed: ${parsed.error.message}`);
  }

  fs.writeFileSync(
    path.join(runDir, 'gate-result.json'),
    JSON.stringify(result, null, 2)
  );

  return result;
}

export function readGateResult(runDir: string): EvalGateResult {
  const gatePath = path.join(runDir, 'gate-result.json');
  if (!fs.existsSync(gatePath)) {
    throw new Error(`gate-result.json not found in ${runDir}`);
  }
  const raw = JSON.parse(fs.readFileSync(gatePath, 'utf-8'));
  const result = EvalGateResultSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`gate-result.json schema invalid: ${result.error.message}`);
  }
  return result.data as EvalGateResult;
}
