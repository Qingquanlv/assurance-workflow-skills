import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadCasesFromQa } from '../../../src/risk/case_loader';

describe('loadCasesFromQa', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-cases-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeCaseYaml(relativePath: string, content: string): void {
    const filePath = path.join(tmpDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  it('loads cases from delta-style added and modified lists', () => {
    writeCaseYaml('qa/cases/role/case.yaml', `
added:
  - case_id: TC_ROLE_API_001
    module: role
    priority: P0
    automation:
      required: true
modified:
  - case_id: TC_ROLE_E2E_001
    module: role
    flaky: true
    automation:
      required: false
`);

    const cases = loadCasesFromQa(tmpDir);

    expect(cases.map((c) => c.case_id)).toEqual(['TC_ROLE_API_001', 'TC_ROLE_E2E_001']);
    expect(cases[0]).toMatchObject({
      case_id: 'TC_ROLE_API_001',
      module: 'role',
      priority: 'P0',
      automation_required: true,
    });
    expect(cases[1]).toMatchObject({
      case_id: 'TC_ROLE_E2E_001',
      module: 'role',
      flaky: true,
      automation_required: false,
    });
  });

  it('continues to support top-level cases arrays and single-case documents', () => {
    writeCaseYaml('qa/cases/order/case.yaml', `
cases:
  - case_id: TC_ORDER_API_001
    automation:
      required: true
`);
    writeCaseYaml('qa/cases/user/login.case.yaml', `
case_id: TC_USER_API_001
automation:
  required: false
`);

    const cases = loadCasesFromQa(tmpDir);

    expect(cases.map((c) => c.case_id)).toEqual(['TC_ORDER_API_001', 'TC_USER_API_001']);
    expect(cases.find((c) => c.case_id === 'TC_ORDER_API_001')?.module).toBe('order');
    expect(cases.find((c) => c.case_id === 'TC_USER_API_001')?.module).toBe('user');
  });

  it('deduplicates by case_id with later files overriding earlier entries', () => {
    writeCaseYaml('qa/cases/role/case.yaml', `
added:
  - case_id: TC_ROLE_API_001
    module: role
    priority: P2
`);
    writeCaseYaml('qa/cases/role/override.case.yaml', `
modified:
  - case_id: TC_ROLE_API_001
    module: role
    priority: P0
`);

    const cases = loadCasesFromQa(tmpDir);

    expect(cases).toHaveLength(1);
    expect(cases[0].priority).toBe('P0');
  });

  it('recovers case IDs from malformed YAML with unquoted colons in text lists', () => {
    writeCaseYaml('qa/cases/dept/case.yaml', `
added:
  - case_id: TC_DEPT_009
    module: dept
    priority: P1
    test_data:
      - 第一次 name: "qa_dept_dup"
      - 第二次 name: "qa_dept_dup"（重复）
`);

    const cases = loadCasesFromQa(tmpDir);

    expect(cases).toContainEqual(expect.objectContaining({
      case_id: 'TC_DEPT_009',
      module: 'dept',
      priority: 'P1',
    }));
  });
});
