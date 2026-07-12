import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { inspect } from '../../src/report/inspector';
import { ApiResult, E2eResult } from '../../src/core/types';

function makeTmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aws-inspect-'));
}

function makeExecDir(projectRoot: string, changeId: string): string {
  const execDir = path.join(projectRoot, 'qa', 'changes', changeId, 'execution');
  ['raw', 'traces', 'screenshots', 'videos'].forEach(d => fs.mkdirSync(path.join(execDir, d), { recursive: true }));
  return execDir;
}

describe('aws report inspect integration', () => {
  let projectRoot: string;
  const changeId = 'REQ-INSPECT-001';
  beforeEach(() => { projectRoot = makeTmpProject(); });
  afterEach(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

  it('produces status=skipped when no result files exist', () => {
    makeExecDir(projectRoot, changeId);
    const result = inspect({ changeId, projectRoot });
    expect(result.analysis.status).toBe('skipped');
    expect(fs.existsSync(result.analysisPath)).toBe(true);
    expect(fs.existsSync(result.summaryPath)).toBe(true);
  });

  it('produces no_failures when all tests passed', () => {
    const execDir = makeExecDir(projectRoot, changeId);
    const apiResult: ApiResult = { schema_version: '1.0', change_id: changeId, batch_id: 'test-batch', target: 'api', status: 'passed', command: 'pytest', source: { framework: 'pytest', raw_log: '', junit_xml: '', json_report: '' }, total: 1, passed: 1, failed: 0, skipped: 0, cases: [{ case_id: 'TC-A-001', status: 'passed', file: '', test_name: 'test_a', duration_ms: 100, message: '', raw_log_ref: '' }], unmapped_tests: [] };
    const e2eResult: E2eResult = { schema_version: '1.0', change_id: changeId, batch_id: 'test-batch', target: 'e2e', status: 'passed', command: 'npx playwright test', source: { framework: 'playwright', raw_log: '', json_report: '', html_report: '' }, total: 1, passed: 1, failed: 0, skipped: 0, cases: [{ case_id: 'TC-B-001', status: 'passed', file: '', test_name: 'test_b', duration_ms: 200, message: '', trace: '', screenshot: '', video: '' }], unmapped_tests: [] };
    fs.writeFileSync(path.join(execDir, 'api-result.json'), JSON.stringify(apiResult), 'utf-8');
    fs.writeFileSync(path.join(execDir, 'e2e-result.json'), JSON.stringify(e2eResult), 'utf-8');

    const result = inspect({ changeId, projectRoot });
    expect(result.analysis.status).toBe('no_failures');
    expect(result.analysis.failures.length).toBe(0);
  });

  it('classifies e2e locator failure and sets fix_proposal_eligible=true', () => {
    const execDir = makeExecDir(projectRoot, changeId);
    const e2eResult: E2eResult = { schema_version: '1.0', change_id: changeId, batch_id: 'test-batch', target: 'e2e', status: 'failed', command: 'npx playwright test', source: { framework: 'playwright', raw_log: path.join(execDir, 'raw', 'e2e.log'), json_report: '', html_report: '' }, total: 1, passed: 0, failed: 1, skipped: 0, cases: [{ case_id: 'TC-C-001', status: 'failed', file: 'tests/e2e/checkout.spec.ts', test_name: 'TC-C-001 checkout', duration_ms: 3000, message: 'Locator not found: button[data-testid=pay]', trace: '', screenshot: '', video: '' }], unmapped_tests: [] };
    fs.writeFileSync(path.join(execDir, 'e2e-result.json'), JSON.stringify(e2eResult), 'utf-8');
    fs.writeFileSync(path.join(execDir, 'raw', 'e2e.log'), 'Locator not found', 'utf-8');

    const result = inspect({ changeId, projectRoot });
    expect(result.analysis.failures[0].category).toBe('locator_failure');
    expect(result.analysis.failures[0].fix_proposal_eligible).toBe(true);
    expect(result.analysis.failures[0].evidence).toBeDefined();
    expect(result.analysis.failures[0].case_id).toBe('TC-C-001');
  });

  it('extracts the matching e2e failure block instead of the pytest summary line', () => {
    const execDir = makeExecDir(projectRoot, changeId);
    const rawLog = path.join(execDir, 'raw', 'e2e.log');
    const e2eResult: E2eResult = {
      schema_version: '1.0',
      change_id: changeId,
      batch_id: 'test-batch',
      target: 'e2e',
      status: 'failed',
      command: 'pytest tests/e2e',
      source: { framework: 'pytest-playwright', raw_log: rawLog, json_report: '', html_report: '' },
      total: 2,
      passed: 0,
      failed: 2,
      skipped: 0,
      cases: [
        { case_id: 'TC-E2E-001', status: 'failed', file: 'tests/e2e/test_users.py', test_name: 'test_alpha_flow[chromium]', duration_ms: 1000, message: 'Locator not found', trace: '', screenshot: '', video: '' },
        { case_id: 'TC-E2E-002', status: 'failed', file: 'tests/e2e/test_users.py', test_name: 'test_beta_flow[chromium]', duration_ms: 1000, message: 'TimeoutError: timed out waiting for beta toast', trace: '', screenshot: '', video: '' },
      ],
      unmapped_tests: [],
    };
    fs.writeFileSync(path.join(execDir, 'e2e-result.json'), JSON.stringify(e2eResult), 'utf-8');
    fs.writeFileSync(rawLog, [
      'tests/e2e/test_users.py::test_alpha_flow[chromium] FAILED [ 50%]',
      'tests/e2e/test_users.py::test_beta_flow[chromium] FAILED [100%]',
      '',
      '=================================== FAILURES ===================================',
      '________________________ test_alpha_flow[chromium] ________________________',
      'E   AssertionError: alpha failed',
      '',
      '________________________ test_beta_flow[chromium] ________________________',
      'E   TimeoutError: timed out waiting for beta toast',
      'beta-specific detail',
    ].join('\n'), 'utf-8');

    const result = inspect({ changeId, projectRoot });
    const beta = result.analysis.failures.find(f => f.case_id === 'TC-E2E-002');

    expect(beta?.evidence.log_excerpt).toContain('test_beta_flow[chromium]');
    expect(beta?.evidence.log_excerpt).toContain('beta-specific detail');
    expect(beta?.evidence.log_excerpt).not.toContain('test_alpha_flow[chromium]');
  });

  it('failure-analysis.json has required schema fields', () => {
    const execDir = makeExecDir(projectRoot, changeId);
    const apiResult: ApiResult = { schema_version: '1.0', change_id: changeId, batch_id: 'test-batch', target: 'api', status: 'failed', command: 'pytest', source: { framework: 'pytest', raw_log: '', junit_xml: '', json_report: '' }, total: 1, passed: 0, failed: 1, skipped: 0, cases: [{ case_id: 'TC-D-001', status: 'failed', file: 'tests/api/test_d.py', test_name: 'TC-D-001 test_d', duration_ms: 50, message: 'AssertionError: expected 200, got 404', raw_log_ref: '' }], unmapped_tests: [] };

    // Write result file under the batch dir and point a manifest at it, to simulate a real runner output.
    const batchDir = path.join(execDir, 'runs', 'test-batch');
    fs.mkdirSync(batchDir, { recursive: true });
    fs.writeFileSync(path.join(batchDir, 'api-result.json'), JSON.stringify(apiResult), 'utf-8');
    // Coverage is derived from api=true; write a minimal file so integrity guard is satisfied.
    const coverageSkipped = { schema_version: '1.0', change_id: changeId, batch_id: 'test-batch', kind: 'coverage', available: false, line_coverage: 0, branch_coverage: 0, threshold: { line: 0, branch: 0 }, status: 'SKIPPED', skip_reason: 'api_unselected', uncovered_critical_files: [], source: { coverage_json: '', coverage_xml: '' } };
    fs.writeFileSync(path.join(batchDir, 'coverage-result.json'), JSON.stringify(coverageSkipped), 'utf-8');
    const manifest = {
      schema_version: '1.0',
      change_id: changeId,
      batch_id: 'test-batch',
      selected_targets: { api: true, e2e: false, fuzz: false, performance: false },
      result_files: { api: 'runs/test-batch/api-result.json', coverage: 'runs/test-batch/coverage-result.json' },
    };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const yaml = require('js-yaml');
    fs.writeFileSync(path.join(execDir, 'execution-manifest.yaml'), yaml.dump(manifest), 'utf-8');

    const result = inspect({ changeId, projectRoot });
    // failure-analysis.json is written under inspect/, not execution/
    const inspectDir = path.join(projectRoot, 'qa', 'changes', changeId, 'inspect');
    expect(result.analysisPath).toBe(path.join(inspectDir, 'failure-analysis.json'));
    const analysis = JSON.parse(fs.readFileSync(result.analysisPath, 'utf-8'));

    expect(analysis.schema_version).toBe('1.0');
    expect(analysis.change_id).toBe(changeId);
    // Fields required by healing gates / archive gate
    expect(analysis.batch_id).toBe('test-batch');
    expect(analysis.source_batch_id).toBe('test-batch');
    expect(analysis.final_status).toBe('FAIL');
    expect(analysis.inspect_mode).toBe('primary');
    expect(analysis.classification_performed).toBe(true);
    expect(Array.isArray(analysis.failures)).toBe(true);
    expect(analysis.failures[0].case_id).toBeTruthy();
    expect(analysis.failures[0].category).toBeTruthy();
    expect(analysis.failures[0].fix_proposal_eligible).toBeDefined();
    expect(analysis.failures[0].evidence).toBeDefined();
  });

  it('failure-summary.md is written with correct heading', () => {
    const execDir = makeExecDir(projectRoot, changeId);
    const apiResult: ApiResult = { schema_version: '1.0', change_id: changeId, batch_id: 'test-batch', target: 'api', status: 'passed', command: 'pytest', source: { framework: 'pytest', raw_log: '', junit_xml: '', json_report: '' }, total: 0, passed: 0, failed: 0, skipped: 0, cases: [], unmapped_tests: [] };
    fs.writeFileSync(path.join(execDir, 'api-result.json'), JSON.stringify(apiResult), 'utf-8');

    const result = inspect({ changeId, projectRoot });
    const summary = fs.readFileSync(result.summaryPath, 'utf-8');
    expect(summary).toContain(changeId);
    expect(summary).toContain('Failure Analysis Summary');
  });

  it('manifest integrity guard: FAIL when selected target file is missing', () => {
    const execDir = makeExecDir(projectRoot, changeId);
    const batchDir = path.join(execDir, 'runs', 'batch-integrity');
    fs.mkdirSync(batchDir, { recursive: true });

    // Manifest declares api=true AND e2e=true, but only api result is written.
    const manifest = {
      schema_version: '1.0',
      change_id: changeId,
      batch_id: 'batch-integrity',
      selected_targets: { api: true, e2e: true, fuzz: false, performance: false },
      result_files: {
        api: 'runs/batch-integrity/api-result.json',
        e2e: 'runs/batch-integrity/e2e-result.json',  // declared but file will NOT exist
        coverage: 'runs/batch-integrity/coverage-result.json',
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const yaml = require('js-yaml');
    fs.writeFileSync(path.join(execDir, 'execution-manifest.yaml'), yaml.dump(manifest), 'utf-8');

    const apiResult: ApiResult = { schema_version: '1.0', change_id: changeId, batch_id: 'batch-integrity', target: 'api', status: 'passed', command: 'pytest', source: { framework: 'pytest', raw_log: '', junit_xml: '', json_report: '' }, total: 1, passed: 1, failed: 0, skipped: 0, cases: [], unmapped_tests: [] };
    fs.writeFileSync(path.join(batchDir, 'api-result.json'), JSON.stringify(apiResult), 'utf-8');
    // e2e-result.json intentionally NOT written (and no coverage-result.json either)

    const result = inspect({ changeId, projectRoot });
    expect(result.analysis.inspection_status).toBe('failed');
    expect(result.analysis.final_status).toBe('FAIL');
    expect(result.qualityGate.final_status).toBe('FAIL');
    expect(result.analysis.inspect_mode).toBe('primary');
    expect(result.analysis.classification_performed).toBe(false);
    expect(result.analysis.hard_fails).toHaveLength(1);
    expect(result.analysis.hard_fails[0].target).toBe('e2e');
    expect(result.analysis.hard_fails[0].category).toBe('manifest_asset_missing');
    expect(result.analysis.hard_fails[0].fix_proposal_eligible).toBe(false);
    expect(result.analysis.hard_fails[0].recommended_next_action).toContain('Re-run aws run');
  });

  it('manifest integrity guard: missing coverage alone does not hard-fail', () => {
    const execDir = makeExecDir(projectRoot, changeId);
    const batchDir = path.join(execDir, 'runs', 'batch-cov');
    fs.mkdirSync(batchDir, { recursive: true });

    const manifest = {
      schema_version: '1.0',
      change_id: changeId,
      batch_id: 'batch-cov',
      selected_targets: { api: true, e2e: false, fuzz: false, performance: false },
      result_files: { api: 'runs/batch-cov/api-result.json' },
    };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const yaml = require('js-yaml');
    fs.writeFileSync(path.join(execDir, 'execution-manifest.yaml'), yaml.dump(manifest), 'utf-8');

    const apiResult: ApiResult = { schema_version: '1.0', change_id: changeId, batch_id: 'batch-cov', target: 'api', status: 'passed', command: 'pytest', source: { framework: 'pytest', raw_log: '', junit_xml: '', json_report: '' }, total: 1, passed: 1, failed: 0, skipped: 0, cases: [], unmapped_tests: [] };
    fs.writeFileSync(path.join(batchDir, 'api-result.json'), JSON.stringify(apiResult), 'utf-8');
    // coverage-result.json intentionally absent — must not trigger integrity guard

    const result = inspect({ changeId, projectRoot });
    expect(result.analysis.inspection_status).not.toBe('failed');
    expect(result.analysis.hard_fails.filter(f => f.category === 'manifest_asset_missing')).toHaveLength(0);
  });

  it('uses skill extended manifest primary_runner.result_files for result routing', () => {
    const execDir = makeExecDir(projectRoot, changeId);
    const batchDir = path.join(execDir, 'runs', 'batch-skill');
    fs.mkdirSync(batchDir, { recursive: true });

    const apiResult: ApiResult = { schema_version: '1.0', change_id: changeId, batch_id: 'batch-skill', target: 'api', status: 'passed', command: 'pytest', source: { framework: 'pytest', raw_log: '', junit_xml: '', json_report: '' }, total: 1, passed: 1, failed: 0, skipped: 0, cases: [], unmapped_tests: [] };
    fs.writeFileSync(path.join(batchDir, 'api-result.json'), JSON.stringify(apiResult), 'utf-8');

    // Skill-shaped manifest: no top-level result_files map, only primary_runner array
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const yaml = require('js-yaml');
    fs.writeFileSync(path.join(execDir, 'execution-manifest.yaml'), yaml.dump({
      schema_version: '1.0',
      change_id: changeId,
      batch_id: 'batch-skill',
      primary_runner: {
        command: `aws run --change ${changeId}`,
        status: 'passed',
        result_files: [
          path.join(execDir, 'runs/batch-skill/api-result.json'),
        ],
      },
      selected_targets: { api: true, e2e: false, fuzz: false, performance: false },
      final_status: 'PASS',
    }), 'utf-8');

    const result = inspect({ changeId, projectRoot });
    expect(result.analysis.batch_id).toBe('batch-skill');
    expect(result.analysis.status).toBe('no_failures');
    expect(result.analysis.inspect_mode).toBe('primary');
  });
});
