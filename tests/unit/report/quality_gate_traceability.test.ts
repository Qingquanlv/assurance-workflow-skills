import { buildQualityGate } from '../../../src/report/quality_gate';
import { ApiCaseResult, ApiResult } from '../../../src/core/types';

function apiCase(caseId: string, testName: string): ApiCaseResult {
  return {
    case_id: caseId,
    status: 'passed',
    file: 'tests/api/test_sample.py',
    test_name: testName,
    duration_ms: 10,
    message: '',
    raw_log_ref: 'raw/api.log',
  };
}

function apiResult(cases: ApiCaseResult[], unmapped: ApiCaseResult[]): ApiResult {
  const all = [...cases, ...unmapped];
  return {
    schema_version: '1.0',
    change_id: 'REQ-TRACE-001',
    batch_id: '20260707-000000',
    target: 'api',
    status: 'passed',
    command: 'pytest',
    source: { framework: 'pytest', raw_log: '', junit_xml: '', json_report: '' },
    total: all.length,
    passed: all.length,
    failed: 0,
    skipped: 0,
    cases,
    unmapped_tests: unmapped,
  };
}

describe('quality gate traceability', () => {
  it('caps a green run at PASS_WITH_WARNINGS when executed tests are unmapped', () => {
    const gate = buildQualityGate({
      changeId: 'REQ-TRACE-001',
      batchId: '20260707-000000',
      apiResult: apiResult([], [apiCase('', 'test_admin_list_users'), apiCase('', 'test_admin_get_user')]),
      e2eResult: null,
      coverageResult: null,
      coverageGateMode: 'warn',
    });

    expect(gate.dimensions.functional.status).toBe('PASS_WITH_WARNINGS');
    expect(gate.dimensions.functional.unmapped_tests).toBe(2);
    expect(gate.final_status).toBe('PASS_WITH_WARNINGS');
    expect(gate.warnings?.[0]).toMatch(/TRACEABILITY-BROKEN: 2 executed test/);
  });

  it('reports clean PASS when every executed test maps to a case id', () => {
    const gate = buildQualityGate({
      changeId: 'REQ-TRACE-001',
      batchId: '20260707-000000',
      apiResult: apiResult([apiCase('TC_USER_API_001', 'test_tc_user_api_001__list_users')], []),
      e2eResult: null,
      coverageResult: null,
      coverageGateMode: 'warn',
    });

    expect(gate.dimensions.functional.status).toBe('PASS');
    expect(gate.dimensions.functional.unmapped_tests).toBeUndefined();
    expect(gate.final_status).toBe('PASS');
    expect(gate.warnings).toBeUndefined();
  });

  it('does not count synthetic placeholders from targets that never ran', () => {
    const gate = buildQualityGate({
      changeId: 'REQ-TRACE-001',
      batchId: '20260707-000000',
      apiResult: {
        ...apiResult([], [apiCase('', 'JUnit XML report not found')]),
        status: 'skipped',
        total: 0,
        passed: 0,
      },
      e2eResult: null,
      coverageResult: null,
      coverageGateMode: 'warn',
    });

    expect(gate.dimensions.functional.status).toBe('SKIPPED');
    expect(gate.dimensions.functional.unmapped_tests).toBeUndefined();
    expect(gate.warnings).toBeUndefined();
  });
});
