// src/eval/report_html.ts — Self-contained HTML reports for eval runs and trends

import type { EvalGateResult, EvalVerdict } from './types';
import type { RunExecutionStats, SampleExecutionStats } from './execution_stats';
import { formatDurationMs } from './execution_stats';
import { formatTokenUsage, type TokenUsage } from './token_usage';

const VERDICT_CLASS: Record<EvalVerdict, string> = {
  pass: 'verdict-pass',
  pass_with_warnings: 'verdict-warn',
  fail: 'verdict-fail',
  inconclusive: 'verdict-inconclusive',
  needs_human_review: 'verdict-review',
};

const VERDICT_LABEL: Record<EvalVerdict, string> = {
  pass: 'PASS',
  pass_with_warnings: 'PASS WITH WARNINGS',
  fail: 'FAIL',
  inconclusive: 'INCONCLUSIVE',
  needs_human_review: 'NEEDS REVIEW',
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatNum(n: number): string {
  return n.toLocaleString('en-US');
}

function icon(name: string): string {
  const icons: Record<string, string> = {
    calendar: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
    clock: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    timer: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M5 3 2 6"/><path d="m22 6-3-3"/></svg>`,
    id: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="8" cy="12" r="2"/><path d="M14 10h4M14 14h4"/></svg>`,
    layers: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>`,
    code: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
    check: `<svg class="icon icon-lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
    token: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v12M8 10h8M8 14h8"/></svg>`,
    status: `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
  };
  return icons[name] ?? '';
}

function runReportStyles(): string {
  return `
    :root {
      --bg: #f3f4f6;
      --card: #ffffff;
      --text: #111827;
      --muted: #6b7280;
      --border: #e5e7eb;
      --header-bg: #f9fafb;
      --pass: #059669;
      --pass-bg: #ecfdf5;
      --pass-border: #a7f3d0;
      --warn: #d97706;
      --warn-bg: #fffbeb;
      --fail: #dc2626;
      --fail-bg: #fef2f2;
      --inconclusive: #7c3aed;
      --review: #0891b2;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    .page {
      max-width: 1180px;
      margin: 0 auto;
      padding: 32px 28px 48px;
    }
    .icon {
      width: 16px;
      height: 16px;
      flex-shrink: 0;
      color: var(--muted);
    }
    .icon-lg {
      width: 28px;
      height: 28px;
    }
    .page-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 24px;
    }
    .page-title {
      margin: 0;
      font-size: 1.75rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--text);
    }
    .page-subtitle {
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 6px 0 0;
      color: var(--muted);
      font-size: 0.875rem;
    }
    .verdict-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px;
      border-radius: 999px;
      font-size: 0.8125rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      white-space: nowrap;
    }
    .verdict-pill .icon { width: 14px; height: 14px; }
    .verdict-pass {
      background: var(--pass-bg);
      color: var(--pass);
      border: 1px solid var(--pass-border);
    }
    .verdict-pass .icon { color: var(--pass); stroke: var(--pass); }
    .verdict-warn { background: var(--warn-bg); color: var(--warn); border: 1px solid #fcd34d; }
    .verdict-fail { background: var(--fail-bg); color: var(--fail); border: 1px solid #fecaca; }
    .verdict-inconclusive { background: #f5f3ff; color: var(--inconclusive); border: 1px solid #ddd6fe; }
    .verdict-review { background: #ecfeff; color: var(--review); border: 1px solid #a5f3fc; }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 16px;
      margin-bottom: 28px;
    }
    @media (max-width: 960px) {
      .summary-grid { grid-template-columns: repeat(2, 1fr); }
    }
    @media (max-width: 520px) {
      .summary-grid { grid-template-columns: 1fr; }
    }
    .summary-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 18px 20px;
      min-height: 96px;
    }
    .summary-card-label {
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--muted);
      font-size: 0.8125rem;
      font-weight: 500;
      margin-bottom: 10px;
    }
    .summary-card-value {
      font-size: 1rem;
      font-weight: 600;
      color: var(--text);
      word-break: break-all;
      line-height: 1.35;
    }
    .summary-card-value.status-pass {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 1.125rem;
      font-weight: 700;
      color: var(--pass);
    }
    .summary-card-value.status-pass .icon { color: var(--pass); stroke: var(--pass); }
    .summary-status {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 1.0625rem;
      font-weight: 700;
    }
    .summary-status .icon { width: 22px; height: 22px; }
    .summary-status.verdict-pass { color: var(--pass); }
    .summary-status.verdict-pass .icon { color: var(--pass); stroke: var(--pass); }
    .summary-status.verdict-warn { color: var(--warn); }
    .summary-status.verdict-fail { color: var(--fail); }
    .summary-status.verdict-inconclusive { color: var(--inconclusive); }
    .summary-status.verdict-review { color: var(--review); }
    .section-title {
      margin: 0 0 12px;
      font-size: 1.0625rem;
      font-weight: 700;
      color: var(--text);
    }
    .section { margin-bottom: 28px; }
    .execution-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 22px 24px;
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 20px;
    }
    @media (max-width: 900px) {
      .execution-card { grid-template-columns: repeat(2, 1fr); }
    }
    @media (max-width: 520px) {
      .execution-card { grid-template-columns: 1fr; }
    }
    .exec-field-label {
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--muted);
      font-size: 0.8125rem;
      font-weight: 500;
      margin-bottom: 8px;
    }
    .exec-field-value {
      font-size: 0.9375rem;
      font-weight: 600;
      color: var(--text);
      word-break: break-word;
    }
    .token-list {
      margin: 0;
      padding: 0;
      list-style: none;
      font-size: 0.875rem;
      line-height: 1.7;
    }
    .token-list li {
      display: flex;
      justify-content: space-between;
      gap: 12px;
    }
    .token-list .k { color: var(--muted); font-weight: 500; }
    .token-list .v { font-weight: 600; font-variant-numeric: tabular-nums; }
    .table-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      overflow: hidden;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.875rem;
    }
    thead th {
      background: var(--header-bg);
      color: var(--muted);
      font-size: 0.6875rem;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      text-align: left;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
    }
    tbody td {
      padding: 14px 16px;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
      color: var(--text);
    }
    tbody tr:last-child td { border-bottom: none; }
    .num { font-variant-numeric: tabular-nums; }
    td.value-col, th.value-col { text-align: right; }
    .meta-foot {
      margin-top: 10px;
      color: var(--muted);
      font-size: 0.8125rem;
    }
    .failures {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px 20px;
      margin-bottom: 20px;
    }
    .failures h3 {
      margin: 0 0 10px;
      font-size: 0.9375rem;
    }
    .failures ul { margin: 0; padding-left: 20px; color: var(--text); }
    footer {
      margin-top: 36px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
      color: var(--muted);
      font-size: 0.8125rem;
    }
  `;
}

function trendStyles(): string {
  return runReportStyles();
}

function verdictPill(verdict: EvalVerdict): string {
  const cls = VERDICT_CLASS[verdict];
  const label = VERDICT_LABEL[verdict];
  const mark = verdict === 'pass' ? icon('check') : '';
  return `<span class="verdict-pill ${cls}">${mark}${escapeHtml(label)}</span>`;
}

function summaryStatusHtml(verdict: EvalVerdict): string {
  const label = VERDICT_LABEL[verdict];
  const cls = VERDICT_CLASS[verdict];
  return `<div class="summary-card-value summary-status ${cls}">${icon('check')}<span>${escapeHtml(label)}</span></div>`;
}

function tokenBreakdownHtml(usage: TokenUsage | null): string {
  if (!usage || usage.steps === 0) {
    return '<div class="exec-field-value meta-foot">N/A</div>';
  }
  const rows = [
    ['Total', formatNum(usage.total)],
    ['Input', formatNum(usage.input)],
    ['Output', formatNum(usage.output)],
    ['Steps', formatNum(usage.steps)],
    ['Cache Read', formatNum(usage.cache_read)],
    ['Cache Write', formatNum(usage.cache_write)],
  ];
  return `<ul class="token-list">${rows
    .map(([k, v]) => `<li><span class="k">${k}</span><span class="v">${v}</span></li>`)
    .join('')}</ul>`;
}

function tokenCellCompact(usage: TokenUsage | null): string {
  if (!usage || usage.steps === 0) {
    return '<span style="color:var(--muted)">N/A</span>';
  }
  return `<span class="num">${escapeHtml(formatTokenUsage(usage))}</span>`;
}

function sampleRows(rows: SampleExecutionStats[]): string {
  if (rows.length === 0) {
    return '<tr><td colspan="6" style="color:var(--muted)">No sample execution evidence</td></tr>';
  }

  return rows
    .map(
      (row) => `<tr>
        <td>${escapeHtml(row.sample_id)}</td>
        <td class="num">${row.attempt}</td>
        <td>${escapeHtml(row.started_at ?? '—')}</td>
        <td>${escapeHtml(row.completed_at ?? '—')}</td>
        <td class="num">${escapeHtml(formatDurationMs(row.duration_ms))}</td>
        <td>${tokenCellCompact(row.tokens)}</td>
      </tr>`
    )
    .join('\n');
}

export interface RunReportHtmlInput {
  title: string;
  runId: string;
  suite: string;
  suiteVersion: string;
  gitSha: string;
  gateResult: EvalGateResult;
  metrics: Record<string, number>;
  sampleCount: number;
  inconclusiveCount: number;
  errorCount: number;
  execution: RunExecutionStats;
  environment: {
    node: string;
    python: string | null;
    pytest: string | null;
    playwright: string | null;
  };
  generatedAt: string;
}

export function renderRunReportHtml(input: RunReportHtmlInput): string {
  const verdict = input.gateResult.verdict;

  const metricRows = Object.entries(input.metrics)
    .map(
      ([key, value]) =>
        `<tr><td>${escapeHtml(key)}</td><td class="num value-col">${typeof value === 'number' ? value.toFixed(4) : escapeHtml(String(value))}</td></tr>`
    )
    .join('\n');

  const hardFailures =
    input.gateResult.hard_gate_failures.length > 0
      ? `<div class="failures"><h3>Hard Gate Failures</h3><ul>${input.gateResult.hard_gate_failures.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul></div>`
      : '';

  const thresholdFailures =
    input.gateResult.threshold_failures.length > 0
      ? `<div class="failures"><h3>Threshold Failures</h3><ul>${input.gateResult.threshold_failures.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul></div>`
      : '';

  const envLine = [
    `Node ${input.environment.node}`,
    input.environment.python ? `Python ${input.environment.python}` : null,
    input.environment.pytest ? `pytest ${input.environment.pytest}` : null,
    input.environment.playwright ? `Playwright ${input.environment.playwright}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(input.title)}</title>
  <style>${runReportStyles()}</style>
</head>
<body>
  <div class="page">
    <header class="page-header">
      <div>
        <h1 class="page-title">${escapeHtml(input.title)}</h1>
        <p class="page-subtitle">${icon('calendar')} Generated ${escapeHtml(input.generatedAt)}</p>
      </div>
      ${verdictPill(verdict)}
    </header>

    <div class="summary-grid">
      <div class="summary-card">
        <div class="summary-card-label">${icon('status')} Overall Status</div>
        ${summaryStatusHtml(verdict)}
      </div>
      <div class="summary-card">
        <div class="summary-card-label">${icon('id')} Run ID</div>
        <div class="summary-card-value">${escapeHtml(input.runId)}</div>
      </div>
      <div class="summary-card">
        <div class="summary-card-label">${icon('layers')} Suite</div>
        <div class="summary-card-value">${escapeHtml(input.suite)} v${escapeHtml(input.suiteVersion)}</div>
      </div>
      <div class="summary-card">
        <div class="summary-card-label">${icon('code')} Git SHA</div>
        <div class="summary-card-value">${escapeHtml(input.gitSha.slice(0, 12))}</div>
      </div>
    </div>

    <section class="section">
      <h2 class="section-title">Execution</h2>
      <div class="execution-card">
        <div>
          <div class="exec-field-label">${icon('clock')} Started</div>
          <div class="exec-field-value">${escapeHtml(input.execution.started_at)}</div>
        </div>
        <div>
          <div class="exec-field-label">${icon('calendar')} Completed</div>
          <div class="exec-field-value">${escapeHtml(input.execution.completed_at ?? 'in progress')}</div>
        </div>
        <div>
          <div class="exec-field-label">${icon('timer')} Duration</div>
          <div class="exec-field-value">${escapeHtml(formatDurationMs(input.execution.duration_ms))}</div>
        </div>
        <div>
          <div class="exec-field-label">${icon('token')} Token Usage</div>
          ${tokenBreakdownHtml(input.execution.tokens)}
        </div>
      </div>
    </section>

    <section class="section">
      <h2 class="section-title">Per-Sample Execution</h2>
      <div class="table-card">
        <table>
          <thead>
            <tr>
              <th>Sample</th>
              <th>Attempt</th>
              <th>Started</th>
              <th>Completed</th>
              <th>Duration</th>
              <th>Tokens</th>
            </tr>
          </thead>
          <tbody>${sampleRows(input.execution.per_sample)}</tbody>
        </table>
      </div>
    </section>

    <section class="section">
      <h2 class="section-title">Metrics</h2>
      <div class="table-card">
        <table>
          <thead>
            <tr>
              <th>Metric</th>
              <th class="value-col">Value</th>
            </tr>
          </thead>
          <tbody>${metricRows}</tbody>
        </table>
      </div>
      <p class="meta-foot">${input.sampleCount} samples · ${input.inconclusiveCount} inconclusive · ${input.errorCount} errors</p>
    </section>

    ${hardFailures}
    ${thresholdFailures}

    <footer>${escapeHtml(envLine)} · Assurance Workflow Skills · Eval Report</footer>
  </div>
</body>
</html>`;
}

export interface TrendReportHtmlEntry {
  run_id: string;
  suite: string;
  verdict: EvalVerdict;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  git_sha: string;
  tokens: TokenUsage | null;
  metrics: Record<string, number>;
}

export interface TrendReportHtmlInput {
  suiteLabel: string;
  from?: string;
  to?: string;
  entries: TrendReportHtmlEntry[];
  generatedAt: string;
}

function tokenCell(usage: TokenUsage | null): string {
  return tokenCellCompact(usage);
}

export function renderTrendReportHtml(input: TrendReportHtmlInput): string {
  const filterNote = [
    input.from ? `from ${input.from}` : null,
    input.to ? `to ${input.to}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const metricKeys = [...new Set(input.entries.flatMap((e) => Object.keys(e.metrics)))].sort();

  const headerCells = metricKeys
    .map((key) => `<th class="value-col">${escapeHtml(key)}</th>`)
    .join('');

  const bodyRows = input.entries
    .map((entry) => {
      const metricCells = metricKeys
        .map((key) => {
          const value = entry.metrics[key];
          return `<td class="num value-col">${value !== undefined ? value.toFixed(4) : '—'}</td>`;
        })
        .join('');

      return `<tr>
        <td>${escapeHtml(entry.run_id)}</td>
        <td>${escapeHtml(entry.suite)}</td>
        <td>${verdictPill(entry.verdict)}</td>
        <td>${escapeHtml(entry.started_at)}</td>
        <td>${escapeHtml(entry.completed_at ?? '—')}</td>
        <td class="num">${escapeHtml(formatDurationMs(entry.duration_ms))}</td>
        <td>${tokenCell(entry.tokens)}</td>
        <td class="num">${escapeHtml(entry.git_sha.slice(0, 8))}</td>
        ${metricCells}
      </tr>`;
    })
    .join('\n');

  const colSpan = 8 + metricKeys.length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Eval Trend — ${escapeHtml(input.suiteLabel)}</title>
  <style>${trendStyles()}</style>
</head>
<body>
  <div class="page">
    <header class="page-header">
      <div>
        <h1 class="page-title">Eval Trend Report</h1>
        <p class="page-subtitle">${icon('calendar')} Generated ${escapeHtml(input.generatedAt)} · Suite: ${escapeHtml(input.suiteLabel)}${filterNote ? ` · ${escapeHtml(filterNote)}` : ''} · ${input.entries.length} runs</p>
      </div>
    </header>

    <section class="section">
      <div class="table-card">
        <table>
          <thead>
            <tr>
              <th>Run ID</th>
              <th>Suite</th>
              <th>Verdict</th>
              <th>Started</th>
              <th>Completed</th>
              <th>Duration</th>
              <th>Tokens</th>
              <th>Git</th>
              ${headerCells}
            </tr>
          </thead>
          <tbody>${bodyRows || `<tr><td colspan="${colSpan}" style="color:var(--muted)">No runs matched filters</td></tr>`}</tbody>
        </table>
      </div>
    </section>

    <footer>Assurance Workflow Skills · Eval Trend</footer>
  </div>
</body>
</html>`;
}
