import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
  loadExecutionEvidence,
  publishExecutionEvidence,
} from '../../../src/execution/evidence';

describe('Execution Evidence', () => {
  let root: string;
  let executionDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-execution-evidence-'));
    executionDir = path.join(root, 'execution');
    fs.mkdirSync(path.join(executionDir, 'runs', 'B1'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('loads the manifest-selected batch as the authoritative evidence', () => {
    const manifest = {
      schema_version: '1.0',
      change_id: 'REQ-001',
      batch_id: 'B1',
      selected_targets: { api: true, e2e: false, fuzz: false, performance: false },
      result_files: {
        api: 'runs/B1/api-result.json',
        coverage: 'runs/B1/coverage-result.json',
      },
      tests_tree_sha256: 'tests-hash',
      test_files_sha256: { 'tests/api.py': 'test-file-hash' },
      product_tree_sha256: 'product-hash',
      final_status: 'PASS',
    };
    fs.writeFileSync(
      path.join(executionDir, 'execution-manifest.yaml'),
      yaml.dump(manifest),
    );
    fs.writeFileSync(
      path.join(executionDir, 'runs', 'B1', 'api-result.json'),
      JSON.stringify({ batch_id: 'B1', target: 'api', status: 'passed' }),
    );
    fs.writeFileSync(
      path.join(executionDir, 'runs', 'B1', 'coverage-result.json'),
      JSON.stringify({ batch_id: 'B1', kind: 'coverage', status: 'PASS' }),
    );

    const evidence = loadExecutionEvidence(executionDir);

    expect(evidence).toMatchObject({
      mode: 'primary',
      batchId: 'B1',
      manifest,
      selectedTargets: manifest.selected_targets,
      apiResult: { batch_id: 'B1', target: 'api', status: 'passed' },
      coverageResult: { batch_id: 'B1', kind: 'coverage', status: 'PASS' },
      integrityIssues: [],
    });
  });

  it('falls back to latest pointer files when no manifest is available', () => {
    fs.writeFileSync(
      path.join(executionDir, 'api-result.json'),
      JSON.stringify({ batch_id: 'LEGACY-1', target: 'api', status: 'failed' }),
    );
    fs.writeFileSync(
      path.join(executionDir, 'quality-gate-result.json'),
      JSON.stringify({ batch_id: 'LEGACY-1', final_status: 'FAIL' }),
    );

    const evidence = loadExecutionEvidence(executionDir);

    expect(evidence).toMatchObject({
      mode: 'compat',
      batchId: 'LEGACY-1',
      manifest: null,
      resultRoot: executionDir,
      apiResult: { batch_id: 'LEGACY-1', target: 'api', status: 'failed' },
      qualityGate: { batch_id: 'LEGACY-1', final_status: 'FAIL' },
    });
  });

  it('preserves legacy manifest metadata while routing results in compat mode', () => {
    fs.writeFileSync(
      path.join(executionDir, 'execution-manifest.yaml'),
      yaml.dump({
        batch_id: 'LEGACY-BATCH',
        tests_tree_sha256: 'tests-hash',
        test_files_sha256: { 'tests/api.py': 'file-hash' },
        final_status: 'FAIL',
      }),
    );
    fs.writeFileSync(
      path.join(executionDir, 'api-result.json'),
      JSON.stringify({
        batch_id: 'LEGACY-POINTER',
        target: 'api',
        status: 'failed',
      }),
    );

    const evidence = loadExecutionEvidence(executionDir);

    expect(evidence).toMatchObject({
      mode: 'compat',
      batchId: 'LEGACY-POINTER',
      resultRoot: executionDir,
      apiResult: {
        batch_id: 'LEGACY-POINTER',
        target: 'api',
        status: 'failed',
      },
      selectedTargets: {
        api: true,
        e2e: true,
        fuzz: true,
        performance: true,
      },
      manifest: {
        batch_id: 'LEGACY-BATCH',
        tests_tree_sha256: 'tests-hash',
        test_files_sha256: { 'tests/api.py': 'file-hash' },
        final_status: 'FAIL',
      },
    });
  });

  it('fails closed when a manifest exists but is malformed', () => {
    fs.writeFileSync(
      path.join(executionDir, 'execution-manifest.yaml'),
      'batch_id: [not-valid',
    );
    fs.writeFileSync(
      path.join(executionDir, 'api-result.json'),
      JSON.stringify({ batch_id: 'STALE', target: 'api', status: 'passed' }),
    );

    expect(() => loadExecutionEvidence(executionDir)).toThrow(
      /EXECUTION-MANIFEST-INVALID/,
    );
  });

  it('accepts a batch-matched latest gate when the batch gate is absent', () => {
    fs.writeFileSync(
      path.join(executionDir, 'execution-manifest.yaml'),
      yaml.dump({
        batch_id: 'B1',
        selected_targets: {
          api: false,
          e2e: false,
          fuzz: false,
          performance: false,
        },
        final_status: 'PASS',
      }),
    );
    fs.writeFileSync(
      path.join(executionDir, 'quality-gate-result.json'),
      JSON.stringify({ batch_id: 'B1', final_status: 'PASS_WITH_WARNINGS' }),
    );

    const evidence = loadExecutionEvidence(executionDir);

    expect(evidence.qualityGate).toMatchObject({
      batch_id: 'B1',
      final_status: 'PASS_WITH_WARNINGS',
    });
  });

  it('rejects stale gates that do not belong to the manifest batch', () => {
    fs.writeFileSync(
      path.join(executionDir, 'execution-manifest.yaml'),
      yaml.dump({
        batch_id: 'B1',
        selected_targets: {
          api: false,
          e2e: false,
          fuzz: false,
          performance: false,
        },
        final_status: 'PASS',
      }),
    );
    fs.writeFileSync(
      path.join(executionDir, 'runs', 'B1', 'quality-gate-result.json'),
      JSON.stringify({ batch_id: 'OLD', final_status: 'PASS' }),
    );
    fs.writeFileSync(
      path.join(executionDir, 'quality-gate-result.json'),
      JSON.stringify({ batch_id: 'OLDER', final_status: 'PASS' }),
    );

    expect(loadExecutionEvidence(executionDir).qualityGate).toBeNull();
  });

  it('reports an unreadable selected target as a primary evidence integrity issue', () => {
    const manifest = {
      schema_version: '1.0',
      change_id: 'REQ-001',
      batch_id: 'B1',
      selected_targets: { api: false, e2e: true, fuzz: false, performance: false },
      result_files: { e2e: 'runs/B1/e2e-result.json' },
      final_status: 'PASS',
    };
    fs.writeFileSync(
      path.join(executionDir, 'execution-manifest.yaml'),
      yaml.dump(manifest),
    );
    fs.writeFileSync(
      path.join(executionDir, 'runs', 'B1', 'e2e-result.json'),
      '{not-json',
    );

    const evidence = loadExecutionEvidence(executionDir);

    expect(evidence.integrityIssues).toEqual([
      {
        target: 'e2e',
        path: path.join(executionDir, 'runs', 'B1', 'e2e-result.json'),
        batchId: 'B1',
      },
    ]);
  });

  it('rejects a selected result whose batch does not match the manifest', () => {
    fs.writeFileSync(
      path.join(executionDir, 'execution-manifest.yaml'),
      yaml.dump({
        batch_id: 'B1',
        selected_targets: {
          api: true,
          e2e: false,
          fuzz: false,
          performance: false,
        },
        result_files: { api: 'runs/B1/api-result.json' },
      }),
    );
    fs.writeFileSync(
      path.join(executionDir, 'runs', 'B1', 'api-result.json'),
      JSON.stringify({ batch_id: 'OLD', target: 'api', status: 'passed' }),
    );

    const evidence = loadExecutionEvidence(executionDir);

    expect(evidence.apiResult).toBeNull();
    expect(evidence.integrityIssues).toEqual([
      {
        target: 'api',
        path: path.join(executionDir, 'runs', 'B1', 'api-result.json'),
        batchId: 'B1',
        reason: 'batch_mismatch',
        actualBatchId: 'OLD',
      },
    ]);
  });

  it('rejects primary result paths outside the manifest batch directory', () => {
    fs.writeFileSync(
      path.join(executionDir, 'execution-manifest.yaml'),
      yaml.dump({
        batch_id: 'B1',
        selected_targets: {
          api: true,
          e2e: false,
          fuzz: false,
          performance: false,
        },
        result_files: { api: '../outside.json' },
      }),
    );
    fs.writeFileSync(
      path.join(root, 'outside.json'),
      JSON.stringify({ batch_id: 'B1', target: 'api', status: 'passed' }),
    );

    expect(() => loadExecutionEvidence(executionDir)).toThrow(
      /EXECUTION-EVIDENCE-PATH-INVALID/,
    );
  });

  it('rejects a manifest batch id that is not one safe path segment', () => {
    fs.writeFileSync(
      path.join(executionDir, 'execution-manifest.yaml'),
      yaml.dump({
        batch_id: '../outside',
        selected_targets: {
          api: false,
          e2e: false,
          fuzz: false,
          performance: false,
        },
      }),
    );

    expect(() => loadExecutionEvidence(executionDir)).toThrow(
      /EXECUTION-EVIDENCE-PATH-INVALID/,
    );
  });

  it('publishes one batch and promotes only its selected results as latest pointers', () => {
    fs.writeFileSync(
      path.join(executionDir, 'e2e-result.json'),
      JSON.stringify({ batch_id: 'STALE' }),
    );
    const selectedTargets = {
      api: true,
      e2e: false,
      fuzz: false,
      performance: false,
    };
    const apiResult = {
      schema_version: '1.0' as const,
      change_id: 'REQ-001',
      batch_id: 'B1',
      target: 'api' as const,
      status: 'passed' as const,
      command: 'pytest',
      source: {
        framework: 'pytest' as const,
        raw_log: '',
        junit_xml: '',
        json_report: '',
      },
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      cases: [],
      unmapped_tests: [],
    };
    const coverageResult = {
      schema_version: '1.0' as const,
      change_id: 'REQ-001',
      batch_id: 'B1',
      kind: 'coverage' as const,
      available: false,
      line_coverage: 0,
      branch_coverage: 0,
      threshold: { line: 80, branch: 70 },
      status: 'SKIPPED' as const,
      skip_reason: 'disabled' as const,
      uncovered_critical_files: [],
      source: { coverage_json: '', coverage_xml: '' },
    };
    const qualityGate = {
      schema_version: '1.0' as const,
      change_id: 'REQ-001',
      batch_id: 'B1',
      dimensions: {
        functional: {
          status: 'PASS' as const,
          api: { total: 1, passed: 1, failed: 0 },
          e2e: { total: 0, passed: 0, failed: 0 },
        },
        coverage: {
          status: 'SKIPPED' as const,
          available: false,
          line_coverage: 0,
          branch_coverage: 0,
          threshold: { line: 80, branch: 70 },
        },
      },
      final_status: 'PASS' as const,
    };

    const published = publishExecutionEvidence({
      executionDir,
      changeId: 'REQ-001',
      batchId: 'B1',
      selectedTargets,
      apiResult,
      e2eResult: null,
      coverageResult,
      fuzzResult: null,
      performanceResult: null,
      qualityGate,
      summary: '# Summary',
      hashes: {
        testsTreeSha256: 'tests-hash',
        testFilesSha256: { 'tests/api.py': 'test-file-hash' },
        productTreeSha256: 'product-hash',
        productFilesSha256: { 'src/api.py': 'product-file-hash' },
      },
    });

    expect(published.manifest.result_files).toEqual({
      api: 'runs/B1/api-result.json',
      coverage: 'runs/B1/coverage-result.json',
      summary: 'runs/B1/summary.md',
    });
    expect(
      JSON.parse(fs.readFileSync(path.join(executionDir, 'api-result.json'), 'utf-8')),
    ).toEqual(apiResult);
    expect(fs.existsSync(path.join(executionDir, 'e2e-result.json'))).toBe(false);
    expect(
      yaml.load(
        fs.readFileSync(path.join(executionDir, 'execution-manifest.yaml'), 'utf-8'),
      ),
    ).toMatchObject({ batch_id: 'B1', final_status: 'PASS' });
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(executionDir, 'runs', 'B1', 'product-files-sha256.json'),
          'utf-8',
        ),
      ),
    ).toEqual({ 'src/api.py': 'product-file-hash' });
  });
});
