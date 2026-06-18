import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { computeBatchVerdict, validateBatchIntegrity } from '../../../src/eval/batch';
import type { SuiteRunEntry } from '../../../src/eval/types';

function entry(
  verdict: SuiteRunEntry['verdict'],
  required: boolean
): SuiteRunEntry {
  return { run_id: 'eval-test', verdict, required };
}

describe('computeBatchVerdict', () => {
  it('required=true suite fail → batch fail', () => {
    const verdict = computeBatchVerdict({
      'classification-unit': entry('fail', true),
      codegen: entry('pass', false),
    });
    expect(verdict).toBe('fail');
  });

  it('required=false suite fail → pass_with_warnings', () => {
    const verdict = computeBatchVerdict({
      codegen: entry('fail', false),
      safety: entry('pass', true),
    });
    expect(verdict).toBe('pass_with_warnings');
  });

  it('needs_human_review from any suite → batch needs_human_review', () => {
    const verdict = computeBatchVerdict({
      'case-generation': entry('needs_human_review', true),
      safety: entry('pass', true),
    });
    expect(verdict).toBe('needs_human_review');
  });

  it('empty plan: pull_request → pass_with_warnings', () => {
    expect(computeBatchVerdict({}, 'pull_request')).toBe('pass_with_warnings');
  });

  it('empty plan: nightly → inconclusive', () => {
    expect(computeBatchVerdict({}, 'nightly')).toBe('inconclusive');
  });

  it('empty plan: manual → fail', () => {
    expect(computeBatchVerdict({}, 'manual')).toBe('fail');
  });

  it('all pass → batch pass', () => {
    const verdict = computeBatchVerdict({
      '_test': entry('pass', true),
    });
    expect(verdict).toBe('pass');
  });
});

describe('validateBatchIntegrity', () => {
  let tmpBase: string;
  let batchDir: string;
  let runsDir: string;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-batch-int-'));
    runsDir = path.join(tmpBase, 'runs');
    batchDir = path.join(tmpBase, 'batches', 'batch-test-001');
    fs.mkdirSync(path.join(batchDir, 'suite-runs'), { recursive: true });
    fs.mkdirSync(runsDir, { recursive: true });
    fs.writeFileSync(
      path.join(batchDir, 'batch-manifest.json'),
      JSON.stringify({
        batch_id: 'batch-test-001',
        git_sha: 'abc',
        plan_hash: 'h',
        suite_runs: { _test: 'eval-run-001' },
        started_at: new Date().toISOString(),
      })
    );
    fs.writeFileSync(
      path.join(batchDir, 'suite-runs', '_test.json'),
      JSON.stringify({ run_id: 'eval-run-001', verdict: 'pass', required: true })
    );
    const runDir = path.join(runsDir, 'eval-run-001');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'gate-result.json'), '{}');
    fs.writeFileSync(path.join(runDir, 'manifest.json'), '{}');
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('passes when manifest, suite-runs, and run dirs align', () => {
    expect(validateBatchIntegrity(batchDir, runsDir)).toEqual([]);
  });

  it('detects suite_run_id mismatch', () => {
    fs.writeFileSync(
      path.join(batchDir, 'batch-manifest.json'),
      JSON.stringify({
        batch_id: 'batch-test-001',
        git_sha: 'abc',
        plan_hash: 'h',
        suite_runs: { _test: 'eval-run-other' },
        started_at: new Date().toISOString(),
      })
    );
    const failures = validateBatchIntegrity(batchDir, runsDir);
    expect(failures).toContain('suite_run_id_mismatch:_test');
  });

  it('detects missing run directory', () => {
    fs.rmSync(path.join(runsDir, 'eval-run-001'), { recursive: true, force: true });
    const failures = validateBatchIntegrity(batchDir, runsDir);
    expect(failures).toContain('run_dir_missing:_test');
  });
});
