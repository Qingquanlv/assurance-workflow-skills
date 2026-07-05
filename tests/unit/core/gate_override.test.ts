import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { readEvents } from '../../../src/core/events';
import { applyGateOverride } from '../../../src/core/gate_override';
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
});
