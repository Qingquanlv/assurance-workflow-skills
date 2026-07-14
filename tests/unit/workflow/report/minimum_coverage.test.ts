import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { ApiResult, E2eResult } from '../../../../src/workflow/core/types';
import { buildMinimumCoverageResult } from '../../../../src/workflow/report/minimum_coverage';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('minimum required coverage report', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = tmpDir('aws-mrc-');
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('normalizes legacy advisory MRC strings and classifies execution by case_id', () => {
    const changeId = 'REQ-MRC-001';
    const base = path.join(projectRoot, 'qa', 'changes', changeId);
    fs.mkdirSync(path.join(base, 'risk-advisory'), { recursive: true });
    fs.mkdirSync(path.join(base, 'cases', 'api'), { recursive: true });

    fs.writeFileSync(path.join(base, 'risk-advisory', 'advisory.json'), JSON.stringify({
      schema_version: '1.0',
      change_id: changeId,
      minimum_required_coverage: {
        api: ['list_api', 'delete_api'],
        data_integrity: ['refresh_orphan_preservation'],
      },
    }));

    fs.writeFileSync(path.join(base, 'cases', 'api', 'case.yaml'), yaml.dump({
      schema_version: '1.0',
      added: [
        {
          case_id: 'TC_API_001',
          title: 'API list returns page',
          type: 'API',
          tags: ['api-list'],
          trace: { minimum_required_coverage: ['MRC-API-001'] },
        },
        {
          case_id: 'TC_API_013',
          title: 'refresh preserves orphan ideal behavior',
          type: 'API',
          tags: ['refresh', 'ideal'],
          trace: { minimum_required_coverage: ['MRC-DATA-INTEGRITY-001'] },
        },
      ],
    }));

    const apiResult: ApiResult = {
      schema_version: '1.0',
      change_id: changeId,
      batch_id: 'B1',
      target: 'api',
      status: 'passed',
      command: '',
      source: { framework: 'pytest', raw_log: '', junit_xml: '', json_report: '' },
      total: 2,
      passed: 1,
      failed: 0,
      skipped: 1,
      cases: [
        { case_id: 'TC_API_001', status: 'passed', file: 'tests/api/test_api.py', test_name: 'test_tc_api_001__api_list', duration_ms: 1, message: '', raw_log_ref: '' },
        { case_id: 'TC_API_013', status: 'skipped', file: 'tests/api/test_api.py', test_name: 'test_tc_api_013__refresh_orphan_ideal', duration_ms: 1, message: 'xfail known issue PH-002', raw_log_ref: '' },
      ],
      unmapped_tests: [],
    };
    const result = buildMinimumCoverageResult({ changeId, projectRoot, apiResult, e2eResult: null });

    expect(result.summary.total_required).toBe(3);
    expect(result.summary.covered).toBe(1);
    expect(result.summary.covered_known_issue).toBe(1);
    expect(result.summary.missing).toBe(1);
    expect(result.items.find(i => i.key === 'list_api')?.status).toBe('covered');
    expect(result.items.find(i => i.key === 'refresh_orphan_preservation')?.status).toBe('covered_known_issue');
    expect(result.items.find(i => i.key === 'delete_api')?.status).toBe('missing');
  });

  it('uses heuristic mapping when legacy cases lack explicit MRC trace', () => {
    const changeId = 'REQ-MRC-HEURISTIC';
    const base = path.join(projectRoot, 'qa', 'changes', changeId);
    fs.mkdirSync(path.join(base, 'risk-advisory'), { recursive: true });
    fs.mkdirSync(path.join(base, 'cases', 'api'), { recursive: true });

    fs.writeFileSync(path.join(base, 'risk-advisory', 'advisory.json'), JSON.stringify({
      schema_version: '1.0',
      change_id: changeId,
      minimum_required_coverage: { api: ['list_api'] },
    }));
    fs.writeFileSync(path.join(base, 'cases', 'api', 'case.yaml'), yaml.dump({
      added: [{ case_id: 'TC_API_001', title: 'API 列表分页返回正确结构', type: 'API', tags: ['api-list'], trace: {} }],
    }));
    const apiResult: ApiResult = {
      schema_version: '1.0', change_id: changeId, batch_id: 'B1', target: 'api', status: 'passed', command: '',
      source: { framework: 'pytest', raw_log: '', junit_xml: '', json_report: '' },
      total: 1, passed: 1, failed: 0, skipped: 0,
      cases: [{ case_id: 'TC_API_001', status: 'passed', file: '', test_name: 'test_tc_api_001__api_list_pagination_structure', duration_ms: 1, message: '', raw_log_ref: '' }],
      unmapped_tests: [],
    };

    const result = buildMinimumCoverageResult({ changeId, projectRoot, apiResult, e2eResult: null });

    expect(result.items[0].mapping_source).toBe('heuristic');
    expect(result.items[0].status).toBe('covered');
  });
});
