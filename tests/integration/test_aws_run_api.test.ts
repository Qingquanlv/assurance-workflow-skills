import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { run } from '../../src/execution/runner';

function makeTmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-run-'));
  fs.mkdirSync(path.join(dir, 'qa', 'changes', 'REQ-TEST-001', 'plans'), { recursive: true });
  return dir;
}

describe('aws run integration', () => {
  let projectRoot: string;
  beforeEach(() => { projectRoot = makeTmpProject(); });
  afterEach(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

  it('creates execution directory structure', () => {
    const result = run({ changeId: 'REQ-TEST-001', projectRoot });
    const execDir = path.join(projectRoot, 'qa', 'changes', 'REQ-TEST-001', 'execution');

    // Top-level "latest" pointer files must exist (backward compat)
    expect(fs.existsSync(execDir)).toBe(true);
    expect(fs.existsSync(path.join(execDir, 'api-result.json'))).toBe(true);
    expect(fs.existsSync(path.join(execDir, 'e2e-result.json'))).toBe(true);
    expect(fs.existsSync(path.join(execDir, 'summary.md'))).toBe(true);

    // Per-batch subdirectory must exist with artifact dirs
    const batchDir = path.join(execDir, 'runs', result.batchId);
    expect(fs.existsSync(batchDir)).toBe(true);
    expect(fs.existsSync(path.join(batchDir, 'raw'))).toBe(true);
    expect(fs.existsSync(path.join(batchDir, 'traces'))).toBe(true);
    expect(fs.existsSync(path.join(batchDir, 'screenshots'))).toBe(true);
    expect(fs.existsSync(path.join(batchDir, 'videos'))).toBe(true);
    expect(fs.existsSync(path.join(batchDir, 'api-result.json'))).toBe(true);
    expect(fs.existsSync(path.join(batchDir, 'e2e-result.json'))).toBe(true);
    expect(fs.existsSync(path.join(batchDir, 'summary.md'))).toBe(true);
  });

  it('api-result.json includes schema_version, batch_id, and source', () => {
    const result = run({ changeId: 'REQ-TEST-001', projectRoot });
    const apiResult = JSON.parse(fs.readFileSync(path.join(projectRoot, 'qa', 'changes', 'REQ-TEST-001', 'execution', 'api-result.json'), 'utf-8'));
    expect(apiResult.schema_version).toBe('1.0');
    expect(apiResult.target).toBe('api');
    expect(apiResult.batch_id).toBe(result.batchId);
    expect(apiResult.source).toBeDefined();
    expect(apiResult.source.framework).toBe('pytest');
  });

  it('multiple runs produce separate batch dirs without overwriting previous results', () => {
    const r1 = run({ changeId: 'REQ-TEST-001', projectRoot });
    // Small delay to ensure different second-granularity timestamps
    const r2 = run({ changeId: 'REQ-TEST-001', projectRoot });

    const execDir = path.join(projectRoot, 'qa', 'changes', 'REQ-TEST-001', 'execution');
    const runsDir = path.join(execDir, 'runs');
    const batches = fs.readdirSync(runsDir);

    // Both batch dirs must exist (even if timestamps are identical, r1 must not be deleted)
    expect(fs.existsSync(path.join(runsDir, r1.batchId))).toBe(true);
    expect(fs.existsSync(path.join(runsDir, r2.batchId))).toBe(true);
    // Latest pointer reflects the most recent batch
    const latest = JSON.parse(fs.readFileSync(path.join(execDir, 'api-result.json'), 'utf-8'));
    expect(latest.batch_id).toBe(r2.batchId);
    expect(batches.length).toBeGreaterThanOrEqual(1);
  });

  it('e2e-result.json includes schema_version and source', () => {
    run({ changeId: 'REQ-TEST-001', projectRoot });
    const e2eResult = JSON.parse(fs.readFileSync(path.join(projectRoot, 'qa', 'changes', 'REQ-TEST-001', 'execution', 'e2e-result.json'), 'utf-8'));
    expect(e2eResult.schema_version).toBe('1.0');
    expect(e2eResult.target).toBe('e2e');
    expect(e2eResult.source.framework).toBe('pytest-playwright');
  });

  it('when pytest unavailable, api-result.json.status is skipped not passed', () => {
    const result = run({ changeId: 'REQ-TEST-001', projectRoot });
    expect(['skipped', 'failed']).toContain(result.api.status);
    expect(result.api.status).not.toBe('passed');
  });

  it('summary.md contains change-id and result table', () => {
    run({ changeId: 'REQ-TEST-001', projectRoot });
    const summary = fs.readFileSync(path.join(projectRoot, 'qa', 'changes', 'REQ-TEST-001', 'execution', 'summary.md'), 'utf-8');
    expect(summary).toContain('REQ-TEST-001');
    expect(summary).toContain('API');
    expect(summary).toContain('E2E');
  });

  it('reads test files from api-codegen-plan.md when present', () => {
    fs.writeFileSync(path.join(projectRoot, 'qa', 'changes', 'REQ-TEST-001', 'plans', 'api-codegen-plan.md'), '# API Plan\nFile: tests/api/test_auth_api.py\n', 'utf-8');
    expect(() => run({ changeId: 'REQ-TEST-001', projectRoot })).not.toThrow();
  });
});
