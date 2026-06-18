import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseCoverage, loadCoverageConfig } from '../../src/execution/coverage_parser';
import { buildQualityGate } from '../../src/report/quality_gate';
import { computeQualityScore } from '../../src/report/quality_score';
import { generateReport } from '../../src/report/report_generator';
import { run } from '../../src/execution/runner';
import { ApiResult, CoverageResult, E2eResult, FailureAnalysis, QualityGateResult } from '../../src/core/types';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('M1 coverage_parser', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir('aws-cov-'); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('normalises coverage.py JSON into canonical CoverageResult', () => {
    const covJson = path.join(dir, 'coverage.json');
    fs.writeFileSync(covJson, JSON.stringify({
      files: {
        'app/api/v1/menu.py': { summary: { percent_covered: 41.0, num_branches: 10, covered_branches: 4 } },
        'app/services/ok.py': { summary: { percent_covered: 95.0, num_branches: 4, covered_branches: 4 } },
      },
      totals: { percent_covered: 76.2, num_branches: 14, covered_branches: 8 },
    }));

    const result = parseCoverage({
      changeId: 'REQ-1', batchId: 'B1', available: true,
      coverageJsonPath: covJson, coverageXmlPath: path.join(dir, 'coverage.xml'),
      threshold: { line: 70, branch: 60 }, targetPackage: 'app',
    });

    expect(result.available).toBe(true);
    expect(result.line_coverage).toBe(76.2);
    expect(result.branch_coverage).toBeCloseTo(57.1, 1);
    // line >= 70 but branch < 60 → PASS_WITH_WARNINGS
    expect(result.status).toBe('PASS_WITH_WARNINGS');
    // only the below-threshold file under target package is flagged
    expect(result.uncovered_critical_files.map(f => f.file)).toEqual(['app/api/v1/menu.py']);
  });

  it('marks coverage SKIPPED when data is unavailable', () => {
    const result = parseCoverage({
      changeId: 'REQ-1', batchId: 'B1', available: false,
      coverageJsonPath: path.join(dir, 'missing.json'), coverageXmlPath: path.join(dir, 'coverage.xml'),
      threshold: { line: 70, branch: 60 }, targetPackage: 'app',
    });
    expect(result.available).toBe(false);
    expect(result.status).toBe('SKIPPED');
  });

  it('loadCoverageConfig returns defaults when no config file', () => {
    const cfg = loadCoverageConfig(dir);
    expect(cfg.enabled).toBe(true);
    expect(cfg.target_package).toBe('app');
    expect(cfg.threshold.line).toBe(70);
    expect(cfg.gate_mode).toBe('warn');
  });
});

describe('M1 quality_gate', () => {
  const api = (failed: number): ApiResult => ({
    schema_version: '1.0', change_id: 'R', batch_id: 'B', target: 'api', status: failed ? 'failed' : 'passed',
    command: '', source: { framework: 'pytest', raw_log: '', junit_xml: '', json_report: '' },
    total: 10, passed: 10 - failed, failed, skipped: 0, cases: [], unmapped_tests: [],
  });
  const cov = (status: CoverageResult['status'], available = true): CoverageResult => ({
    schema_version: '1.0', change_id: 'R', batch_id: 'B', kind: 'coverage', available,
    line_coverage: 76, branch_coverage: 58, threshold: { line: 70, branch: 60 }, status,
    uncovered_critical_files: [], source: { coverage_json: '', coverage_xml: '' },
  });

  it('PASS functional + PASS_WITH_WARNINGS coverage → PASS_WITH_WARNINGS (warn mode)', () => {
    const gate = buildQualityGate({ changeId: 'R', batchId: 'B', apiResult: api(0), e2eResult: null, coverageResult: cov('PASS_WITH_WARNINGS'), coverageGateMode: 'warn' });
    expect(gate.dimensions.functional.status).toBe('PASS');
    expect(gate.dimensions.coverage.status).toBe('PASS_WITH_WARNINGS');
    expect(gate.final_status).toBe('PASS_WITH_WARNINGS');
  });

  it('block mode escalates below-threshold coverage to FAIL', () => {
    const gate = buildQualityGate({ changeId: 'R', batchId: 'B', apiResult: api(0), e2eResult: null, coverageResult: cov('PASS_WITH_WARNINGS'), coverageGateMode: 'block' });
    expect(gate.final_status).toBe('FAIL');
  });

  it('failed functional → FAIL regardless of coverage', () => {
    const gate = buildQualityGate({ changeId: 'R', batchId: 'B', apiResult: api(2), e2eResult: null, coverageResult: cov('PASS'), coverageGateMode: 'warn' });
    expect(gate.final_status).toBe('FAIL');
  });

  it('coverage unavailable does not fail the gate', () => {
    const gate = buildQualityGate({ changeId: 'R', batchId: 'B', apiResult: api(0), e2eResult: null, coverageResult: cov('SKIPPED', false), coverageGateMode: 'warn' });
    expect(gate.dimensions.coverage.status).toBe('SKIPPED');
    expect(gate.final_status).toBe('PASS');
  });
});

describe('M1 quality_score', () => {
  it('degenerate two-dimension formula (functional 70 + coverage 30)', () => {
    const { score, breakdown } = computeQualityScore({
      functional: { active: true, ratio: 1.0, weight: 70 },
      coverage: { active: true, ratio: 17 / 30, weight: 30 },
      fuzz: { active: false, ratio: 0, weight: 0 },
      performance: { active: false, ratio: 0, weight: 0 },
    });
    expect(score).toBe(87);
    expect(breakdown.functional).toBe(70);
    expect(breakdown.coverage).toBeCloseTo(17, 0);
    expect(breakdown.fuzz).toBe('N/A');
    expect(breakdown.performance).toBe('N/A');
  });

  it('renormalises to 100 when coverage is N/A', () => {
    const { score, breakdown } = computeQualityScore({
      functional: { active: true, ratio: 1.0, weight: 70 },
      coverage: { active: false, ratio: 0, weight: 30 },
      fuzz: { active: false, ratio: 0, weight: 0 },
      performance: { active: false, ratio: 0, weight: 0 },
    });
    expect(score).toBe(100);
    expect(breakdown.functional).toBe(100);
    expect(breakdown.coverage).toBe('N/A');
  });
});

describe('M1 report_generator', () => {
  let projectRoot: string;
  beforeEach(() => { projectRoot = tmpDir('aws-report-'); });
  afterEach(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

  function seed(changeId: string, gate: QualityGateResult, analysis: FailureAnalysis, coverage: CoverageResult, api: ApiResult, e2e: E2eResult) {
    const base = path.join(projectRoot, 'qa', 'changes', changeId);
    fs.mkdirSync(path.join(base, 'execution'), { recursive: true });
    fs.mkdirSync(path.join(base, 'inspect'), { recursive: true });
    fs.writeFileSync(path.join(base, 'execution', 'api-result.json'), JSON.stringify(api));
    fs.writeFileSync(path.join(base, 'execution', 'e2e-result.json'), JSON.stringify(e2e));
    fs.writeFileSync(path.join(base, 'execution', 'coverage-result.json'), JSON.stringify(coverage));
    fs.writeFileSync(path.join(base, 'inspect', 'failure-analysis.json'), JSON.stringify(analysis));
    fs.writeFileSync(path.join(base, 'inspect', 'quality-gate-result.json'), JSON.stringify(gate));
  }

  it('generates a deterministic report from inspect artifacts', () => {
    const changeId = 'REQ-RPT-001';
    const gate: QualityGateResult = {
      schema_version: '1.0', change_id: changeId, batch_id: 'B1',
      dimensions: {
        functional: { status: 'PASS', api: { total: 10, passed: 10, failed: 0 }, e2e: { total: 0, passed: 0, failed: 0 } },
        coverage: { status: 'PASS_WITH_WARNINGS', available: true, line_coverage: 76, branch_coverage: 58, threshold: { line: 70, branch: 60 } },
      },
      final_status: 'PASS_WITH_WARNINGS',
    };
    const analysis: FailureAnalysis = {
      schema_version: '1.0', change_id: changeId, batch_id: 'B1', source_batch_id: 'B1',
      source_manifest: '', inspection_status: 'completed',
      final_status: 'PASS', inspect_mode: 'primary', classification_performed: true, status: 'no_failures',
      failures: [], hard_fails: [], needs_review: [], known_product_issues: [],
    };
    const coverage: CoverageResult = {
      schema_version: '1.0', change_id: changeId, batch_id: 'B1', kind: 'coverage', available: true,
      line_coverage: 76, branch_coverage: 58, threshold: { line: 70, branch: 60 }, status: 'PASS_WITH_WARNINGS',
      uncovered_critical_files: [], source: { coverage_json: '', coverage_xml: '' },
    };
    const api: ApiResult = {
      schema_version: '1.0', change_id: changeId, batch_id: 'B1', target: 'api', status: 'passed', command: '',
      source: { framework: 'pytest', raw_log: '', junit_xml: '', json_report: '' },
      total: 10, passed: 10, failed: 0, skipped: 0, cases: [], unmapped_tests: [],
    };
    const e2e: E2eResult = {
      schema_version: '1.0', change_id: changeId, batch_id: 'B1', target: 'e2e', status: 'skipped', command: '',
      source: { framework: 'pytest-playwright', raw_log: '', json_report: '', html_report: '' },
      total: 0, passed: 0, failed: 0, skipped: 0, cases: [], unmapped_tests: [],
    };
    seed(changeId, gate, analysis, coverage, api, e2e);

    const result = generateReport({ changeId, projectRoot });
    expect(result.report.final_status).toBe('PASS_WITH_WARNINGS');
    // functional 100% pass, coverage 76/70 capped at 1.0 → score 100
    expect(result.report.quality_score).toBe(100);
    expect(result.report.risk_level).toBe('LOW');
    expect(result.report.recommendation).not.toMatch(/safe to release/i);
    expect(fs.existsSync(result.jsonPath)).toBe(true);
    expect(fs.existsSync(result.mdPath)).toBe(true);
    expect(fs.existsSync(result.execSummaryPath)).toBe(true);
  });

  it('throws when quality-gate-result.json is missing', () => {
    expect(() => generateReport({ changeId: 'NOPE', projectRoot })).toThrow(/quality-gate-result.json not found/);
  });

  it('reads execution results from manifest batch dir, not stale latest pointers', () => {
    const changeId = 'REQ-RPT-MANIFEST';
    const base = path.join(projectRoot, 'qa', 'changes', changeId);
    const executionDir = path.join(base, 'execution');
    const batchDir = path.join(executionDir, 'runs', 'batch-stale-test');
    fs.mkdirSync(batchDir, { recursive: true });
    fs.mkdirSync(path.join(base, 'inspect'), { recursive: true });

    const staleApi: ApiResult = {
      schema_version: '1.0', change_id: changeId, batch_id: 'stale', target: 'api', status: 'failed', command: '',
      source: { framework: 'pytest', raw_log: '', junit_xml: '', json_report: '' },
      total: 10, passed: 0, failed: 10, skipped: 0, cases: [], unmapped_tests: [],
    };
    const batchApi: ApiResult = {
      ...staleApi,
      batch_id: 'batch-stale-test',
      status: 'passed',
      passed: 10,
      failed: 0,
    };

    fs.writeFileSync(path.join(executionDir, 'api-result.json'), JSON.stringify(staleApi));
    fs.writeFileSync(path.join(batchDir, 'api-result.json'), JSON.stringify(batchApi));
    fs.writeFileSync(
      path.join(executionDir, 'execution-manifest.yaml'),
      [
        'schema_version: "1.0"',
        'change_id: REQ-RPT-MANIFEST',
        'batch_id: batch-stale-test',
        'selected_targets:',
        '  api: true',
        '  e2e: false',
        '  fuzz: false',
        '  performance: false',
        'result_files:',
        '  api: runs/batch-stale-test/api-result.json',
      ].join('\n')
    );

    const gate: QualityGateResult = {
      schema_version: '1.0', change_id: changeId, batch_id: 'batch-stale-test',
      dimensions: {
        functional: { status: 'PASS', api: { total: 10, passed: 10, failed: 0 }, e2e: { total: 0, passed: 0, failed: 0 } },
        coverage: { status: 'SKIPPED', available: false, line_coverage: 0, branch_coverage: 0, threshold: { line: 70, branch: 60 } },
      },
      final_status: 'PASS',
    };
    const analysis: FailureAnalysis = {
      schema_version: '1.0', change_id: changeId, batch_id: 'batch-stale-test', source_batch_id: 'batch-stale-test',
      source_manifest: '', inspection_status: 'completed',
      final_status: 'PASS', inspect_mode: 'primary', classification_performed: true, status: 'no_failures',
      failures: [], hard_fails: [], needs_review: [], known_product_issues: [],
    };
    fs.writeFileSync(path.join(base, 'inspect', 'failure-analysis.json'), JSON.stringify(analysis));
    fs.writeFileSync(path.join(base, 'inspect', 'quality-gate-result.json'), JSON.stringify(gate));

    const result = generateReport({ changeId, projectRoot });
    expect(result.report.batch_id).toBe('batch-stale-test');
    expect(result.report.functional.api.passed).toBe(10);
    expect(result.report.final_status).toBe('PASS');
  });
});

describe('M1 runner coverage output', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = tmpDir('aws-run-cov-');
    fs.mkdirSync(path.join(projectRoot, 'qa', 'changes', 'REQ-COV-001', 'plans'), { recursive: true });
  });
  afterEach(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

  it('always writes coverage-result.json (SKIPPED when pytest-cov unavailable)', () => {
    const result = run({ changeId: 'REQ-COV-001', projectRoot });
    const execDir = path.join(projectRoot, 'qa', 'changes', 'REQ-COV-001', 'execution');
    expect(fs.existsSync(path.join(execDir, 'coverage-result.json'))).toBe(true);
    expect(result.coverage?.kind).toBe('coverage');
    // In CI without pytest-cov, coverage is SKIPPED — never fabricated as PASS.
    expect(['SKIPPED', 'PASS', 'PASS_WITH_WARNINGS']).toContain(result.coverage?.status);
  });

  it('does not execute or write result files for unselected targets', () => {
    const changeId = 'REQ-SELECTED-001';
    fs.mkdirSync(path.join(projectRoot, 'qa', 'changes', changeId, 'plans'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'tests', 'e2e'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'tests', 'fuzz'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'qa', 'perf'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'qa', 'perf', 'locustfile.py'), '# historical perf asset\n');

    const result = run({
      changeId,
      projectRoot,
      selectedTargets: { api: false, e2e: false, fuzz: false, performance: false },
    });

    const execDir = path.join(projectRoot, 'qa', 'changes', changeId, 'execution');
    expect(fs.existsSync(path.join(execDir, 'execution-manifest.yaml'))).toBe(true);
    // api=false, e2e=false, fuzz=false, performance=false → these files must not exist
    expect(fs.existsSync(path.join(execDir, 'api-result.json'))).toBe(false);
    expect(fs.existsSync(path.join(execDir, 'e2e-result.json'))).toBe(false);
    expect(fs.existsSync(path.join(execDir, 'fuzz-result.json'))).toBe(false);
    expect(fs.existsSync(path.join(execDir, 'performance-result.json'))).toBe(false);
    // coverage is always written — SKIPPED with reason=api_unselected when api=false
    expect(fs.existsSync(path.join(execDir, 'coverage-result.json'))).toBe(true);
    expect(result.coverage.status).toBe('SKIPPED');
    expect(result.coverage.skip_reason).toBe('api_unselected');
  });
});
