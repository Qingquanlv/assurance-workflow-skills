import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { inspect } from '../../src/report/inspector';
import { ApiResult, E2eResult } from '../../src/core/types';

function makeTmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'awe-inspect-'));
}

function makeExecDir(projectRoot: string, changeId: string): string {
  const execDir = path.join(projectRoot, 'qa', 'changes', changeId, 'execution');
  ['raw', 'traces', 'screenshots', 'videos'].forEach(d => fs.mkdirSync(path.join(execDir, d), { recursive: true }));
  return execDir;
}

describe('awe report inspect integration', () => {
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
    const apiResult: ApiResult = { schema_version: '1.0', change_id: changeId, target: 'api', status: 'passed', command: 'pytest', source: { framework: 'pytest', raw_log: '', junit_xml: '', json_report: '' }, total: 1, passed: 1, failed: 0, skipped: 0, cases: [{ case_id: 'TC-A-001', status: 'passed', file: '', test_name: 'test_a', duration_ms: 100, message: '', raw_log_ref: '' }], unmapped_tests: [] };
    const e2eResult: E2eResult = { schema_version: '1.0', change_id: changeId, target: 'e2e', status: 'passed', command: 'npx playwright test', source: { framework: 'playwright', raw_log: '', json_report: '', html_report: '' }, total: 1, passed: 1, failed: 0, skipped: 0, cases: [{ case_id: 'TC-B-001', status: 'passed', file: '', test_name: 'test_b', duration_ms: 200, message: '', trace: '', screenshot: '', video: '' }], unmapped_tests: [] };
    fs.writeFileSync(path.join(execDir, 'api-result.json'), JSON.stringify(apiResult), 'utf-8');
    fs.writeFileSync(path.join(execDir, 'e2e-result.json'), JSON.stringify(e2eResult), 'utf-8');

    const result = inspect({ changeId, projectRoot });
    expect(result.analysis.status).toBe('no_failures');
    expect(result.analysis.failures.length).toBe(0);
  });

  it('classifies e2e locator failure and sets fix_proposal_allowed=true', () => {
    const execDir = makeExecDir(projectRoot, changeId);
    const e2eResult: E2eResult = { schema_version: '1.0', change_id: changeId, target: 'e2e', status: 'failed', command: 'npx playwright test', source: { framework: 'playwright', raw_log: path.join(execDir, 'raw', 'e2e.log'), json_report: '', html_report: '' }, total: 1, passed: 0, failed: 1, skipped: 0, cases: [{ case_id: 'TC-C-001', status: 'failed', file: 'tests/e2e/checkout.spec.ts', test_name: 'TC-C-001 checkout', duration_ms: 3000, message: 'Locator not found: button[data-testid=pay]', trace: '', screenshot: '', video: '' }], unmapped_tests: [] };
    fs.writeFileSync(path.join(execDir, 'e2e-result.json'), JSON.stringify(e2eResult), 'utf-8');
    fs.writeFileSync(path.join(execDir, 'raw', 'e2e.log'), 'Locator not found', 'utf-8');

    const result = inspect({ changeId, projectRoot });
    expect(result.analysis.failures[0].category).toBe('locator_failure');
    expect(result.analysis.failures[0].fix_proposal_allowed).toBe(true);
    expect(result.analysis.failures[0].evidence).toBeDefined();
    expect(result.analysis.failures[0].case_id).toBe('TC-C-001');
  });

  it('failure-analysis.json has required schema fields', () => {
    const execDir = makeExecDir(projectRoot, changeId);
    const apiResult: ApiResult = { schema_version: '1.0', change_id: changeId, target: 'api', status: 'failed', command: 'pytest', source: { framework: 'pytest', raw_log: '', junit_xml: '', json_report: '' }, total: 1, passed: 0, failed: 1, skipped: 0, cases: [{ case_id: 'TC-D-001', status: 'failed', file: 'tests/api/test_d.py', test_name: 'TC-D-001 test_d', duration_ms: 50, message: 'AssertionError: expected 200, got 404', raw_log_ref: '' }], unmapped_tests: [] };
    fs.writeFileSync(path.join(execDir, 'api-result.json'), JSON.stringify(apiResult), 'utf-8');

    inspect({ changeId, projectRoot });
    const analysis = JSON.parse(fs.readFileSync(path.join(execDir, 'failure-analysis.json'), 'utf-8'));

    expect(analysis.schema_version).toBe('1.0');
    expect(analysis.change_id).toBe(changeId);
    expect(Array.isArray(analysis.failures)).toBe(true);
    expect(analysis.failures[0].case_id).toBeTruthy();
    expect(analysis.failures[0].category).toBeTruthy();
    expect(analysis.failures[0].evidence).toBeDefined();
  });

  it('failure-summary.md is written with correct heading', () => {
    const execDir = makeExecDir(projectRoot, changeId);
    const apiResult: ApiResult = { schema_version: '1.0', change_id: changeId, target: 'api', status: 'passed', command: 'pytest', source: { framework: 'pytest', raw_log: '', junit_xml: '', json_report: '' }, total: 0, passed: 0, failed: 0, skipped: 0, cases: [], unmapped_tests: [] };
    fs.writeFileSync(path.join(execDir, 'api-result.json'), JSON.stringify(apiResult), 'utf-8');

    const result = inspect({ changeId, projectRoot });
    const summary = fs.readFileSync(result.summaryPath, 'utf-8');
    expect(summary).toContain(changeId);
    expect(summary).toContain('Failure Analysis Summary');
  });
});
