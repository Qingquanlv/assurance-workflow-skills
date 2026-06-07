import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { run } from '../../src/execution/runner';

function makeTmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awe-run-'));
  fs.mkdirSync(path.join(dir, 'qa', 'changes', 'REQ-TEST-001', 'plans'), { recursive: true });
  return dir;
}

describe('awe run integration', () => {
  let projectRoot: string;
  beforeEach(() => { projectRoot = makeTmpProject(); });
  afterEach(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

  it('creates execution directory structure', () => {
    run({ changeId: 'REQ-TEST-001', projectRoot });
    const execDir = path.join(projectRoot, 'qa', 'changes', 'REQ-TEST-001', 'execution');
    expect(fs.existsSync(execDir)).toBe(true);
    expect(fs.existsSync(path.join(execDir, 'api-result.json'))).toBe(true);
    expect(fs.existsSync(path.join(execDir, 'e2e-result.json'))).toBe(true);
    expect(fs.existsSync(path.join(execDir, 'summary.md'))).toBe(true);
    expect(fs.existsSync(path.join(execDir, 'raw'))).toBe(true);
    expect(fs.existsSync(path.join(execDir, 'traces'))).toBe(true);
    expect(fs.existsSync(path.join(execDir, 'screenshots'))).toBe(true);
    expect(fs.existsSync(path.join(execDir, 'videos'))).toBe(true);
  });

  it('api-result.json includes schema_version and source', () => {
    run({ changeId: 'REQ-TEST-001', projectRoot });
    const apiResult = JSON.parse(fs.readFileSync(path.join(projectRoot, 'qa', 'changes', 'REQ-TEST-001', 'execution', 'api-result.json'), 'utf-8'));
    expect(apiResult.schema_version).toBe('1.0');
    expect(apiResult.target).toBe('api');
    expect(apiResult.source).toBeDefined();
    expect(apiResult.source.framework).toBe('pytest');
  });

  it('e2e-result.json includes schema_version and source', () => {
    run({ changeId: 'REQ-TEST-001', projectRoot });
    const e2eResult = JSON.parse(fs.readFileSync(path.join(projectRoot, 'qa', 'changes', 'REQ-TEST-001', 'execution', 'e2e-result.json'), 'utf-8'));
    expect(e2eResult.schema_version).toBe('1.0');
    expect(e2eResult.target).toBe('e2e');
    expect(e2eResult.source.framework).toBe('playwright');
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
