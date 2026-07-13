import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { recordHumanDecision } from '../../../src/core/decide';
import { appendEvents, readEvents } from '../../../src/core/events';
import {
  SPECIAL_DECISION_SUPPORT,
  WORKFLOW_DECISION_SUPPORT,
  resolveDecisionSupport,
} from '../../../src/core/decision_support';
import { computeStatus } from '../../../src/orchestration/engine';
import { findSchemaFile, loadSchemaFromFile } from '../../../src/orchestration/schema';
import {
  consumeExecutionTestChangesOverrideToken,
  readExecutionTestChangesOverrideTokenForCurrentTree,
} from '../../../src/core/test_changes_override';
import { sha256File } from '../../../src/core/hash';

const changeId = 'REQ-DECIDE-001';

describe('human decision protocol', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-decide-'));
    fs.mkdirSync(path.join(projectRoot, 'qa', 'changes', changeId), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.aws'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.aws', 'workflow-schema.yaml'), `
schema_version: "1"
name: decide-test
params: {}
phases:
  - id: review
    requires: []
    produces: [review/review.json]
    gate: review-gate
  - id: execute
    requires: [review]
    produces: [execution/result.json]
gates:
  review-gate:
    reads: [review/review.json]
    pass_when: "decision == 'pass'"
    default: needs_human_review
`);
    writeState({ phases: { healing: { status: 'pending', attempts: [] } } });
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function writeState(state: unknown): void {
    fs.writeFileSync(
      path.join(projectRoot, 'qa', 'changes', changeId, 'workflow-state.yaml'),
      yaml.dump(state),
      'utf-8',
    );
  }

  function status() {
    const schema = loadSchemaFromFile(findSchemaFile(projectRoot));
    return computeStatus({ schema, projectRoot, changeId });
  }

  it('rejects unsupported checkpoint/action pairs without writing an event', () => {
    expect(() => recordHumanDecision({
      projectRoot,
      changeId,
      checkpoint: 'healing.safety',
      action: 'fix_and_proceed',
      reason: 'not a supported safety decision',
    })).toThrow(/unsupported decision/i);

    expect(() => recordHumanDecision({
      projectRoot,
      changeId,
      checkpoint: 'not-a-checkpoint',
      action: 'stop',
      reason: 'unknown checkpoints cannot promise consumption',
    })).toThrow(/unknown checkpoint/i);

    expect(readEvents(projectRoot, changeId)).toEqual([]);
  });

  it('assigns an explicit consumer to every supported checkpoint/action pair', () => {
    const schema = loadSchemaFromFile(findSchemaFile(projectRoot));
    for (const actionMap of Object.values(SPECIAL_DECISION_SUPPORT)) {
      expect(Object.values(actionMap).every(consumer => typeof consumer === 'string')).toBe(true);
    }
    for (const checkpointMap of Object.values(WORKFLOW_DECISION_SUPPORT)) {
      expect(Object.values(checkpointMap).every(consumer => typeof consumer === 'string')).toBe(true);
    }
    expect(resolveDecisionSupport(schema, 'review', 'fix_and_proceed').consumer).toBe('gate-decision');
    expect(() => resolveDecisionSupport(schema, 'execute', 'accept_risk'))
      .toThrow(/unsupported decision/i);
    expect(() => resolveDecisionSupport(schema, 'execute', 'fix_and_proceed'))
      .toThrow(/unsupported decision/i);
    expect(resolveDecisionSupport(schema, 'review-gate', 'accept_risk').consumer).toBe('gate-decision');
    expect(resolveDecisionSupport(schema, 'healing.safety', 'accept_risk').consumer).toBe('healing-safety');
    expect(resolveDecisionSupport(schema, 'execution.test-changes', 'allow_test_changes').consumer)
      .toBe('execution-test-changes');
    expect(resolveDecisionSupport(schema, 'bootstrap', 'skip_branch').consumer).toBe('bootstrap-decision');
    expect(resolveDecisionSupport(schema, 'execute', 'stop').consumer).toBe('terminal-status');
  });

  it('records identity, evidence SHA, and the current audited review SHA', () => {
    const reviewDir = path.join(projectRoot, 'qa', 'changes', changeId, 'review');
    fs.mkdirSync(reviewDir, { recursive: true });
    const reviewFile = path.join(reviewDir, 'review.json');
    fs.writeFileSync(reviewFile, JSON.stringify({ decision: 'needs_human_review' }), 'utf-8');
    const evidenceFile = path.join(projectRoot, 'decision-note.txt');
    fs.writeFileSync(evidenceFile, 'approved in change board\n', 'utf-8');

    recordHumanDecision({
      projectRoot,
      changeId,
      checkpoint: 'review',
      action: 'accept_risk',
      reason: 'reviewed by the change board',
      evidence: evidenceFile,
      who: 'stable-reviewer',
    });

    expect(readEvents(projectRoot, changeId)).toMatchObject([{
      source: 'decide',
      type: 'human_decision',
      checkpoint: 'review',
      action: 'accept_risk',
      reason: 'reviewed by the change board',
      who: 'stable-reviewer',
      evidence_file: 'decision-note.txt',
      evidence_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      review_file: 'review/review.json',
      review_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }]);
  });

  it('rejects a gate decision when its audited artifact is missing', () => {
    expect(() => recordHumanDecision({
      projectRoot,
      changeId,
      checkpoint: 'review',
      action: 'accept_risk',
      reason: 'cannot approve evidence that does not exist',
      who: 'operator',
    })).toThrow(/audited.*review\/review\.json.*required/i);

    expect(readEvents(projectRoot, changeId)).toEqual([]);
  });

  it('binds healing safety acceptance to the current fixer safety check', () => {
    const safetyDir = path.join(projectRoot, 'qa', 'changes', changeId, 'healing');
    fs.mkdirSync(safetyDir, { recursive: true });
    fs.writeFileSync(
      path.join(safetyDir, 'fixer-safety-check.json'),
      JSON.stringify({ passed: false, needs_review: true }),
      'utf-8',
    );

    recordHumanDecision({
      projectRoot,
      changeId,
      checkpoint: 'healing.safety',
      action: 'accept_risk',
      reason: 'reviewed current safety evidence',
      who: 'operator',
    });

    expect(readEvents(projectRoot, changeId)).toMatchObject([{
      type: 'human_decision',
      checkpoint: 'healing.safety',
      action: 'accept_risk',
      review_file: 'healing/fixer-safety-check.json',
      review_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }]);
  });

  it('rejects healing safety acceptance when the current safety artifact is missing', () => {
    expect(() => recordHumanDecision({
      projectRoot,
      changeId,
      checkpoint: 'healing.safety',
      action: 'accept_risk',
      reason: 'cannot approve absent evidence',
      who: 'operator',
    })).toThrow(/fixer-safety-check\.json.*required/i);

    expect(readEvents(projectRoot, changeId)).toEqual([]);
  });

  it('fails loudly when the decision event cannot be written', () => {
    fs.mkdirSync(path.join(projectRoot, 'qa', 'changes', changeId, 'events.jsonl'));

    expect(() => recordHumanDecision({
      projectRoot,
      changeId,
      checkpoint: 'review',
      action: 'accept_risk',
      reason: 'must be durably recorded',
      who: 'operator',
    })).toThrow();
  });

  it('creates a one-use execution authorization bound to the current test tree', () => {
    fs.mkdirSync(path.join(projectRoot, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'tests', 'test_example.py'), 'def test_ok(): pass\n');

    recordHumanDecision({
      projectRoot,
      changeId,
      checkpoint: 'execution.test-changes',
      action: 'allow_test_changes',
      reason: 'approved for this exact tree',
      who: 'operator',
    });

    expect(readExecutionTestChangesOverrideTokenForCurrentTree(projectRoot, changeId)).toMatchObject({
      change_id: changeId,
      action: 'allow_test_changes',
      reason: 'approved for this exact tree',
      consumed: false,
    });
    expect(readEvents(projectRoot, changeId)).toContainEqual(expect.objectContaining({
      source: 'decide',
      type: 'human_decision',
      checkpoint: 'execution.test-changes',
      action: 'allow_test_changes',
      evidence_file: 'execution/test-changes-decision.json',
      evidence_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));

    fs.appendFileSync(path.join(projectRoot, 'tests', 'test_example.py'), '# changed after approval\n');
    expect(() => readExecutionTestChangesOverrideTokenForCurrentTree(projectRoot, changeId))
      .toThrow(/TOKEN-MISMATCH/);
  });

  it('rejects test-change decisions forbidden by execution policy before writing evidence', () => {
    fs.writeFileSync(
      path.join(projectRoot, '.aws', 'execution-policy.json'),
      JSON.stringify({ healing: { testChangesOverride: 'forbidden' } }),
      'utf-8',
    );

    expect(() => recordHumanDecision({
      projectRoot,
      changeId,
      checkpoint: 'execution.test-changes',
      action: 'allow_test_changes',
      reason: 'policy must win',
      who: 'operator',
    })).toThrow(/ALLOW-TEST-CHANGES-FORBIDDEN/);

    expect(readEvents(projectRoot, changeId)).toEqual([]);
    expect(fs.existsSync(path.join(
      projectRoot,
      'qa',
      'changes',
      changeId,
      'execution',
      'test-changes-override-token.json',
    ))).toBe(false);
  });

  it('rejects replay after execution consumes the decision authorization', () => {
    fs.mkdirSync(path.join(projectRoot, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'tests', 'test_example.py'), 'def test_ok(): pass\n');
    recordHumanDecision({
      projectRoot,
      changeId,
      checkpoint: 'execution.test-changes',
      action: 'allow_test_changes',
      reason: 'one execution only',
      who: 'operator',
    });

    consumeExecutionTestChangesOverrideToken(projectRoot, changeId, 'batch-1');
    const decision = readEvents(projectRoot, changeId).find(
      event => event.type === 'human_decision' && event.checkpoint === 'execution.test-changes',
    );
    expect(decision?.type).toBe('human_decision');
    if (decision?.type === 'human_decision') {
      expect(sha256File(path.join(projectRoot, 'qa', 'changes', changeId, decision.evidence_file!)))
        .toBe(decision.evidence_sha256);
    }
    expect(() => readExecutionTestChangesOverrideTokenForCurrentTree(projectRoot, changeId))
      .toThrow(/TOKEN-CONSUMED/);
  });

  it('rolls back a test-change token when its strict decision event cannot persist', () => {
    fs.mkdirSync(path.join(projectRoot, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'tests', 'test_example.py'), 'def test_ok(): pass\n');
    fs.mkdirSync(path.join(projectRoot, 'qa', 'changes', changeId, 'events.jsonl'));

    expect(() => recordHumanDecision({
      projectRoot,
      changeId,
      checkpoint: 'execution.test-changes',
      action: 'allow_test_changes',
      reason: 'must be atomic with event',
      who: 'operator',
    })).toThrow();
    expect(fs.existsSync(path.join(
      projectRoot,
      'qa',
      'changes',
      changeId,
      'execution',
      'test-changes-override-token.json',
    ))).toBe(false);
    expect(fs.existsSync(path.join(
      projectRoot,
      'qa',
      'changes',
      changeId,
      'execution',
      'test-changes-decision.json',
    ))).toBe(false);
  });

  it('rejects evidence outside the project root without writing an event', () => {
    const outside = path.join(os.tmpdir(), `aws-decision-evidence-${process.pid}.txt`);
    fs.writeFileSync(outside, 'outside', 'utf-8');
    try {
      expect(() => recordHumanDecision({
        projectRoot,
        changeId,
        checkpoint: 'review',
        action: 'accept_risk',
        reason: 'invalid evidence location',
        evidence: outside,
      })).toThrow(/within project root/i);
      expect(readEvents(projectRoot, changeId)).toEqual([]);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it.each([
    '../../outside-change',
    path.join(os.tmpdir(), `outside-change-absolute-${process.pid}`),
  ])(
    'rejects escaped change id %s without reading or writing outside the changes root',
    (escapedChangeId) => {
      const outsideDir = escapedChangeId.startsWith('/')
        ? escapedChangeId
        : path.resolve(projectRoot, 'qa', 'changes', escapedChangeId);
      fs.mkdirSync(outsideDir, { recursive: true });
      const sentinel = path.join(outsideDir, 'sentinel.txt');
      fs.writeFileSync(sentinel, 'unchanged', 'utf-8');
      try {
        expect(() => recordHumanDecision({
          projectRoot,
          changeId: escapedChangeId,
          checkpoint: 'review',
          action: 'accept_risk',
          reason: 'must not escape',
        })).toThrow(/change id.*within.*qa\/changes/i);
        expect(fs.readFileSync(sentinel, 'utf-8')).toBe('unchanged');
        expect(fs.existsSync(path.join(outsideDir, 'events.jsonl'))).toBe(false);
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ['pending', { phases: { healing: { status: 'pending', attempts: [] } } }, 'pending'],
    [
      'persisted healing proposal_created',
      { phases: { healing: { status: 'proposal_created', attempts: [{ attempt: 1 }] } } },
      'pending',
    ],
  ])('stops a nonterminal workflow from %s without requiring artifacts', (_label, state, derivedStatus) => {
    writeState(state);
    const stateFile = path.join(projectRoot, 'qa', 'changes', changeId, 'workflow-state.yaml');
    const stateBefore = fs.readFileSync(stateFile, 'utf-8');

    recordHumanDecision({
      projectRoot,
      changeId,
      checkpoint: 'healing.safety',
      action: 'stop',
      reason: 'operator stopped the workflow',
      who: 'operator',
    });

    expect(status().terminal).toMatchObject({
      kind: 'stopped',
      reason: 'operator stopped the workflow',
    });
    expect(readEvents(projectRoot, changeId)).toMatchObject([{
      type: 'human_decision',
      action: 'stop',
      checkpoint: 'healing.safety',
      state_at_stop: {
        healing_status: derivedStatus,
      },
    }]);
    expect(fs.readFileSync(stateFile, 'utf-8')).toBe(stateBefore);
  });

  it('stops while a phase is awaiting a human-review gate', () => {
    const reviewDir = path.join(projectRoot, 'qa', 'changes', changeId, 'review');
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.writeFileSync(
      path.join(reviewDir, 'review.json'),
      JSON.stringify({ decision: 'needs_human_review' }),
      'utf-8',
    );
    expect(status().phases.find(phase => phase.id === 'review')?.status).toBe('awaiting_gate');

    recordHumanDecision({
      projectRoot,
      changeId,
      checkpoint: 'review',
      action: 'stop',
      reason: 'human review chose to stop',
      who: 'operator',
    });

    expect(status()).toMatchObject({
      next: [],
      terminal: {
        kind: 'stopped',
        phase: 'review',
        reason: 'human review chose to stop',
      },
    });
  });

  it('rejects stop when the workflow is already completed or stopped', () => {
    const reviewDir = path.join(projectRoot, 'qa', 'changes', changeId, 'review');
    const executionDir = path.join(projectRoot, 'qa', 'changes', changeId, 'execution');
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.mkdirSync(executionDir, { recursive: true });
    fs.writeFileSync(path.join(reviewDir, 'review.json'), JSON.stringify({ decision: 'pass' }));
    fs.writeFileSync(path.join(executionDir, 'result.json'), '{}');
    expect(status().terminal?.kind).toBe('completed');

    expect(() => recordHumanDecision({
      projectRoot,
      changeId,
      checkpoint: 'review',
      action: 'stop',
      reason: 'too late',
    })).toThrow(/already terminal completed/i);
    expect(readEvents(projectRoot, changeId)).toEqual([]);

    fs.rmSync(path.join(executionDir, 'result.json'));
    appendEvents(projectRoot, changeId, [{
      source: 'decide',
      type: 'human_decision',
      checkpoint: 'review',
      action: 'stop',
      reason: 'already stopped',
      who: 'operator',
      state_at_stop: {
        next: ['execute'],
        healing_status: 'pending',
        phases: { review: 'done', execute: 'ready' },
      },
    }]);

    expect(() => recordHumanDecision({
      projectRoot,
      changeId,
      checkpoint: 'review',
      action: 'stop',
      reason: 'stop twice',
    })).toThrow(/already terminal stopped/i);
  });

  it('derives stop from the latest valid stop event and ignores malformed later entries', () => {
    appendEvents(projectRoot, changeId, [{
      source: 'decide',
      type: 'human_decision',
      checkpoint: 'review',
      action: 'stop',
      reason: 'valid stop',
      who: 'operator',
      state_at_stop: {
        next: ['review'],
        healing_status: 'pending',
        phases: { review: 'ready', execute: 'blocked' },
      },
    }]);
    fs.appendFileSync(
      path.join(projectRoot, 'qa', 'changes', changeId, 'events.jsonl'),
      `${JSON.stringify({
        seq: 2,
        ts: '2026-07-12T00:00:01.000Z',
        change_id: changeId,
        source: 'decide',
        type: 'human_decision',
        checkpoint: 'review',
        action: 'stop',
        reason: '',
        who: '',
      })}\n`,
      'utf-8',
    );

    expect(status().terminal).toMatchObject({
      kind: 'stopped',
      reason: 'valid stop',
      phase: 'review',
    });
  });
});
