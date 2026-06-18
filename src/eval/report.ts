// src/eval/report.ts — Generate per-run reports and trend data

import * as fs from 'fs';
import * as path from 'path';
import type { EvalGateResult, EvalVerdict, SuiteMetrics } from './types';
import { readGateResult } from './gate';
import { readMetrics } from './metrics';
import { readManifest } from './manifest';

const VERDICT_EMOJI: Record<EvalVerdict, string> = {
  pass: '✅',
  pass_with_warnings: '⚠️',
  fail: '❌',
  inconclusive: '❓',
  needs_human_review: '👤',
};

export function generateRunReport(runDir: string): string {
  const manifest = readManifest(runDir);
  const metrics = readMetrics(runDir);
  const gateResult = readGateResult(runDir);

  const lines: string[] = [
    `# Eval Run Report`,
    ``,
    `**Run ID:** ${manifest.run_id}`,
    `**Suite:** ${manifest.suite} v${manifest.suite_version}`,
    `**Git SHA:** ${manifest.git_sha}`,
    `**Started:** ${manifest.started_at}`,
    `**Completed:** ${manifest.completed_at ?? 'in progress'}`,
    ``,
    `## Verdict: ${VERDICT_EMOJI[gateResult.verdict]} ${gateResult.verdict.toUpperCase()}`,
    ``,
    `## Metrics`,
    ``,
    `| Metric | Value |`,
    `|---|---|`,
  ];

  for (const [k, v] of Object.entries(metrics.metrics)) {
    lines.push(`| ${k} | ${typeof v === 'number' ? v.toFixed(4) : v} |`);
  }

  lines.push(``);
  lines.push(`**Samples:** ${metrics.sample_count} total, ${metrics.inconclusive_count} inconclusive, ${metrics.error_count} errors`);

  if (gateResult.hard_gate_failures.length > 0) {
    lines.push(``, `## Hard Gate Failures`, ``);
    for (const f of gateResult.hard_gate_failures) {
      lines.push(`- ❌ ${f}`);
    }
  }

  if (gateResult.threshold_failures.length > 0) {
    lines.push(``, `## Threshold Failures (warnings)`, ``);
    for (const f of gateResult.threshold_failures) {
      lines.push(`- ⚠️ ${f}`);
    }
  }

  lines.push(``);
  lines.push(`## Environment`);
  lines.push(``);
  lines.push(`- Node: ${manifest.environment.node}`);
  if (manifest.environment.python) lines.push(`- Python: ${manifest.environment.python}`);
  if (manifest.environment.pytest) lines.push(`- pytest: ${manifest.environment.pytest}`);

  const report = lines.join('\n');

  const reportObj = {
    run_id: manifest.run_id,
    suite: manifest.suite,
    verdict: gateResult.verdict,
    metrics: metrics.metrics,
    hard_gate_failures: gateResult.hard_gate_failures,
    threshold_failures: gateResult.threshold_failures,
    sample_count: metrics.sample_count,
    generated_at: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(reportObj, null, 2));
  fs.writeFileSync(path.join(runDir, 'report.md'), report);

  return report;
}

export interface TrendEntry {
  run_id: string;
  suite: string;
  verdict: EvalVerdict;
  metrics: Record<string, number>;
  started_at: string;
  git_sha: string;
}

export function generateTrendReport(runsDir: string, suite?: string): TrendEntry[] {
  if (!fs.existsSync(runsDir)) return [];

  const runDirs = fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(runsDir, e.name));

  const trend: TrendEntry[] = [];

  for (const runDir of runDirs) {
    const manifestPath = path.join(runDir, 'manifest.json');
    const gatePath = path.join(runDir, 'gate-result.json');
    const metricsPath = path.join(runDir, 'metrics.json');

    if (!fs.existsSync(manifestPath) || !fs.existsSync(gatePath) || !fs.existsSync(metricsPath)) {
      continue;
    }

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const gateResult = JSON.parse(fs.readFileSync(gatePath, 'utf-8')) as EvalGateResult;
      const metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf-8')) as SuiteMetrics;

      if (suite && manifest.suite !== suite) continue;

      trend.push({
        run_id: manifest.run_id,
        suite: manifest.suite,
        verdict: gateResult.verdict,
        metrics: metrics.metrics,
        started_at: manifest.started_at,
        git_sha: manifest.git_sha,
      });
    } catch {
      // Skip malformed runs
    }
  }

  // Sort by started_at
  trend.sort((a, b) => a.started_at.localeCompare(b.started_at));
  return trend;
}

export function compareWithBaseline(
  runDir: string,
  baselineMetrics: Record<string, number>
): Record<string, number> {
  const metrics = readMetrics(runDir);
  const delta: Record<string, number> = {};

  for (const [k, v] of Object.entries(metrics.metrics)) {
    const baseline = baselineMetrics[k];
    if (baseline !== undefined) {
      delta[k] = v - baseline;
    }
  }

  return delta;
}
