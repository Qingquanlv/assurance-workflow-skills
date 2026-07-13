import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  applyPhaseOutcome,
  createWorkflowProgression,
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
    runtime.adjudicatePhaseGate('review');
    runtime.adjudicatePhaseGate('review');
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

    expect(runtime.resolveRepair('review')).toEqual({
      phase: 'review-fix',
      maxAttempts: 4,
      attemptsUsed: 1,
    });
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

    expect(runtime.inspectGate('healing-loop-gate').verdict).toBe('exit');
    expect(runtime.resolveLoopBudget('healing')).toBe(2);
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
