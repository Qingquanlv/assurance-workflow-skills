import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { readEvents } from '../../../src/core/events';
import { applyGateOverride, recordExecutionTestChangesOverride } from '../../../src/core/gate_override';
import { hashTestTree } from '../../../src/core/hash';
import { loadSchemaFromFile } from '../../../src/orchestration/schema';

const changeId = 'REQ-OVERRIDE-001';

function changeDir(root: string): string {
  return path.join(root, 'qa', 'changes', changeId);
}

function schemaFile(root: string): string {
  const file = path.join(root, '.aws', 'workflow-schema.yaml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, '../../../docs/design/workflow-schema.yaml'),
    file,
  );
  return file;
}

describe('gate override', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-override-'));
    fs.mkdirSync(changeDir(projectRoot), { recursive: true });
    fs.writeFileSync(path.join(changeDir(projectRoot), 'workflow-state.yaml'), 'phases: {}\n', 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('rejects override on codegen hard gate phase', () => {
    const schema = loadSchemaFromFile(schemaFile(projectRoot));
    expect(() => applyGateOverride(
      projectRoot,
      changeId,
      'e2e-codegen',
      'fix_and_proceed',
      'test',
      schema,
    )).toThrow('GATE-OVERRIDE-DENIED: codegen hard gate');
  });

  it('records human_override for eligible review phase', () => {
    fs.mkdirSync(path.join(changeDir(projectRoot), 'review'), { recursive: true });
    fs.writeFileSync(
      path.join(changeDir(projectRoot), 'review', 'plan-review.json'),
      JSON.stringify({
        decision: 'needs_human_review',
        human_review_required: true,
        risk_level: 'high',
      }),
      'utf-8',
    );

    const schema = loadSchemaFromFile(schemaFile(projectRoot));
    applyGateOverride(
      projectRoot,
      changeId,
      'e2e-plan-review',
      'fix_and_proceed',
      'user approved fix',
      schema,
    );

    const state = yaml.load(fs.readFileSync(path.join(changeDir(projectRoot), 'workflow-state.yaml'), 'utf-8')) as any;
    expect(state.phases.e2e_plan_review.human_override.action).toBe('fix_and_proceed');
    expect(readEvents(projectRoot, changeId).some(e => e.type === 'human_override')).toBe(true);
  });

  it('records a one-time execution test-change token', () => {
    fs.mkdirSync(path.join(projectRoot, 'tests', 'api'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'tests', 'api', 'test_sample.py'), 'def test_a(): pass\n', 'utf-8');

    const token = recordExecutionTestChangesOverride(
      projectRoot,
      changeId,
      'human approved one batch',
      '2026-07-06T00:00:00.000Z',
    );

    expect(token.relPath).toBe('execution/test-changes-override-token.json');
    expect(token.testsTreeSha256).toBe(hashTestTree(projectRoot).aggregate);
    const parsed = JSON.parse(fs.readFileSync(token.absPath, 'utf-8'));
    expect(parsed).toEqual(expect.objectContaining({
      action: 'allow_test_changes',
      reason: 'human approved one batch',
      tests_tree_sha256: token.testsTreeSha256,
      consumed: false,
    }));
    expect(readEvents(projectRoot, changeId).some(e =>
      e.type === 'human_override' &&
      e.phase === 'execution' &&
      e.action === 'allow_test_changes',
    )).toBe(true);
  });
});
