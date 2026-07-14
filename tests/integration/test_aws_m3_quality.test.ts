import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildQualityGate } from '../../src/workflow/report/quality_gate';
import { computeQualityScore } from '../../src/workflow/report/quality_score';
import { inspect } from '../../src/workflow/report/inspector';
import { generateReport } from '../../src/workflow/report/report_generator';
import { parseLocustStats, resolveLoadProfile, buildScenarioVerdicts, mergeLocustStatsMaps, loadPerformanceScenarios, parsePerformanceCase } from '../../src/workflow/execution/locust_runner';
import { buildSummaryMd } from '../../src/workflow/execution/summary_writer';
import {
  ApiResult,
  CoverageResult,
  E2eResult,
  FuzzResult,
  PerformanceResult,
} from '../../src/workflow/core/types';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const apiResult = (failed: number, batchId = 'B'): ApiResult => ({
  schema_version: '1.0', change_id: 'R', batch_id: batchId, target: 'api', status: failed ? 'failed' : 'passed',
  command: '', source: { framework: 'pytest', raw_log: '', junit_xml: '', json_report: '' },
  total: 10, passed: 10 - failed, failed, skipped: 0, cases: [], unmapped_tests: [],
});

const fuzzResult = (failed: number, status: 'passed' | 'failed' | 'skipped' = 'passed'): FuzzResult => ({
  schema_version: '1.0', change_id: 'R', batch_id: 'B', target: 'fuzz', status,
  command: '', source: { framework: 'pytest', raw_log: '', junit_xml: '', json_report: '' },
  total: status === 'skipped' ? 0 : 6, passed: 6 - failed, failed, skipped: 0, cases: [], unmapped_tests: [],
});

const perfResult = (verdict: 'PASS' | 'FAIL' | 'SKIPPED', available = true): PerformanceResult => ({
  schema_version: '1.0', change_id: 'R', batch_id: 'B', kind: 'performance', available,
  status: available ? verdict : 'SKIPPED',
  scenarios: available
    ? [{
        capability: 'checkout', endpoint: 'POST /api/checkout',
        measured_p95_ms: verdict === 'FAIL' ? 1200 : 420, threshold_p95_ms: 800,
        measured_error_rate: 0.0, threshold_error_rate_max: 0.01, verdict,
      }]
    : [],
  command: '', source: { raw_log: '', csv_prefix: '' },
});

const e2eResult = (failed: number): E2eResult => ({
  schema_version: '1.0', change_id: 'R', batch_id: 'B', target: 'e2e', status: failed ? 'failed' : 'passed',
  command: '', source: { framework: 'pytest-playwright', raw_log: '', json_report: '', html_report: '' },
  total: 2, passed: 2 - failed, failed, skipped: 0, cases: [], unmapped_tests: [],
});

const coverageResult = (status: CoverageResult['status'], batchId = 'B'): CoverageResult => ({
  schema_version: '1.0', change_id: 'R', batch_id: batchId, kind: 'coverage', available: status !== 'SKIPPED',
  line_coverage: 80, branch_coverage: 70, threshold: { line: 70, branch: 60 }, status,
  uncovered_critical_files: [], source: { coverage_json: '', coverage_xml: '' },
});

describe('M3 quality_gate — fuzz + non_functional dimensions', () => {
  it('fuzz folds into functional; failing fuzz → functional FAIL', () => {
    const gate = buildQualityGate({
      changeId: 'R', batchId: 'B', apiResult: apiResult(0), e2eResult: null,
      coverageResult: null, coverageGateMode: 'warn', fuzzResult: fuzzResult(1),
    });
    expect(gate.dimensions.functional.fuzz).toEqual({ total: 6, passed: 5, failed: 1 });
    expect(gate.dimensions.functional.status).toBe('FAIL');
    expect(gate.final_status).toBe('FAIL');
  });

  it('skipped fuzz does not attach fuzz counts', () => {
    const gate = buildQualityGate({
      changeId: 'R', batchId: 'B', apiResult: apiResult(0), e2eResult: null,
      coverageResult: null, coverageGateMode: 'warn', fuzzResult: fuzzResult(0, 'skipped'),
    });
    expect(gate.dimensions.functional.fuzz).toBeUndefined();
  });

  it('performance FAIL surfaces in non_functional and worst-wins to FAIL', () => {
    const gate = buildQualityGate({
      changeId: 'R', batchId: 'B', apiResult: apiResult(0), e2eResult: null,
      coverageResult: null, coverageGateMode: 'warn', performanceResult: perfResult('FAIL'),
    });
    expect(gate.dimensions.non_functional?.status).toBe('FAIL');
    expect(gate.final_status).toBe('FAIL');
  });

  it('performance unavailable → non_functional SKIPPED, does not fail the gate', () => {
    const gate = buildQualityGate({
      changeId: 'R', batchId: 'B', apiResult: apiResult(0), e2eResult: null,
      coverageResult: null, coverageGateMode: 'warn', performanceResult: perfResult('SKIPPED', false),
    });
    expect(gate.dimensions.non_functional?.status).toBe('SKIPPED');
    expect(gate.final_status).toBe('PASS');
  });
});

describe('M3 quality_score — four dimensions', () => {
  it('uses M3 weights (50/20/15/15) and renormalises active dims', () => {
    const { score, breakdown } = computeQualityScore({
      functional: { active: true, ratio: 1.0, weight: 50 },
      coverage: { active: true, ratio: 1.0, weight: 20 },
      fuzz: { active: true, ratio: 1.0, weight: 15 },
      performance: { active: true, ratio: 1.0, weight: 15 },
    });
    expect(score).toBe(100);
    expect(breakdown.fuzz).toBe(15);
    expect(breakdown.performance).toBe(15);
  });
});

describe('M3 inspector — perf threshold failures classified', () => {
  let projectRoot: string;
  beforeEach(() => { projectRoot = tmpDir('aws-m3-inspect-'); });
  afterEach(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

  it('emits a perf_threshold_exceeded failure and a four-dimension gate', () => {
    const changeId = 'REQ-PERF-001';
    const base = path.join(projectRoot, 'qa', 'changes', changeId);
    fs.mkdirSync(path.join(base, 'execution'), { recursive: true });
    fs.writeFileSync(path.join(base, 'execution', 'api-result.json'), JSON.stringify(apiResult(0)));
    fs.writeFileSync(path.join(base, 'execution', 'fuzz-result.json'), JSON.stringify(fuzzResult(0)));
    fs.writeFileSync(path.join(base, 'execution', 'performance-result.json'), JSON.stringify(perfResult('FAIL')));

    const result = inspect({ changeId, projectRoot });
    const perfFailure = result.analysis.failures.find(f => f.target === 'performance');
    expect(perfFailure?.category).toBe('perf_threshold_exceeded');
    expect(perfFailure?.fix_proposal_eligible).toBe(false);
    expect(perfFailure?.severity).toBe('high');
    expect(result.qualityGate.dimensions.functional.fuzz).toEqual({ total: 6, passed: 6, failed: 0 });
    expect(result.qualityGate.dimensions.non_functional?.status).toBe('FAIL');
    expect(result.qualityGate.final_status).toBe('FAIL');
    expect(fs.existsSync(result.qualityGatePath)).toBe(true);
  });

  it('uses execution-manifest batch and selected targets instead of stale latest pointers', () => {
    const changeId = 'REQ-MANIFEST-001';
    const base = path.join(projectRoot, 'qa', 'changes', changeId);
    const execution = path.join(base, 'execution');
    const batch = path.join(execution, 'runs', 'B2');
    fs.mkdirSync(batch, { recursive: true });

    fs.writeFileSync(path.join(execution, 'e2e-result.json'), JSON.stringify(e2eResult(1)));
    fs.writeFileSync(path.join(execution, 'performance-result.json'), JSON.stringify(perfResult('FAIL')));
    fs.writeFileSync(path.join(batch, 'api-result.json'), JSON.stringify(apiResult(0, 'B2')));
    // Coverage is derived from api=true — write a SKIPPED result so integrity guard is satisfied.
    fs.writeFileSync(path.join(batch, 'coverage-result.json'), JSON.stringify(coverageResult('SKIPPED', 'B2')));
    fs.writeFileSync(path.join(execution, 'execution-manifest.yaml'), [
      'schema_version: "1.0"',
      `change_id: ${changeId}`,
      'batch_id: B2',
      'selected_targets:',
      '  api: true',
      '  e2e: false',
      '  fuzz: false',
      '  performance: false',
      'result_files:',
      '  api: runs/B2/api-result.json',
      '  coverage: runs/B2/coverage-result.json',
    ].join('\n'));

    const result = inspect({ changeId, projectRoot });
    expect(result.analysis.batch_id).toBe('B2');
    expect(result.analysis.failures).toEqual([]);
    expect(result.qualityGate.dimensions.functional.e2e).toEqual({ total: 0, passed: 0, failed: 0 });
    expect(result.qualityGate.dimensions.non_functional).toBeUndefined();
    expect(result.qualityGate.final_status).toBe('PASS');
  });
});

describe('M3 execution summary', () => {
  it('uses quality gate status for final next step instead of API/E2E only', () => {
    const gate = buildQualityGate({
      changeId: 'R', batchId: 'B', apiResult: apiResult(0), e2eResult: e2eResult(0),
      coverageResult: coverageResult('PASS'), coverageGateMode: 'warn',
      fuzzResult: null, performanceResult: perfResult('FAIL'),
    });

    const md = buildSummaryMd('R', 'B', {
      api: apiResult(0),
      e2e: e2eResult(0),
      coverage: coverageResult('PASS'),
      fuzz: null,
      performance: perfResult('FAIL'),
      qualityGate: gate,
      selectedTargets: { api: true, e2e: true, fuzz: false, performance: true },
    });

    expect(md).toMatch(/Final Gate\s+\| FAIL/);
    expect(md).toMatch(/Performance\s+\| FAIL/);
    expect(md).toMatch(/Quality gate failed/);
    expect(md).not.toMatch(/All tests passed/);
  });
});

describe('M3 report_generator — fuzz line + non-functional chapter', () => {
  let projectRoot: string;
  beforeEach(() => { projectRoot = tmpDir('aws-m3-report-'); });
  afterEach(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

  it('renders Fuzz functional line and Non-Functional chapter, M3 weights applied', () => {
    const changeId = 'REQ-RPT-M3';
    const base = path.join(projectRoot, 'qa', 'changes', changeId);
    fs.mkdirSync(path.join(base, 'execution'), { recursive: true });
    fs.mkdirSync(path.join(base, 'inspect'), { recursive: true });

    // Build the gate via the real builder so it carries fuzz + non_functional.
    const gate = buildQualityGate({
      changeId, batchId: 'B1', apiResult: apiResult(0), e2eResult: null,
      coverageResult: null, coverageGateMode: 'warn',
      fuzzResult: fuzzResult(0), performanceResult: perfResult('PASS'),
    });

    fs.writeFileSync(path.join(base, 'execution', 'api-result.json'), JSON.stringify(apiResult(0)));
    fs.writeFileSync(path.join(base, 'inspect', 'quality-gate-result.json'), JSON.stringify(gate));
    fs.writeFileSync(path.join(base, 'inspect', 'failure-analysis.json'), JSON.stringify({
      schema_version: '1.0', change_id: changeId, batch_id: 'B1', source_batch_id: 'B1',
      final_status: 'PASS', inspect_mode: 'primary', classification_performed: true, status: 'no_failures',
      failures: [], hard_fails: [], needs_review: [],
    }));

    const result = generateReport({ changeId, projectRoot });
    expect(result.report.final_status).toBe('PASS');
    // All four dimensions perfect → 100.
    expect(result.report.quality_score).toBe(100);
    expect(result.report.score_breakdown.fuzz).not.toBe('N/A');
    expect(result.report.score_breakdown.performance).not.toBe('N/A');

    const md = fs.readFileSync(result.mdPath, 'utf-8');
    expect(md).toMatch(/- Fuzz: total=6/);
    expect(md).toMatch(/## Non-Functional \(Performance\)/);
    expect(md).toMatch(/checkout/);
  });
});

describe('M3 parseLocustStats', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir('aws-locust-'); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('parses request count, failure count, and 95% percentile by Name', () => {
    const csv = path.join(dir, 'locust_stats.csv');
    fs.writeFileSync(csv,
      'Type,Name,Request Count,Failure Count,Median Response Time,Average Response Time,Min Response Time,Max Response Time,Average Content Size,Requests/s,Failures/s,50%,66%,75%,80%,90%,95%,98%,99%\n' +
      'POST,checkout,100,2,300,310,100,900,512,10,0.2,300,320,340,360,400,420,500,600\n' +
      ',Aggregated,100,2,300,310,100,900,512,10,0.2,300,320,340,360,400,420,500,600\n',
    );
    const rows = parseLocustStats(csv);
    // Aggregated row excluded.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ name: 'checkout', requests: 100, failures: 2, p95: 420 });
  });
});

describe('M3 performance runner', () => {
  it('uses case load profile before .aws default_load', () => {
    const load = resolveLoadProfile([{
      capability: 'checkout',
      endpoint: 'POST /api/checkout',
      thresholds: { p95_ms: 800, error_rate_max: 0.01 },
      load: { users: 50, spawn_rate: 10, run_time_s: 60 },
    }], { users: 10, spawn_rate: 2, run_time_s: 30 });

    expect(load).toEqual({ users: 50, spawn_rate: 10, run_time_s: 60 });
  });

  it('buildScenarioVerdicts produces one verdict per scenario', () => {
    const scenarios = [
      { capability: 'role-list', endpoint: 'GET /roles', thresholds: { p95_ms: 200, error_rate_max: 0.01 }, load: { users: 10, spawn_rate: 2, run_time_s: 30 } },
      { capability: 'role-create', endpoint: 'POST /roles', thresholds: { p95_ms: 300, error_rate_max: 0.02 }, load: { users: 10, spawn_rate: 2, run_time_s: 30 } },
    ];
    const stats = new Map([
      ['role-list', { p95: 150, requests: 100, failures: 0 }],
      ['role-create', { p95: 400, requests: 50, failures: 1 }],
    ]);
    const verdicts = buildScenarioVerdicts(scenarios, stats);
    expect(verdicts).toHaveLength(2);
    expect(verdicts[0].verdict).toBe('PASS');
    expect(verdicts[1].verdict).toBe('FAIL');
  });

  it('mergeLocustStatsMaps keeps higher request count per name', () => {
    const merged = new Map<string, { p95: number; requests: number; failures: number }>();
    mergeLocustStatsMaps(merged, new Map([['checkout', { p95: 100, requests: 10, failures: 0 }]]));
    mergeLocustStatsMaps(merged, new Map([['checkout', { p95: 200, requests: 50, failures: 1 }]]));
    expect(merged.get('checkout')).toEqual({ p95: 200, requests: 50, failures: 1 });
  });

  it('parsePerformanceCase reads legacy flat thresholds + performance block', () => {
    const scenario = parsePerformanceCase({
      case_id: 'TC-PERF-001',
      type: 'Performance',
      thresholds: { p95_ms: 500, error_rate_max: 0.01 },
      performance: {
        capability: 'user-list-query',
        load: { users: 5, spawn_rate: 1, run_time: '30s' },
      },
    });
    expect(scenario).toEqual({
      capability: 'user-list-query',
      endpoint: '',
      thresholds: { p95_ms: 500, error_rate_max: 0.01 },
      load: { users: 5, spawn_rate: 1, run_time_s: 30 },
    });
  });

  it('loadPerformanceScenarios collects scenarios from stable cases: list', () => {
    const changeBase = tmpDir('aws-perf-scenarios-');
    const casesDir = path.join(changeBase, 'cases', 'users');
    fs.mkdirSync(casesDir, { recursive: true });
    fs.writeFileSync(path.join(casesDir, 'case.yaml'), [
      'cases:',
      '  - case_id: TC-ROLES-PERF-001',
      '    type: Performance',
      '    thresholds:',
      '      p95_ms: 500',
      '      error_rate_max: 0.01',
      '    performance:',
      '      capability: role-list-query',
    ].join('\n'));

    const scenarios = loadPerformanceScenarios(changeBase);
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0].capability).toBe('role-list-query');
    fs.rmSync(changeBase, { recursive: true, force: true });
  });
});
