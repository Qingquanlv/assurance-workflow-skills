import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  mergeTokenUsage,
  parseTokenUsageFromStdout,
} from '../../../src/eval/token_usage';
import {
  collectRunExecutionStats,
  formatDurationMs,
  isWithinTimeRange,
  parseIsoDateTime,
} from '../../../src/eval/execution_stats';
import { generateRunReport, generateTrendReport } from '../../../src/eval/report';
import type { RunManifest } from '../../../src/eval/types';

describe('token_usage', () => {
  it('parses OpenCode step_finish token events', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-token-'));
    const stdoutPath = path.join(dir, 'stdout.log');
    fs.writeFileSync(
      stdoutPath,
      [
        JSON.stringify({
          type: 'step_finish',
          part: {
            type: 'step-finish',
            tokens: {
              total: 100,
              input: 80,
              output: 20,
              reasoning: 0,
              cache: { read: 5, write: 2 },
              cost: 0.0012,
            },
          },
        }),
        JSON.stringify({
          type: 'step_finish',
          part: {
            type: 'step-finish',
            tokens: { total: 50, input: 40, output: 10, cost: 0.0008 },
          },
        }),
      ].join('\n')
    );

    const usage = parseTokenUsageFromStdout(stdoutPath);
    expect(usage).toEqual({
      steps: 2,
      input: 120,
      output: 30,
      reasoning: 0,
      total: 150,
      cache_read: 5,
      cache_write: 2,
      cost: 0.002,
    });
  });

  it('returns null when no token events exist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-token-'));
    const stdoutPath = path.join(dir, 'stdout.log');
    fs.writeFileSync(stdoutPath, 'plain subprocess output\n');

    expect(parseTokenUsageFromStdout(stdoutPath)).toBeNull();
  });

  it('merges token usage across samples', () => {
    const a = parseTokenUsageFromStdout(
      (() => {
        const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eval-token-')), 'stdout.log');
        fs.writeFileSync(
          p,
          JSON.stringify({
            type: 'step_finish',
            part: { tokens: { total: 10, input: 8, output: 2 } },
          })
        );
        return p;
      })()
    )!;

    const b = parseTokenUsageFromStdout(
      (() => {
        const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eval-token-')), 'stdout.log');
        fs.writeFileSync(
          p,
          JSON.stringify({
            type: 'step_finish',
            part: { tokens: { total: 20, input: 15, output: 5 } },
          })
        );
        return p;
      })()
    )!;

    expect(mergeTokenUsage(a, b).total).toBe(30);
  });
});

describe('execution_stats', () => {
  it('formats duration for human-readable output', () => {
    expect(formatDurationMs(450)).toBe('450ms');
    expect(formatDurationMs(2500)).toBe('2.5s');
    expect(formatDurationMs(125000)).toBe('2m 5s');
  });

  it('filters runs by started_at range', () => {
    expect(
      isWithinTimeRange('2026-06-20T10:00:00.000Z', '2026-06-20T09:00:00.000Z', '2026-06-20T11:00:00.000Z')
    ).toBe(true);
    expect(
      isWithinTimeRange('2026-06-20T08:00:00.000Z', '2026-06-20T09:00:00.000Z')
    ).toBe(false);
  });

  it('parses ISO datetimes for trend filters', () => {
    expect(parseIsoDateTime('2026-06-20', '--from')).toBe('2026-06-20T00:00:00.000Z');
  });
});

describe('eval report', () => {
  function writeMinimalRun(runDir: string, startedAt: string, completedAt?: string): void {
    const manifest: RunManifest = {
      run_id: path.basename(runDir),
      git_sha: 'abc123456789',
      suite: 'workflow-case',
      suite_version: '1.0.0',
      suite_hash: 'sha256:test',
      dataset_version: '1.0',
      dataset_hash: 'sha256:test',
      dataset_root_hash: 'sha256:test',
      selected_sample_ids: ['WC-001'],
      skill_content_hashes: {},
      fixture_hashes: {},
      prompt_hashes: {},
      target_model: 'unknown',
      target_model_params: {},
      scorer_version: '1.0.0',
      executor_version: '1.0.0',
      runner_version: '1.0.0',
      output_schema_version: '1.0.0',
      environment: { node: '20.0.0', python: null, pytest: null, playwright: null },
      started_at: startedAt,
      completed_at: completedAt,
      total_samples: 1,
      executed_samples: 1,
    };

    fs.mkdirSync(path.join(runDir, 'samples', 'WC-001', 'attempt-0'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(
      path.join(runDir, 'metrics.json'),
      JSON.stringify(
        {
          suite: 'workflow-case',
          run_id: manifest.run_id,
          sample_count: 1,
          inconclusive_count: 0,
          error_count: 0,
          metrics: { schema_valid_rate: 1 },
        },
        null,
        2
      )
    );
    fs.writeFileSync(
      path.join(runDir, 'gate-result.json'),
      JSON.stringify(
        {
          run_id: manifest.run_id,
          suite: 'workflow-case',
          verdict: 'pass',
          hard_gate_failures: [],
          threshold_failures: [],
        },
        null,
        2
      )
    );
    fs.writeFileSync(
      path.join(runDir, 'samples', 'WC-001', 'attempt-0', 'execution.json'),
      JSON.stringify({
        sample_id: 'WC-001',
        attempt: 0,
        started_at: startedAt,
        completed_at: completedAt ?? startedAt,
        duration_ms: 1000,
        status: 'ok',
      })
    );
    fs.writeFileSync(
      path.join(runDir, 'samples', 'WC-001', 'attempt-0', 'stdout.log'),
      JSON.stringify({
        type: 'step_finish',
        part: { tokens: { total: 42, input: 30, output: 12 } },
      })
    );
  }

  it('includes execution timing and token usage in run report', () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-report-run-'));
    writeMinimalRun(runDir, '2026-06-20T10:00:00.000Z', '2026-06-20T10:05:00.000Z');

    const { markdown, data, htmlPath } = generateRunReport(runDir, { html: true });

    expect(markdown).toContain('## Execution');
    expect(markdown).toContain('2026-06-20T10:00:00.000Z');
    expect(markdown).toContain('total=42');
    expect(data.execution.tokens?.total).toBe(42);
    expect(htmlPath).toBe(path.join(runDir, 'report.html'));
    expect(fs.readFileSync(htmlPath!, 'utf-8')).toContain('Token Usage');
  });

  it('filters trend report by suite and time range', () => {
    const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-report-trend-'));
    const evalRoot = path.dirname(runsDir);

    writeMinimalRun(
      path.join(runsDir, 'eval-20260620-a'),
      '2026-06-20T10:00:00.000Z',
      '2026-06-20T10:01:00.000Z'
    );

    const otherRun = path.join(runsDir, 'eval-20260621-b');
    writeMinimalRun(otherRun, '2026-06-21T10:00:00.000Z', '2026-06-21T10:01:00.000Z');
    const otherManifest = JSON.parse(
      fs.readFileSync(path.join(otherRun, 'manifest.json'), 'utf-8')
    ) as RunManifest;
    otherManifest.suite = 'workflow-full';
    fs.writeFileSync(path.join(otherRun, 'manifest.json'), JSON.stringify(otherManifest, null, 2));
    fs.writeFileSync(
      path.join(otherRun, 'gate-result.json'),
      JSON.stringify(
        {
          run_id: otherManifest.run_id,
          suite: 'workflow-full',
          verdict: 'pass',
          hard_gate_failures: [],
          threshold_failures: [],
        },
        null,
        2
      )
    );
    fs.writeFileSync(
      path.join(otherRun, 'metrics.json'),
      JSON.stringify(
        {
          suite: 'workflow-full',
          run_id: otherManifest.run_id,
          sample_count: 1,
          inconclusive_count: 0,
          error_count: 0,
          metrics: { end_to_end_pass_rate: 1 },
        },
        null,
        2
      )
    );

    const { entries, htmlPath } = generateTrendReport(runsDir, {
      suite: 'workflow-case',
      from: '2026-06-20T00:00:00.000Z',
      to: '2026-06-20T23:59:59.999Z',
      html: true,
      evalRoot,
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].run_id).toBe('eval-20260620-a');
    expect(entries[0].tokens?.total).toBe(42);
    expect(htmlPath).toBe(path.join(evalRoot, 'reports', 'trend-workflow-case.html'));
    expect(fs.readFileSync(htmlPath!, 'utf-8')).toContain('eval-20260620-a');
  });

  it('collects per-sample execution stats from run evidence', () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-report-stats-'));
    writeMinimalRun(runDir, '2026-06-20T10:00:00.000Z', '2026-06-20T10:05:00.000Z');
    const manifest = JSON.parse(
      fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf-8')
    ) as RunManifest;

    const stats = collectRunExecutionStats(runDir, manifest);
    expect(stats.per_sample).toHaveLength(1);
    expect(stats.per_sample[0].duration_ms).toBe(1000);
    expect(stats.tokens?.total).toBe(42);
  });
});
