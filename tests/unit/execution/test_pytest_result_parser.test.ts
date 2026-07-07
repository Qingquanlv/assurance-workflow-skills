import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parsePytestXml } from '../../../src/execution/result_parser';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aws-pytest-'));
}

describe('parsePytestXml', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('parses a passing test', () => {
    const xml = `<?xml version="1.0"?>
<testsuites>
  <testsuite name="tests/api/test_auth_api.py" tests="1" failures="0" skipped="0">
    <testcase classname="tests.api.test_auth_api" name="TC-USER-AUTH-001 test_user_logout_success" time="0.123"/>
  </testsuite>
</testsuites>`;
    const xmlPath = path.join(tmpDir, 'report.xml');
    const logPath = path.join(tmpDir, 'api.log');
    fs.writeFileSync(xmlPath, xml, 'utf-8');
    fs.writeFileSync(logPath, 'ok', 'utf-8');

    const result = parsePytestXml({ changeId: 'REQ-001', batchId: 'test-batch', junitXmlPath: xmlPath, rawLogPath: logPath, jsonReportPath: '', command: 'pytest' });

    expect(result.status).toBe('passed');
    expect(result.total).toBe(1);
    expect(result.passed).toBe(1);
    expect(result.cases[0].case_id).toBe('TC_USER_AUTH_001');
    expect(result.source.framework).toBe('pytest');
  });

  it('parses a failing test', () => {
    const xml = `<?xml version="1.0"?>
<testsuites>
  <testsuite tests="1" failures="1">
    <testcase classname="tests.api.test_auth" name="TC-USER-AUTH-002 test_login" time="0.5">
      <failure message="AssertionError: expected 200, got 401">assert 200 == 401</failure>
    </testcase>
  </testsuite>
</testsuites>`;
    const xmlPath = path.join(tmpDir, 'r.xml');
    const logPath = path.join(tmpDir, 'a.log');
    fs.writeFileSync(xmlPath, xml, 'utf-8');
    fs.writeFileSync(logPath, 'FAILED', 'utf-8');

    const result = parsePytestXml({ changeId: 'REQ-001', batchId: 'test-batch', junitXmlPath: xmlPath, rawLogPath: logPath, jsonReportPath: '', command: 'pytest' });

    expect(result.status).toBe('failed');
    expect(result.failed).toBe(1);
    expect(result.cases[0].status).toBe('failed');
    expect(result.cases[0].message).toBeTruthy();
  });

  it('parses a skipped test', () => {
    const xml = `<?xml version="1.0"?>
<testsuites>
  <testsuite tests="1" skipped="1">
    <testcase classname="tests.api.test_order" name="TC-ORDER-001 test_order_flow" time="0.01">
      <skipped message="skip reason"/>
    </testcase>
  </testsuite>
</testsuites>`;
    const xmlPath = path.join(tmpDir, 'r.xml');
    const logPath = path.join(tmpDir, 'a.log');
    fs.writeFileSync(xmlPath, xml, 'utf-8');
    fs.writeFileSync(logPath, '', 'utf-8');

    const result = parsePytestXml({ changeId: 'REQ-001', batchId: 'test-batch', junitXmlPath: xmlPath, rawLogPath: logPath, jsonReportPath: '', command: 'pytest' });

    expect(result.skipped).toBe(1);
    expect(result.cases[0].status).toBe('skipped');
  });

  it('returns status=skipped when XML does not exist', () => {
    const result = parsePytestXml({ changeId: 'REQ-001', batchId: 'test-batch', junitXmlPath: path.join(tmpDir, 'nonexistent.xml'), rawLogPath: path.join(tmpDir, 'a.log'), jsonReportPath: '', command: 'pytest' });
    expect(result.status).toBe('skipped');
    expect(result.total).toBe(0);
  });

  it('puts tests without Case ID into unmapped_tests', () => {
    const xml = `<?xml version="1.0"?>
<testsuites>
  <testsuite tests="2">
    <testcase classname="tests.api.misc" name="TC-MISC-001 test_with_id" time="0.1"/>
    <testcase classname="tests.api.misc" name="test_without_case_id" time="0.1"/>
  </testsuite>
</testsuites>`;
    const xmlPath = path.join(tmpDir, 'r.xml');
    const logPath = path.join(tmpDir, 'a.log');
    fs.writeFileSync(xmlPath, xml, 'utf-8');
    fs.writeFileSync(logPath, '', 'utf-8');

    const result = parsePytestXml({ changeId: 'REQ-001', batchId: 'test-batch', junitXmlPath: xmlPath, rawLogPath: logPath, jsonReportPath: '', command: 'pytest' });

    expect(result.cases.length).toBe(1);
    expect(result.unmapped_tests.length).toBe(1);
    expect(result.unmapped_tests[0].test_name).toBe('test_without_case_id');
  });
});
