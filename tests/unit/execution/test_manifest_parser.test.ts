import * as path from 'path';
import {
  normalizeExecutionManifest,
  toExecutionRelativePath,
} from '../../../src/execution/manifest_parser';

describe('manifest_parser', () => {
  const executionDir = '/project/qa/changes/REQ-001/execution';

  it('normalises CLI map-shaped result_files', () => {
    const manifest = normalizeExecutionManifest({
      schema_version: '1.0',
      change_id: 'REQ-001',
      batch_id: '20260615-120000',
      selected_targets: { api: true, e2e: false, fuzz: true, performance: false },
      result_files: {
        api: 'runs/20260615-120000/api-result.json',
        fuzz: 'runs/20260615-120000/fuzz-result.json',
        coverage: 'runs/20260615-120000/coverage-result.json',
      },
    }, executionDir);

    expect(manifest).toEqual({
      schema_version: '1.0',
      change_id: 'REQ-001',
      batch_id: '20260615-120000',
      selected_targets: { api: true, e2e: false, fuzz: true, performance: false },
      result_files: {
        api: 'runs/20260615-120000/api-result.json',
        fuzz: 'runs/20260615-120000/fuzz-result.json',
        coverage: 'runs/20260615-120000/coverage-result.json',
      },
    });
  });

  it('normalises skill extended format with primary_runner.result_files array', () => {
    const manifest = normalizeExecutionManifest({
      schema_version: '1.0',
      change_id: '20260615-role-mgmt',
      batch_id: '20260615-182414',
      primary_runner: {
        command: 'aws run --change 20260615-role-mgmt',
        status: 'failed',
        result_files: [
          'qa/changes/20260615-role-mgmt/execution/runs/20260615-182414/api-result.json',
          'qa/changes/20260615-role-mgmt/execution/runs/20260615-182414/e2e-result.json',
          'qa/changes/20260615-role-mgmt/execution/runs/20260615-182414/fuzz-result.json',
          'qa/changes/20260615-role-mgmt/execution/runs/20260615-182414/summary.md',
        ],
      },
      selected_targets: { api: true, e2e: true, fuzz: true, performance: false },
      final_status: 'FAIL',
      warnings: ['skill-authored manifest'],
    }, executionDir);

    expect(manifest?.batch_id).toBe('20260615-182414');
    expect(manifest?.result_files).toEqual({
      api: 'runs/20260615-182414/api-result.json',
      e2e: 'runs/20260615-182414/e2e-result.json',
      fuzz: 'runs/20260615-182414/fuzz-result.json',
      summary: 'runs/20260615-182414/summary.md',
    });
  });

  it('prefers top-level result_files map over primary_runner array', () => {
    const manifest = normalizeExecutionManifest({
      schema_version: '1.0',
      change_id: 'REQ-001',
      batch_id: 'B1',
      selected_targets: { api: true, e2e: false, fuzz: false, performance: false },
      result_files: { api: 'runs/B1/api-result.json' },
      primary_runner: {
        result_files: ['qa/changes/REQ-001/execution/runs/B1/e2e-result.json'],
      },
    }, executionDir);

    expect(manifest?.result_files).toEqual({ api: 'runs/B1/api-result.json' });
  });

  it('returns null when batch_id or selected_targets missing', () => {
    expect(normalizeExecutionManifest({ change_id: 'X' }, executionDir)).toBeNull();
    expect(normalizeExecutionManifest({ batch_id: 'B1' }, executionDir)).toBeNull();
  });

  it('toExecutionRelativePath handles absolute paths under execution dir', () => {
    const abs = path.join(executionDir, 'runs/B1/api-result.json');
    expect(toExecutionRelativePath(abs, executionDir)).toBe('runs/B1/api-result.json');
  });
});
