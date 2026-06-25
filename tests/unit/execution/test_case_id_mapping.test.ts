import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parsePytestXml } from '../../../src/execution/result_parser';

describe('Case ID mapping', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-caseid-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function runParser(testName: string) {
    const xml = `<?xml version="1.0"?><testsuites><testsuite tests="1"><testcase classname="tests.api.x" name="${testName}" time="0.1"/></testsuite></testsuites>`;
    const xmlPath = path.join(tmpDir, 'r.xml');
    const logPath = path.join(tmpDir, 'l.log');
    fs.writeFileSync(xmlPath, xml, 'utf-8');
    fs.writeFileSync(logPath, '', 'utf-8');
    return parsePytestXml({ changeId: 'REQ-001', batchId: 'test-batch', junitXmlPath: xmlPath, rawLogPath: logPath, jsonReportPath: '', command: 'pytest' });
  }

  it('extracts Case ID from test title prefix', () => {
    const result = runParser('TC-USER-AUTH-001 test_user_login');
    expect(result.cases[0].case_id).toBe('TC_USER_AUTH_001');
  });

  it('extracts Case ID embedded in test name with space separator', () => {
    const result = runParser('test_flow_for TC-ORDER-005 checkout');
    expect(result.cases[0].case_id).toBe('TC_ORDER_005');
  });

  it('extracts underscore case_id from lowercase function-name prefix (double-underscore delimiter)', () => {
    const result = runParser('test_tc_role_api_001__role_list_happy_path');
    expect(result.cases[0].case_id).toBe('TC_ROLE_API_001');
  });

  it('does not swallow a numeric description suffix after the double-underscore delimiter', () => {
    const result = runParser('test_tc_role_api_009__list_without_token_returns_401');
    expect(result.cases[0].case_id).toBe('TC_ROLE_API_009');
  });

  it('does not swallow description words from older single-underscore function names', () => {
    const result = runParser('test_tc_role_api_001_role_list_happy_path');
    expect(result.cases[0].case_id).toBe('TC_ROLE_API_001');
  });

  it('extracts underscore case_id from a locust task name (no test_ prefix)', () => {
    const result = runParser('tc_role_perf_001__list_roles');
    expect(result.cases[0].case_id).toBe('TC_ROLE_PERF_001');
  });

  it('uppercase-normalizes a case_id taken from JUnit properties (matches name-derived casing)', () => {
    const xml = `<?xml version="1.0"?><testsuites><testsuite tests="1"><testcase classname="tests.api.x" name="test_generic_no_prefix" time="0.1"><properties><property name="case_id" value="tc-menu-001"/></properties></testcase></testsuite></testsuites>`;
    const xmlPath = path.join(tmpDir, 'r.xml');
    const logPath = path.join(tmpDir, 'l.log');
    fs.writeFileSync(xmlPath, xml, 'utf-8');
    fs.writeFileSync(logPath, '', 'utf-8');
    const result = parsePytestXml({ changeId: 'REQ-001', batchId: 'test-batch', junitXmlPath: xmlPath, rawLogPath: logPath, jsonReportPath: '', command: 'pytest' });
    expect(result.cases[0].case_id).toBe('TC_MENU_001');
  });

  it('puts test with no Case ID into unmapped_tests', () => {
    const result = runParser('test_generic_login_flow');
    expect(result.unmapped_tests.length).toBe(1);
    expect(result.cases.length).toBe(0);
  });

  it('does not drop unmapped tests', () => {
    const xml = `<?xml version="1.0"?><testsuites><testsuite tests="3">
      <testcase classname="tests.api.x" name="TC-A-001 test_a" time="0.1"/>
      <testcase classname="tests.api.x" name="test_no_id_1" time="0.1"/>
      <testcase classname="tests.api.x" name="test_no_id_2" time="0.1"/>
    </testsuite></testsuites>`;
    const xmlPath = path.join(tmpDir, 'r.xml');
    const logPath = path.join(tmpDir, 'l.log');
    fs.writeFileSync(xmlPath, xml, 'utf-8');
    fs.writeFileSync(logPath, '', 'utf-8');

    const result = parsePytestXml({ changeId: 'REQ-001', batchId: 'test-batch', junitXmlPath: xmlPath, rawLogPath: logPath, jsonReportPath: '', command: 'pytest' });

    expect(result.cases.length + result.unmapped_tests.length).toBe(3);
    expect(result.unmapped_tests.length).toBe(2);
  });
});
