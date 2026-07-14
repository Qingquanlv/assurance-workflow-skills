import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const CLI = path.resolve(__dirname, '../../../dist/cli.js');

function run(args: string[], cwd: string): { code: number; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { cwd, env: process.env, encoding: 'utf-8' });
    return { code: 0, stdout };
  } catch (e: any) {
    return { code: e.status ?? 1, stdout: (e.stdout ?? '').toString() };
  }
}

describe('aws validate (integration)', () => {
  let root: string;
  const changeId = 'REQ-VALIDATE-001';
  let caseDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-validate-'));
    caseDir = path.join(root, 'qa', 'changes', changeId, 'cases', 'auth');
    fs.mkdirSync(caseDir, { recursive: true });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const goodCase = `schema_version: "1.0"
added:
  - case_id: TC_AUTH_001
    title: login works
    status: draft
    priority: P0
    severity: critical
    type: API
    module: auth.login
modified: []
removed: []
`;

  it('exits 0 and reports ok for a valid case.yaml', () => {
    fs.writeFileSync(path.join(caseDir, 'case.yaml'), goodCase);
    const r = run(['validate', '--change', changeId, '--json'], root);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.ok).toBe(true);
    expect(out.results.find((x: any) => x.artifact_type === 'case_yaml').ok).toBe(true);
  });

  it('exits 1 and lists field errors for an invalid case.yaml', () => {
    fs.writeFileSync(path.join(caseDir, 'case.yaml'), goodCase.replace('P0', 'P9'));
    const r = run(['validate', '--change', changeId, '--json'], root);
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out.results)).toMatch(/priority/);
  });

  it('exits 1 when the change directory is missing', () => {
    const r = run(['validate', '--change', 'NOPE', '--json'], root);
    expect(r.code).toBe(1);
  });

  it('with --phase validates only that phase\'s artifacts', () => {
    // valid case.yaml (case-design) + malformed manifest (execution) present
    fs.writeFileSync(path.join(caseDir, 'case.yaml'), goodCase);
    const execDir = path.join(root, 'qa', 'changes', changeId, 'execution');
    fs.mkdirSync(execDir, { recursive: true });
    fs.writeFileSync(path.join(execDir, 'execution-manifest.yaml'), 'schema_version: "9.9"\n');
    // case-design phase → should pass, ignoring the bad manifest
    const r = run(['validate', '--change', changeId, '--phase', 'case-design', '--json'], root);
    expect(r.code).toBe(0);
  });
});
