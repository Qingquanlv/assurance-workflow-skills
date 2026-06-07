import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parsePytestXml } from '../../../src/execution/result_parser';

describe('Case ID mapping', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awe-caseid-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function runParser(testName: string) {
    const xml = `<?xml version="1.0"?><testsuites><testsuite tests="1"><testcase classname="tests.api.x" name="${testName}" time="0.1"/></testsuite></testsuites>`;
    const xmlPath = path.join(tmpDir, 'r.xml');
    const logPath = path.join(tmpDir, 'l.log');
    fs.writeFileSync(xmlPath, xml, 'utf-8');
    fs.writeFileSync(logPath, '', 'utf-8');
    return parsePytestXml({ changeId: 'REQ-001', junitXmlPath: xmlPath, rawLogPath: logPath, jsonReportPath: '', command: 'pytest' });
  }

  it('extracts Case ID from test title prefix', () => {
    const result = runParser('TC-USER-AUTH-001 test_user_login');
    expect(result.cases[0].case_id).toBe('TC-USER-AUTH-001');
  });

  it('extracts Case ID embedded in test name with space separator', () => {
    const result = runParser('test_flow_for TC-ORDER-005 checkout');
    expect(result.cases[0].case_id).toBe('TC-ORDER-005');
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

    const result = parsePytestXml({ changeId: 'REQ-001', junitXmlPath: xmlPath, rawLogPath: logPath, jsonReportPath: '', command: 'pytest' });

    expect(result.cases.length + result.unmapped_tests.length).toBe(3);
    expect(result.unmapped_tests.length).toBe(2);
  });
});
