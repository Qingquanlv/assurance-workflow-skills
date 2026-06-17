import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseSchema } from '../../../src/orchestration/schema';
import { buildNextBatchManifest, selectNextBatchPhaseIds } from '../../../src/orchestration/next-batch-manifest';
import { parseHybridPhaseMap } from '../../../src/orchestration/hybrid-phase-map';

const PHASE_MAP_FIXTURE = path.resolve(
  __dirname,
  '../../fixtures/hybrid-phase-map/minimal.yaml'
);

const MINI_SCHEMA = `
schema_version: "test-hybrid-1"
name: hybrid-mini
params:
  run_mode: { type: enum, values: [full], default: full }
  test_types: { type: list, default: [api, e2e] }
phases:
  - id: skill-registry-check
    requires: []
    produces: [workflow-state.yaml]
  - id: case-design
    requires: [skill-registry-check]
    produces: [proposal.md, cases/]
  - id: case-review
    requires: [case-design]
    produces: [review/case-review.json]
    gate: case-review-gate
  - id: api-plan
    requires: [case-review]
    produces: [plans/api-plan.md]
  - id: e2e-plan
    requires: [case-review]
    produces: [plans/e2e-plan.md]
  - id: api-plan-review
    requires: [api-plan]
    produces: [review/api-plan-review.json]
    gate: api-plan-review-gate
  - id: e2e-plan-review
    requires: [e2e-plan]
    produces: [review/plan-review.json]
    gate: e2e-plan-review-gate
  - id: common-test-infra
    requires: [api-plan-review]
    produces: [codegen/common-test-infra-summary.md]
  - id: api-codegen
    requires: [common-test-infra]
    produces: [codegen/api-codegen-summary.md]
gates:
  case-review-gate:
    reads: [review/case-review.json]
    pass_when: "decision == 'pass'"
  api-plan-review-gate:
    reads: [review/api-plan-review.json]
    pass_when: "decision == 'pass'"
  e2e-plan-review-gate:
    reads: [review/plan-review.json]
    pass_when: "decision == 'pass'"
`;

describe('next-batch-manifest', () => {
  const schema = parseSchema(MINI_SCHEMA);
  const phaseMap = parseHybridPhaseMap(fs.readFileSync(PHASE_MAP_FIXTURE, 'utf-8'));
  let projectRoot: string;
  const changeId = 'CHG-MANIFEST-001';

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-manifest-'));
    const changeDir = path.join(projectRoot, 'qa', 'changes', changeId);
    fs.mkdirSync(changeDir, { recursive: true });
    fs.writeFileSync(
      path.join(changeDir, 'workflow-state.yaml'),
      'params:\n  run_mode: full\n  test_types: [api, e2e]\nphases: {}\n'
    );
    fs.writeFileSync(path.join(changeDir, 'workflow-state.yaml'), 'phases: {}\nparams:\n  run_mode: full\n');
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function writeChange(rel: string, contents = 'x'): void {
    const abs = path.join(projectRoot, 'qa', 'changes', changeId, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
  }

  it('selectNextBatchPhaseIds groups PG-PLAN ready phases', () => {
    const { phaseIds, parallelGroup } = selectNextBatchPhaseIds(
      ['api-plan', 'e2e-plan', 'common-test-infra'],
      schema,
      phaseMap
    );
    expect(parallelGroup).toBe('PG-PLAN');
    expect(phaseIds).toEqual(['api-plan', 'e2e-plan']);
  });

  function seedCaseReviewComplete(): void {
    writeChange(
      'workflow-state.yaml',
      [
        'params:',
        '  run_mode: full',
        '  test_types: [api, e2e]',
        'phases:',
        '  skill_registry_check:',
        '    status: pass',
      ].join('\n')
    );
    writeChange('proposal.md', '# proposal\n');
    writeChange('cases/demo/case.yaml', 'id: demo\n');
    writeChange('review/case-review.json', JSON.stringify({ decision: 'pass' }));
  }

  it('buildNextBatchManifest returns PG-PLAN batch when plans are ready', () => {
    seedCaseReviewComplete();

    const manifest = buildNextBatchManifest({
      schema,
      projectRoot,
      changeId,
      phaseMap,
    });

    expect(manifest.schema_version).toBe('1');
    expect(manifest.eligible_phases).toEqual(['api-plan', 'e2e-plan']);
    expect(manifest.parallel_group).toBe('PG-PLAN');
    expect(manifest.gate_after).toEqual(
      expect.arrayContaining(['api-plan-review', 'e2e-plan-review'])
    );
    expect(manifest.cli_status_ref).toBe(`aws status --change ${changeId} --json`);
    expect(manifest.conflicts).toEqual([]);
  });

  it('does not invoke OpenCode — manifest is CLI-only data', () => {
    const manifest = buildNextBatchManifest({
      schema,
      projectRoot,
      changeId,
      phaseMap,
    });
    expect(manifest).not.toHaveProperty('subagent_handles');
    expect(manifest).not.toHaveProperty('opencode_session');
  });
});
