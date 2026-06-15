import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildQualityGate } from '../../src/report/quality_gate';
import { computeQualityScore } from '../../src/report/quality_score';
import { inspect } from '../../src/report/inspector';
import { generateReport } from '../../src/report/report_generator';
import { parseLocustStats } from '../../src/execution/locust_runner';
import {
  ApiResult,
  FuzzResult,
  PerformanceResult,
} from '../../src/core/types';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const apiResult = (failed: number): ApiResult => ({
  schema_version: '1.0', change_id: 'R', batch_id: 'B', target: 'api', status: failed ? 'failed' : 'passed',
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
