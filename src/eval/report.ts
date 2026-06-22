// src/eval/report.ts — Generate per-run reports and trend data

import * as fs from 'fs';
import * as path from 'path';
import type { EvalGateResult, EvalVerdict, SuiteMetrics } from './types';
import { readGateResult } from './gate';
import { readMetrics } from './metrics';
import { readManifest } from './manifest';
import {
  collectRunExecutionStats,
  formatDurationMs,
  isWithinTimeRange,
  parseIsoDateTime,
  type RunExecutionStats,
} from './execution_stats';
import { formatTokenUsage, type TokenUsage } from './token_usage';
import { renderRunReportHtml, renderTrendReportHtml } from './report_html';

const VERDICT_EMOJI: Record<EvalVerdict, string> = {
  pass: '✅',
  pass_with_warnings: '⚠️',
  fail: '❌',
  inconclusive: '❓',
  needs_human_review: '👤',
};

export interface RunReportData {
  run_id: string;
  suite: string;
  suite_version: string;
  git_sha: string;
  verdict: EvalVerdict;
  metrics: Record<string, number>;
  hard_gate_failures: string[];
  threshold_failures: string[];
  sample_count: number;
  inconclusive_count: number;
  error_count: number;
  execution: RunExecutionStats;
  environment: {
    node: string;
    python: string | null;
    pytest: string | null;
    playwright: string | null;
  };
  generated_at: string;
}

export interface RunReportOptions {
  html?: boolean;
  htmlPath?: string;
}

export interface RunReportResult {
  markdown: string;
  data: RunReportData;
  htmlPath?: string;
}

function executionMarkdownSection(execution: RunExecutionStats): string[] {
  const lines = [
    `## Execution`,
    ``,
    `| Field | Value |`,
    `|---|---|`,
    `| Started | ${execution.started_at} |`,
    `| Completed | ${execution.completed_at ?? 'in progress'} |`,
    `| Duration | ${formatDurationMs(execution.duration_ms)} |`,
    `| Token usage | ${formatTokenUsage(execution.tokens)} |`,
    ``,
  ];

  if (execution.per_sample.length > 0) {
    lines.push(`### Per-Sample Execution`, ``);
    lines.push(
      `| Sample | Attempt | Started | Completed | Duration | Tokens |`,
      `|---|---|---|---|---|---|`
    );

    for (const row of execution.per_sample) {
      lines.push(
        `| ${row.sample_id} | ${row.attempt} | ${row.started_at ?? '—'} | ${row.completed_at ?? '—'} | ${formatDurationMs(row.duration_ms)} | ${formatTokenUsage(row.tokens)} |`
      );
    }
    lines.push(``);
  }

  return lines;
}

export function generateRunReport(runDir: string, opts: RunReportOptions = {}): RunReportResult {
  const manifest = readManifest(runDir);
  const metrics = readMetrics(runDir);
  const gateResult = readGateResult(runDir);
  const execution = collectRunExecutionStats(runDir, manifest);
  const generatedAt = new Date().toISOString();

  const lines: string[] = [
    `# Eval Run Report`,
    ``,
    `**Run ID:** ${manifest.run_id}`,
    `**Suite:** ${manifest.suite} v${manifest.suite_version}`,
    `**Git SHA:** ${manifest.git_sha}`,
    ``,
    ...executionMarkdownSection(execution),
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
  lines.push(
    `**Samples:** ${metrics.sample_count} total, ${metrics.inconclusive_count} inconclusive, ${metrics.error_count} errors`
  );

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

  const reportObj: RunReportData = {
    run_id: manifest.run_id,
    suite: manifest.suite,
    suite_version: manifest.suite_version,
    git_sha: manifest.git_sha,
    verdict: gateResult.verdict,
    metrics: metrics.metrics,
    hard_gate_failures: gateResult.hard_gate_failures,
    threshold_failures: gateResult.threshold_failures,
    sample_count: metrics.sample_count,
    inconclusive_count: metrics.inconclusive_count,
    error_count: metrics.error_count,
    execution,
    environment: manifest.environment,
    generated_at: generatedAt,
  };

  fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(reportObj, null, 2));
  fs.writeFileSync(path.join(runDir, 'report.md'), report);

  let htmlPath: string | undefined;
  if (opts.html) {
    htmlPath = opts.htmlPath ?? path.join(runDir, 'report.html');
    fs.writeFileSync(
      htmlPath,
      renderRunReportHtml({
        title: 'Eval Run Report',
        runId: manifest.run_id,
        suite: manifest.suite,
        suiteVersion: manifest.suite_version,
        gitSha: manifest.git_sha,
        gateResult,
        metrics: metrics.metrics,
        sampleCount: metrics.sample_count,
        inconclusiveCount: metrics.inconclusive_count,
        errorCount: metrics.error_count,
        execution,
        environment: manifest.environment,
        generatedAt,
      })
    );
  }

  return { markdown: report, data: reportObj, htmlPath };
}

export interface TrendEntry {
  run_id: string;
  suite: string;
  verdict: EvalVerdict;
  metrics: Record<string, number>;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  git_sha: string;
  tokens: TokenUsage | null;
}

export interface TrendReportOptions {
  suite?: string;
  from?: string;
  to?: string;
  html?: boolean;
  htmlPath?: string;
  evalRoot?: string;
}

export interface TrendReportResult {
  entries: TrendEntry[];
  htmlPath?: string;
}

export function generateTrendReport(
  runsDir: string,
  opts: TrendReportOptions = {}
): TrendReportResult {
  if (!fs.existsSync(runsDir)) return { entries: [] };

  const from = opts.from ? parseIsoDateTime(opts.from, '--from') : undefined;
  const to = opts.to ? parseIsoDateTime(opts.to, '--to') : undefined;

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
      const manifest = readManifest(runDir);
      const gateResult = JSON.parse(fs.readFileSync(gatePath, 'utf-8')) as EvalGateResult;
      const metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf-8')) as SuiteMetrics;

      if (opts.suite && manifest.suite !== opts.suite) continue;
      if (!isWithinTimeRange(manifest.started_at, from, to)) continue;

      const execution = collectRunExecutionStats(runDir, manifest);

      trend.push({
        run_id: manifest.run_id,
        suite: manifest.suite,
        verdict: gateResult.verdict,
        metrics: metrics.metrics,
        started_at: manifest.started_at,
        completed_at: manifest.completed_at ?? null,
        duration_ms: execution.duration_ms,
        git_sha: manifest.git_sha,
        tokens: execution.tokens,
      });
    } catch {
      // Skip malformed runs
    }
  }

  trend.sort((a, b) => a.started_at.localeCompare(b.started_at));

  let htmlPath: string | undefined;
  if (opts.html) {
    const evalRoot = opts.evalRoot ?? path.dirname(runsDir);
    const reportsDir = path.join(evalRoot, 'reports');
    fs.mkdirSync(reportsDir, { recursive: true });

    const suiteSlug = opts.suite ?? 'all';
    htmlPath =
      opts.htmlPath ??
      path.join(reportsDir, `trend-${suiteSlug}.html`);

    fs.writeFileSync(
      htmlPath,
      renderTrendReportHtml({
        suiteLabel: opts.suite ?? 'all suites',
        from,
        to,
        entries: trend,
        generatedAt: new Date().toISOString(),
      })
    );
  }

  return { entries: trend, htmlPath };
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
