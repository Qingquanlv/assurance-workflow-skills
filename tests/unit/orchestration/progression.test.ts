import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  adjudicatePhaseGate,
  applyPhaseOutcome,
  createWorkflowProgression,
  inspectNamedGate,
  inspectProgression,
} from '../../../src/orchestration/progression';
import { parseSchema } from '../../../src/orchestration/schema';
import { appendEventsStrict, buildDriverEvent, readEvents } from '../../../src/core/events';

const MINI_SCHEMA = `
schema_version: "test-1"
name: progression-mini
params:
  max_healing_attempts: { type: int, default: 0 }
phases:
  - id: design
    skill: aws-design
    requires: []
    produces: [design.json]
  - id: verify
    skill: aws-verify
    requires: [design]
    produces: [verify.json]
gates: {}
`;

const GATED_SCHEMA = `
schema_version: "test-1"
name: progression-gated
params:
  max_healing_attempts: { type: int, default: 0 }
phases:
  - id: review
    skill: aws-review
    requires: []
    produces: [review/review.json]
    gate: review-gate
gates:
  review-gate:
    reads: [review/review.json]
    pass_when: "decision == 'pass'"
    needs_fix_when: "decision == 'needs_fix'"
    default: stop
`;

const REPAIR_SCHEMA = `
schema_version: "test-1"
name: progression-repair
params:
  max_plan_fix_attempts: { type: int, default: 4 }
  max_healing_attempts: { type: int, default: 0 }
phases:
  - id: review
    skill: aws-review
    requires: []
    produces: [review/review.json]
    gate: review-gate
  - id: review-fix
    skill: aws-review-fixer
    requires: [review]
    produces: [review/review.json]
    repair_of: review
    max_attempts_param: max_plan_fix_attempts
gates:
  review-gate:
    reads: [review/review.json]
    pass_when: "decision == 'pass'"
    needs_fix_when: "decision == 'needs_fix'"
    default: stop
`;

const LOOP_SCHEMA = `
schema_version: "test-1"
name: progression-loop
params:
  max_healing_attempts: { type: int, default: 3 }
phases:
  - id: heal-step
    skill: aws-heal-step
    requires: []
    produces: [heal.json]
loops:
  healing:
    members: [heal-step]
    counter: state.phases.healing.attempts
    max_param: max_healing_attempts
    allocate_on: "true"
    exit_gate: healing-loop-gate
gates:
  healing-loop-gate:
    reads: [workflow-state.yaml]
    exit_when: "params.max_healing_attempts == 2"
    default: stop
`;

describe('Workflow Progression Runtime', () => {
  let projectRoot: string;
  const changeId = 'REQ-PROGRESSION-001';

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-progression-'));
    fs.mkdirSync(path.join(projectRoot, 'qa', 'changes', changeId), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.aws'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, '.aws', 'workflow-schema.yaml'),
      MINI_SCHEMA,
      'utf-8',
    );
    fs.writeFileSync(path.join(projectRoot, '.aws', 'test-SKILL.md'), '# Test skill\n', 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('returns resolved next actions without mutating durable files', () => {
    const changeDir = path.join(projectRoot, 'qa', 'changes', changeId);
    const before = fs.readdirSync(changeDir);

    const snapshot = inspectProgression({
      schema: parseSchema(MINI_SCHEMA),
      projectRoot,
      changeId,
    });

    expect(snapshot.nextActions.map(action => action.phase)).toEqual(['design']);
    expect(snapshot.report.next).toEqual(['design']);
    expect(snapshot.auditIssues).toEqual([]);
    expect(snapshot.healingEpisode).toEqual({
      state: 'inactive',
      episodeId: null,
      attemptKey: null,
      attemptNumber: 0,
      stage: null,
      nextActions: [],
    });
    expect(fs.readdirSync(changeDir)).toEqual(before);
  });

  it('applies one Phase outcome and returns the post-transition next actions', () => {
    fs.writeFileSync(
      path.join(projectRoot, 'qa', 'changes', changeId, 'design.json'),
      '{}',
      'utf-8',
    );

    const result = applyPhaseOutcome(
      { schema: parseSchema(MINI_SCHEMA), projectRoot, changeId },
      {
        phase: 'design',
        attemptId: 'run-1:design:1',
        skillMdPath: path.join(projectRoot, '.aws', 'test-SKILL.md'),
      },
    );

    expect(result.replayed).toBe(false);
    expect(result.gate).toBeNull();
    expect(result.snapshot.nextActions.map(action => action.phase)).toEqual(['verify']);
    expect(
      result.snapshot.report.phases.find(phase => phase.id === 'design')?.status,
    ).toBe('done');
  });

  it('records the post-outcome Gate once and replays the same attempt idempotently', () => {
    fs.writeFileSync(
      path.join(projectRoot, '.aws', 'workflow-schema.yaml'),
      GATED_SCHEMA,
      'utf-8',
    );
    const reviewDir = path.join(projectRoot, 'qa', 'changes', changeId, 'review');
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.writeFileSync(
      path.join(reviewDir, 'review.json'),
      JSON.stringify({ schema_version: '1.0', decision: 'pass', findings: [] }),
      'utf-8',
    );
    const options = { schema: parseSchema(GATED_SCHEMA), projectRoot, changeId };
    const outcome = {
      phase: 'review',
      attemptId: 'run-1:review:1',
      skillMdPath: path.join(projectRoot, '.aws', 'test-SKILL.md'),
    };

    const first = applyPhaseOutcome(options, outcome);
    const replay = applyPhaseOutcome(options, outcome);

    expect(first.gate?.verdict).toBe('pass');
    expect(first.decision).toEqual({ action: 'continue' });
    expect(first.replayed).toBe(false);
    expect(replay.gate?.verdict).toBe('pass');
    expect(replay.decision).toEqual({ action: 'continue' });
    expect(replay.replayed).toBe(true);
    expect(readEvents(projectRoot, changeId).filter(event => event.type === 'gate_verdict')).toHaveLength(1);
    expect(readEvents(projectRoot, changeId).filter(event => event.type === 'phase_outcome_committed')).toHaveLength(1);

    const runtime = createWorkflowProgression(options);
    adjudicatePhaseGate(options, 'review');
    adjudicatePhaseGate(options, 'review');
    expect(readEvents(projectRoot, changeId).filter(event => event.type === 'gate_verdict')).toHaveLength(1);
  });

  it('resolves the repair Phase and attempt budget from schema metadata', () => {
    appendEventsStrict(projectRoot, changeId, [
      buildDriverEvent('phase_dispatched', 'run-1', { phase: 'review-fix', attempt_id: 'fix:1' }),
    ]);
    const runtime = createWorkflowProgression({
      schema: parseSchema(REPAIR_SCHEMA),
      projectRoot,
      changeId,
    });

    expect(runtime.inspect()).toBeDefined();
  });

  it('inspects a named loop Gate and resolves its budget without writing', () => {
    fs.writeFileSync(
      path.join(projectRoot, '.aws', 'workflow-schema.yaml'),
      LOOP_SCHEMA,
      'utf-8',
    );
    const stateFile = path.join(projectRoot, 'qa', 'changes', changeId, 'workflow-state.yaml');
    fs.writeFileSync(
      stateFile,
      'params:\n  max_healing_attempts: 2\nphases: {}\n',
      'utf-8',
    );
    const runtime = createWorkflowProgression({
      schema: parseSchema(LOOP_SCHEMA),
      projectRoot,
      changeId,
    });
    const before = fs.readFileSync(stateFile, 'utf-8');

    expect(inspectNamedGate({
      schema: parseSchema(LOOP_SCHEMA),
      projectRoot,
      changeId,
    }, 'healing-loop-gate').verdict).toBe('exit');
    expect(fs.readFileSync(stateFile, 'utf-8')).toBe(before);
  });

  it('rolls back workflow state when the Event commit fails', () => {
    const changeDir = path.join(projectRoot, 'qa', 'changes', changeId);
    fs.writeFileSync(path.join(changeDir, 'design.json'), '{}', 'utf-8');
    const eventsFile = path.join(changeDir, 'events.jsonl');
    fs.writeFileSync(eventsFile, '', 'utf-8');
    fs.chmodSync(eventsFile, 0o444);
    const stateFile = path.join(changeDir, 'workflow-state.yaml');
    const warning = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      expect(() => applyPhaseOutcome(
        { schema: parseSchema(MINI_SCHEMA), projectRoot, changeId },
        {
          phase: 'design',
          attemptId: 'run-rollback:design:1',
          skillMdPath: path.join(projectRoot, '.aws', 'test-SKILL.md'),
        },
      )).toThrow();
    } finally {
      warning.mockRestore();
    }

    expect(fs.existsSync(stateFile)).toBe(false);
  });
});

describe('WorkflowProgressionRuntime — narrowed surface', () => {
  let projectRoot: string;
  const changeId = 'REQ-PROGRESSION-NARROWED';
  const options = () => ({
    schema: parseSchema(MINI_SCHEMA),
    projectRoot,
    changeId,
    packageRoot: projectRoot,
  });

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-progression-narrowed-'));
    fs.mkdirSync(path.join(projectRoot, 'qa', 'changes', changeId), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.aws'), { recursive: true });
    for (const skill of ['aws-design', 'aws-verify']) {
      const skillDir = path.join(projectRoot, 'skills', skill);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# test\n', 'utf-8');
    }
    fs.writeFileSync(path.join(projectRoot, '.aws', 'workflow-schema.yaml'), MINI_SCHEMA, 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function writeDesign(): void {
    fs.writeFileSync(path.join(projectRoot, 'qa', 'changes', changeId, 'design.json'), '{}', 'utf-8');
  }

  function snapshotChangeFiles(): Map<string, Buffer> {
    const root = path.join(projectRoot, 'qa', 'changes', changeId);
    return new Map(fs.readdirSync(root).map(file => [file, fs.readFileSync(path.join(root, file))]));
  }

  it('exposes only inspect / advance / resume', () => {
    expect(Object.keys(createWorkflowProgression(options())).sort()).toEqual([
      'advance', 'inspect', 'resume',
    ]);
  });

  it('inspect is pure and returns a signed dispatch action', () => {
    const before = snapshotChangeFiles();
    const { action } = createWorkflowProgression(options()).inspect();

    expect(action).toMatchObject({ kind: 'dispatch_phase', phase: 'design', attemptId: 'design#1' });
    expect(snapshotChangeFiles()).toEqual(before);
  });

  it('advance verifies the state guard (H0) and fails closed on mismatch', () => {
    fs.writeFileSync(
      path.join(projectRoot, 'qa', 'changes', changeId, 'workflow-state.yaml'),
      'phases: {}\n',
      'utf-8',
    );
    const runtime = createWorkflowProgression(options());
    const { action } = runtime.inspect();
    writeDesign();
    fs.writeFileSync(
      path.join(projectRoot, 'qa', 'changes', changeId, 'workflow-state.yaml'),
      'phases:\n  design:\n    status: tampered\n',
      'utf-8',
    );

    expect(() => runtime.advance({ ...(action as any), agentExit: 0 })).toThrow(/H0 violation/);
  });

  it('advance applies one outcome and re-projects the next action', () => {
    const runtime = createWorkflowProgression(options());
    const { action } = runtime.inspect();
    writeDesign();

    const { action: next } = runtime.advance({ ...(action as any), agentExit: 0 });
    expect(next).toMatchObject({ kind: 'dispatch_phase', phase: 'verify' });
  });

  it('advance is idempotent on replay', () => {
    const runtime = createWorkflowProgression(options());
    const { action } = runtime.inspect();
    writeDesign();

    runtime.advance({ ...(action as any) });
    const eventCount = readEvents(projectRoot, changeId).length;
    runtime.advance({ ...(action as any) });
    expect(readEvents(projectRoot, changeId)).toHaveLength(eventCount);
  });

  it('resume commits a dispatched-but-uncommitted attempt when evidence is present', () => {
    const runtime = createWorkflowProgression(options());
    const { action } = runtime.inspect();
    writeDesign();
    appendEventsStrict(projectRoot, changeId, [{
      source: 'progression',
      type: 'dispatch_signed',
      phase: 'design',
      attempt_id: (action as any).attemptId,
      state_guard: (action as any).stateGuard,
      dispatched_at: 0,
    }]);

    expect(runtime.resume().action).toMatchObject({ kind: 'dispatch_phase', phase: 'verify' });
  });

  it('resume discards a half-finished attempt with missing evidence', () => {
    const runtime = createWorkflowProgression(options());
    const { action } = runtime.inspect();
    appendEventsStrict(projectRoot, changeId, [{
      source: 'progression',
      type: 'dispatch_signed',
      phase: 'design',
      attempt_id: (action as any).attemptId,
      state_guard: (action as any).stateGuard,
      dispatched_at: Date.now(),
    }]);

    expect(runtime.resume().action).toMatchObject({
      kind: 'dispatch_phase',
      phase: 'design',
      attemptId: 'design#2',
    });
  });
});
