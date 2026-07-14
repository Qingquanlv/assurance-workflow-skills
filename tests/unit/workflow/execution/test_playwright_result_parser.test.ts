import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parsePlaywrightJson } from '../../../../src/workflow/execution/result_parser';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aws-pw-'));
}

describe('parsePlaywrightJson', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function opts(jsonPath: string) {
    return { changeId: 'REQ-E2E-001', batchId: 'test-batch', jsonReportPath: jsonPath, rawLogPath: path.join(tmpDir, 'e2e.log'), htmlReportPath: path.join(tmpDir, 'pw-html'), executionDir: tmpDir, command: 'npx playwright test' };
  }

  it('parses a passing test', () => {
    const json = JSON.stringify({ suites: [{ file: 'tests/e2e/order.spec.ts', title: 'Order', tests: [{ title: 'TC-ORDER-001 receive order', results: [{ status: 'passed', duration: 1234, attachments: [] }] }] }] });
    const jsonPath = path.join(tmpDir, 'pw.json');
    fs.writeFileSync(jsonPath, json, 'utf-8');

    const result = parsePlaywrightJson(opts(jsonPath));

    expect(result.status).toBe('passed');
    expect(result.cases[0].case_id).toBe('TC_ORDER_001');
    expect(result.cases[0].duration_ms).toBe(1234);
    expect(result.source.framework).toBe('playwright');
  });

  it('parses a failing test and preserves trace path', () => {
    const tracePath = path.join(tmpDir, 'traces', 'TC-ORDER-002.zip');
    fs.mkdirSync(path.join(tmpDir, 'traces'), { recursive: true });
    fs.writeFileSync(tracePath, 'fake', 'utf-8');

    const json = JSON.stringify({ suites: [{ file: 'tests/e2e/order.spec.ts', tests: [{ title: 'TC-ORDER-002 fail', results: [{ status: 'failed', duration: 5000, error: { message: 'locator not found' }, attachments: [{ name: 'trace', path: tracePath, contentType: 'application/zip' }] }] }] }] });
    const jsonPath = path.join(tmpDir, 'pw.json');
    fs.writeFileSync(jsonPath, json, 'utf-8');

    const result = parsePlaywrightJson(opts(jsonPath));

    expect(result.status).toBe('failed');
    expect(result.cases[0].trace).toBe(tracePath);
  });

  it('returns status=skipped when JSON file does not exist', () => {
    const result = parsePlaywrightJson(opts(path.join(tmpDir, 'nonexistent.json')));
    expect(result.status).toBe('skipped');
    expect(result.total).toBe(0);
  });

  it('puts test without Case ID into unmapped_tests', () => {
    const json = JSON.stringify({ suites: [{ file: 'tests/e2e/misc.spec.ts', tests: [{ title: 'TC-MISC-001 mapped', results: [{ status: 'passed', duration: 100 }] }, { title: 'some test without id', results: [{ status: 'passed', duration: 100 }] }] }] });
    const jsonPath = path.join(tmpDir, 'pw.json');
    fs.writeFileSync(jsonPath, json, 'utf-8');

    const result = parsePlaywrightJson(opts(jsonPath));

    expect(result.cases.length).toBe(1);
    expect(result.unmapped_tests.length).toBe(1);
  });
});
