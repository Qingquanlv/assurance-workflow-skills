import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { evaluateThreshold, computeGateResult } from '../../../src/eval/gate';
import type { EvalSuite, SuiteMetrics } from '../../../src/eval/types';

function makeSuite(overrides: Partial<EvalSuite> = {}): EvalSuite {
  return {
    name: 'test-suite',
    version: '1.0.0',
    executor: { type: 'in_process', target_module: 'x', target_export: 'y' },
    ci: {},
    dataset: 'test',
    thresholds: {
      macro_f1: '>= 0.85',
      false_product_attribution_rate: '<= 0.05',
    },
    hard_gates: ['false_product_attribution_rate', 'evidence_integrity'],
    ...overrides,
  };
}

function makeMetrics(overrides: Partial<SuiteMetrics> = {}): SuiteMetrics {
  return {
    suite: 'test-suite',
    run_id: 'eval-test-run',
    sample_count: 10,
    inconclusive_count: 0,
    error_count: 0,
    metrics: {
      macro_f1: 0.90,
      false_product_attribution_rate: 0.02,
    },
    ...overrides,
  };
}

function writeManifest(runDir: string, runId: string): void {
  fs.writeFileSync(
    path.join(runDir, 'manifest.json'),
    JSON.stringify({
      run_id: runId,
      git_sha: 'abc',
      suite: 'test-suite',
      suite_version: '1.0.0',
      suite_hash: 'h',
      dataset_version: '1.0',
      dataset_hash: 'h',
      dataset_root_hash: 'h',
      selected_sample_ids: [],
      skill_content_hashes: {},
      fixture_hashes: {},
      prompt_hashes: {},
      target_model: 'unknown',
      target_model_params: {},
      scorer_version: '0.1.0',
      executor_version: '0.1.0',
      runner_version: '0.1.0',
      output_schema_version: '1.0',
      environment: { node: 'v20', python: null, pytest: null, playwright: null },
      started_at: new Date().toISOString(),
      total_samples: 1,
      executed_samples: 1,
    })
  );
}

describe('evaluateThreshold', () => {
  it('parses >= threshold', () => {
    expect(evaluateThreshold('>= 0.85', 0.87)).toBe(true);
    expect(evaluateThreshold('>= 0.85', 0.80)).toBe(false);
  });

  it('parses <= threshold', () => {
    expect(evaluateThreshold('<= 0.05', 0.03)).toBe(true);
    expect(evaluateThreshold('<= 0.05', 0.10)).toBe(false);
  });
});

describe('computeGateResult', () => {
  let tmpBase: string;
  let runId: string;
  let runDir: string;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-gate-'));
    runId = 'eval-test-run';
    runDir = path.join(tmpBase, runId);
    fs.mkdirSync(runDir);
    writeManifest(runDir, runId);
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('hard gate failure is not offset by high soft metrics', () => {
    const result = computeGateResult(
      makeSuite(),
      makeMetrics({
        metrics: { macro_f1: 0.99, false_product_attribution_rate: 0.20 },
      }),
      runId,
      runDir
    );
    expect(result.verdict).toBe('fail');
    expect(result.hard_gate_failures).toContain('false_product_attribution_rate');
  });

  it('any sample error_count > 0 → fail (sample_execution_error)', () => {
    const result = computeGateResult(
      makeSuite(),
      makeMetrics({ error_count: 1, sample_count: 10, run_id: runId }),
      runId,
      runDir
    );
    expect(result.verdict).toBe('fail');
    expect(result.hard_gate_failures).toContain('sample_execution_error');
  });

  it('inconclusive rate above threshold → inconclusive', () => {
    const result = computeGateResult(
      makeSuite(),
      makeMetrics({ inconclusive_count: 3, sample_count: 10, run_id: runId }),
      runId,
      runDir
    );
    expect(result.verdict).toBe('inconclusive');
  });

  it('threshold-only failures → pass_with_warnings', () => {
    const result = computeGateResult(
      makeSuite({ hard_gates: ['evidence_integrity'] }),
      makeMetrics({
        run_id: runId,
        metrics: { macro_f1: 0.50, false_product_attribution_rate: 0.01 },
      }),
      runId,
      runDir
    );
    expect(result.verdict).toBe('pass_with_warnings');
    expect(result.threshold_failures).toContain('macro_f1');
  });
});
