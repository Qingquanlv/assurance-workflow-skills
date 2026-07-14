import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { parseSchema, loadSchemaFromFile, Schema } from '../../../../src/workflow/orchestration/schema';
import { Engine, computeStatus, checkGate, resolveNextDispatch, PhaseDispatchEntry } from '../../../../src/workflow/orchestration/engine';
import { appendEvents } from '../../../../src/workflow/core/events';
import { sha256File } from '../../../../src/utils/hash';

const REAL_SCHEMA = path.resolve(__dirname, '../../../../schemas/workflow-schema.yaml');

const MINI = `
schema_version: "test-1"
name: mini
params:
  run_mode: { type: enum, values: [full, quick], default: full }
  test_types: { type: list, default: [api] }
  max_healing_attempts: { type: int, default: 2 }
phases:
  - id: design
    requires: []
    produces: [design.json]
  - id: review
    requires: [design]
    produces: [review.json]
    gate: review-gate
  - id: build
    requires: [review]
    produces: [build.json]
    when: "params.run_mode == 'full'"
  - id: codegen
    requires: [review]
    produces: [codegen.json]
    gate: precond-gate
  - id: exec
    requires: [build, codegen]
    requires_mode: any_active
    produces: [exec.json]
gates:
  review-gate:
    reads: [review.json]
    invalid_json: stop
    missing_file_is: stop
    pass_when: "decision == 'pass'"
    needs_fix_when: "decision == 'needs_fix'"
    reject_when: "decision == 'reject'"
  precond-gate:
    reads: [workflow-state.yaml]
    pass_when: "gate('review-gate').verdict == 'pass'"
    stop_when: "gate('review-gate').verdict == 'reject'"
`;

const SCOPE_MINI = `
schema_version: "test-scope"
name: scope-mini
params:
  run_mode: { type: enum, values: [full], default: full }
  test_types: { type: list, default: [api] }
  max_healing_attempts: { type: int, default: 0 }
phases:
  - id: explore
    requires: []
    produces: [explore/advisory.json]
    owned_by: [full, intake]
  - id: case-review
    requires: [explore]
    produces: [review/case-review.json]
    gate: case-review-gate
    owned_by: [full, intake]
  - id: fact-baseline
    requires: [case-review]
    produces: [facts/fact-baseline.json]
    owned_by: [full, execute]
  - id: api-plan
    requires: [fact-baseline]
    produces: [plans/api-plan.md]
    owned_by: [full, execute]
gates:
  case-review-gate:
    reads: [review/case-review.json]
    pass_when: "decision == 'pass'"
`;

let projectRoot: string;
const changeId = 'REQ-ENG-001';
let schema: Schema;

function changeDir(): string {
  return path.join(projectRoot, 'qa', 'changes', changeId);
}
function writeChangeFile(rel: string, contents: string): void {
  const abs = path.join(changeDir(), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents, 'utf-8');
}
function writeJson(rel: string, obj: unknown): void {
  let value = obj;
  if (/^review\/.+\.json$/.test(rel) && isRecord(obj)) {
    value = { schema_version: '1.0', findings: [], ...obj };
  }
  if (rel === 'inspect/failure-analysis.json' && isRecord(obj)) {
    const failures = Array.isArray(obj.failures)
      ? obj.failures.map(failure => ({
        category: 'business_logic_failure',
        severity: 'high',
        evidence: {
          result_file: '', test_file: '', trace: '', screenshot: '',
          video: '', raw_log: '', log_excerpt: '',
        },
        diagnosis: 'test fixture',
        recommended_action: 'test fixture',
        ...(isRecord(failure) ? failure : {}),
      }))
      : [];
    value = {
      schema_version: '1.0',
      change_id: changeId,
      source_manifest: 'execution/execution-manifest.yaml',
      inspection_status: 'completed',
      batch_id: obj.source_batch_id ?? 'b1',
      source_batch_id: 'b1',
      final_status: 'FAIL',
      inspect_mode: 'primary',
      classification_performed: true,
      status: 'analyzed',
      hard_fails: failures,
      needs_review: [],
      known_product_issues: [],
      ...obj,
      failures,
    };
  }
  writeChangeFile(rel, JSON.stringify(value));
}
function writeWorkflowState(value: Record<string, unknown>): void {
  writeChangeFile('workflow-state.yaml', yaml.dump({ params: {}, phases: {}, ...value }));
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function statusOf(id: string) {
  return computeStatus({ schema, projectRoot, changeId }).phases.find(p => p.id === id);
}

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-engine-'));
  fs.mkdirSync(changeDir(), { recursive: true });
  schema = parseSchema(MINI);
});
afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe('state detection — happy path progression', () => {
  it('fresh: design ready, downstream blocked', () => {
    const r = computeStatus({ schema, projectRoot, changeId });
    expect(statusOf('design')!.status).toBe('ready');
    expect(statusOf('review')!.status).toBe('blocked');
    expect(statusOf('review')!.missingDeps).toEqual(['design']);
    expect(r.next).toContain('design');
    expect(r.terminal).toBeNull();
  });

  it('design produced (no gate) → done, review ready', () => {
    writeJson('design.json', { ok: true });
    expect(statusOf('design')!.status).toBe('done');
    expect(statusOf('review')!.status).toBe('ready');
  });

  it('review produced + decision pass → done, build & codegen ready', () => {
    writeJson('design.json', { ok: true });
    writeJson('review.json', { decision: 'pass' });
    expect(statusOf('review')!.status).toBe('done');
    expect(statusOf('review')!.gate_verdict).toBe('pass');
    expect(statusOf('build')!.status).toBe('ready');
    // codegen deps satisfied but its produces are absent → ready (not done)
    expect(statusOf('codegen')!.status).toBe('ready');
  });

  it('codegen becomes done once produces exist and precond-gate passes via cross-gate', () => {
    writeJson('design.json', { ok: true });
    writeJson('review.json', { decision: 'pass' });
    writeJson('codegen.json', { ok: true });
    expect(statusOf('codegen')!.status).toBe('done');
    expect(statusOf('codegen')!.gate_verdict).toBe('pass');
  });

  it('a phase with a gate is NOT done on produces-existence alone', () => {
    writeJson('design.json', { ok: true });
    writeJson('review.json', { decision: 'needs_fix' });
    // produces present, but gate != pass
    const s = statusOf('review')!;
    expect(s.produces_present).toBe(true);
    expect(s.status).toBe('awaiting_gate');
    expect(s.gate_verdict).toBe('needs_fix');
  });
});

describe('terminal states', () => {
  it('completed when all active phases done', () => {
    writeJson('design.json', { ok: true });
    writeJson('review.json', { decision: 'pass' });
    writeJson('build.json', { ok: true });
    writeJson('codegen.json', { ok: true });
    writeJson('exec.json', { ok: true });
    const r = computeStatus({ schema, projectRoot, changeId });
    expect(r.terminal).toEqual({ kind: 'completed', reason: 'all active phases done' });
  });

  it('stopped when a gate yields reject', () => {
    writeJson('design.json', { ok: true });
    writeJson('review.json', { decision: 'reject' });
    const r = computeStatus({ schema, projectRoot, changeId });
    expect(statusOf('review')!.status).toBe('stopped');
    expect(r.terminal?.kind).toBe('stopped');
    expect(r.terminal?.phase).toBe('review');
  });
});

describe('pruning via when', () => {
  it('build pruned in quick mode; exec uses any_active over remaining dep', () => {
    writeWorkflowState({ params: { run_mode: 'quick' } });
    writeJson('design.json', { ok: true });
    writeJson('review.json', { decision: 'pass' });
    writeJson('codegen.json', { ok: true });
    expect(statusOf('build')!.status).toBe('pruned');
    // exec requires [build(pruned), codegen(done)] any_active → not blocked
    expect(statusOf('exec')!.status).toBe('ready');
  });
});

describe('active_scope from run_context', () => {
  let scopedSchema: Schema;

  beforeEach(() => {
    scopedSchema = parseSchema(SCOPE_MINI);
  });

  it('excludes ready phases outside the current scope from next dispatch', () => {
    writeWorkflowState({ run_context: { active_scope: 'intake' } });
    writeJson('explore/advisory.json', { ok: true });
    writeJson('review/case-review.json', { decision: 'pass' });

    const r = computeStatus({ schema: scopedSchema, projectRoot, changeId });
    const fact = r.phases.find(p => p.id === 'fact-baseline')!;
    expect(fact.status).toBe('out_of_scope');
    expect(r.next).not.toContain('fact-baseline');
    expect(r.terminal).toEqual({ kind: 'completed', reason: 'all in-scope phases done' });
  });

  it('marks phases outside the current scope out_of_scope before dependency blocking', () => {
    writeWorkflowState({ run_context: { active_scope: 'intake' } });

    const r = computeStatus({ schema: scopedSchema, projectRoot, changeId });
    expect(r.phases.find(p => p.id === 'fact-baseline')!.status).toBe('out_of_scope');
    expect(r.next).toEqual(['explore']);
  });

  it('allows execute-scope phases to use completed intake dependencies', () => {
    writeWorkflowState({ run_context: { active_scope: 'execute' } });
    writeJson('explore/advisory.json', { ok: true });
    writeJson('review/case-review.json', { decision: 'pass' });

    const r = computeStatus({ schema: scopedSchema, projectRoot, changeId });
    expect(r.phases.find(p => p.id === 'case-review')!.status).toBe('done');
    expect(r.phases.find(p => p.id === 'fact-baseline')!.status).toBe('ready');
    expect(r.next).toEqual(['fact-baseline']);
  });

  it('includes run_context and open question summary in the status report', () => {
    writeWorkflowState({
      run_context: {
        orchestrator_skill: 'aws-intake',
        interaction_mode: 'interactive',
        active_scope: 'intake',
        stamped_at: '2026-07-04T00:00:00.000Z',
      },
    });
    writeJson('explore/advisory.json', {
      open_questions_for_case_design: [
        { id: 'OQ-001', status: 'answered' },
        { id: 'OQ-002', status: 'deferred' },
        { id: 'OQ-003', status: 'unanswered' },
        { id: 'OQ-004', answer: 'legacy answer', answered_via: 'explore' },
      ],
    });

    const r = computeStatus({ schema: scopedSchema, projectRoot, changeId });
    expect(r.run_context).toMatchObject({
      orchestrator_skill: 'aws-intake',
      interaction_mode: 'interactive',
      active_scope: 'intake',
    });
    expect(r.intake?.open_questions).toEqual({
      total: 4,
      answered: 2,
      deferred: 1,
      unanswered: 1,
    });
  });
});

describe('transitive pruning', () => {
  it('prunes a phase whose required deps are all pruned (cascades)', () => {
    const s = parseSchema(`
params:
  run_mode: { type: enum, values: [full, quick], default: quick }
phases:
  - id: a
    requires: []
    produces: [a.json]
  - id: b
    requires: [a]
    produces: [b.json]
    when: "params.run_mode == 'full'"
  - id: c
    requires: [b]
    requires_mode: any_active
    produces: [c.json]
  - id: d
    requires: [c]
    produces: [d.json]
gates: {}
`);
    writeJson('a.json', { ok: true });
    // run_mode defaults to quick → b pruned → c (any_active, only dep pruned)
    // must be pruned, and d must cascade-prune as well.
    const phases = computeStatus({ schema: s, projectRoot, changeId }).phases;
    const byId = (id: string) => phases.find(p => p.id === id)!;
    expect(byId('b').status).toBe('pruned');
    expect(byId('c').status).toBe('pruned');
    expect(byId('d').status).toBe('pruned');
    expect(byId('a').status).toBe('done');
  });
});

describe('any_active requires', () => {
  it('blocked when no active dep is done', () => {
    writeJson('design.json', { ok: true });
    writeJson('review.json', { decision: 'pass' });
    // neither build nor codegen done (no produces yet for build; codegen produces absent)
    expect(statusOf('exec')!.status).toBe('blocked');
  });

  it('ready when at least one active dep is done', () => {
    writeJson('design.json', { ok: true });
    writeJson('review.json', { decision: 'pass' });
    writeJson('build.json', { ok: true }); // build done
    expect(statusOf('exec')!.status).toBe('ready');
  });
});

describe('gate adjudication (checkGate)', () => {
  beforeEach(() => {
    writeJson('design.json', { ok: true });
  });

  it('pass rule matches and reports matched_rule', () => {
    writeJson('review.json', { decision: 'pass' });
    const g = checkGate({ schema, projectRoot, changeId, phaseId: 'review' });
    expect(g.verdict).toBe('pass');
    expect(g.matched_rule).toContain('pass_when');
    expect(g.evidence.decision).toBe('pass');
  });

  it('rule order: first true wins', () => {
    writeJson('review.json', { decision: 'needs_fix' });
    const g = checkGate({ schema, projectRoot, changeId, phaseId: 'review' });
    expect(g.verdict).toBe('needs_fix');
  });

  it('invalid_json → stop', () => {
    writeChangeFile('review.json', '{ not valid json');
    const g = checkGate({ schema, projectRoot, changeId, phaseId: 'review' });
    expect(g.verdict).toBe('stop');
    expect(g.matched_rule).toContain('invalid_json');
  });

  it('missing reads file → missing_file_is verdict', () => {
    // review.json absent
    const g = checkGate({ schema, projectRoot, changeId, phaseId: 'review' });
    expect(g.verdict).toBe('stop'); // missing_file_is: stop
  });

  it('no rule matched + present file → fail-closed default (stop)', () => {
    writeJson('review.json', { decision: 'something-else' });
    const g = checkGate({ schema, projectRoot, changeId, phaseId: 'review' });
    expect(g.verdict).toBe('stop'); // default
  });

  it('cross-gate reference resolves and memoizes', () => {
    writeJson('review.json', { decision: 'pass' });
    const g = checkGate({ schema, projectRoot, changeId, phaseId: 'codegen' });
    expect(g.gate).toBe('precond-gate');
    expect(g.verdict).toBe('pass'); // because review-gate == pass
  });

  it('needs_fix recommends the repair phase when present', () => {
    const s = parseSchema(`
phases:
  - id: review
    requires: []
    produces: [review.json]
    gate: rg
  - id: review-fix
    requires: [review]
    produces: [review.json]
    repair_of: review
    max_attempts_param: max_healing_attempts
gates:
  rg:
    reads: [review.json]
    pass_when: "decision == 'pass'"
    needs_fix_when: "decision == 'needs_fix'"
`);
    // add the param referenced by max_attempts_param
    s.params.max_healing_attempts = { type: 'int', default: 2 };
    writeJson('review.json', { decision: 'needs_fix' });
    const g = checkGate({ schema: s, projectRoot, changeId, phaseId: 'review' });
    expect(g.verdict).toBe('needs_fix');
    expect(g.recommended_phase).toBe('review-fix');
  });

  it('accept_risk at the gated phase converts needs_human_review to pass with provenance', () => {
    const s = parseSchema(`
phases:
  - id: review
    requires: []
    produces: [review/review.json]
    gate: review-gate
gates:
  review-gate:
    reads: [review/review.json]
    needs_human_review_when: "decision == 'needs_human_review'"
`);
    writeJson('review/review.json', { decision: 'needs_human_review' });
    appendEvents(projectRoot, changeId, [{
      source: 'decide',
      type: 'human_decision',
      checkpoint: 'review',
      action: 'accept_risk',
      reason: 'risk accepted by reviewer',
      who: 'reviewer',
      review_file: 'review/review.json',
      review_sha256: sha256File(path.join(changeDir(), 'review/review.json'))!,
    }]);

    const g = checkGate({ schema: s, projectRoot, changeId, phaseId: 'review' });
    expect(g.verdict).toBe('pass');
    expect(g.matched_rule).toContain('human_decision:accept_risk');
    expect(g.evidence).toMatchObject({
      decision_checkpoint: 'review',
      decision_action: 'accept_risk',
      decision_who: 'reviewer',
    });
  });

  it('fix_and_proceed at the gate converts needs_human_review to needs_fix and recommends repair', () => {
    const s = parseSchema(`
params:
  max_attempts: { type: int, default: 2 }
phases:
  - id: review
    requires: []
    produces: [review/review.json]
    gate: review-gate
  - id: review-fix
    requires: [review]
    produces: [review/review.json]
    repair_of: review
    max_attempts_param: max_attempts
gates:
  review-gate:
    reads: [review/review.json]
    needs_human_review_when: "decision == 'needs_human_review'"
`);
    writeJson('review/review.json', { decision: 'needs_human_review' });
    appendEvents(projectRoot, changeId, [{
      source: 'decide',
      type: 'human_decision',
      checkpoint: 'review-gate',
      action: 'fix_and_proceed',
      reason: 'repair requested',
      who: 'reviewer',
      review_file: 'review/review.json',
      review_sha256: sha256File(path.join(changeDir(), 'review/review.json'))!,
    }]);

    const g = checkGate({ schema: s, projectRoot, changeId, phaseId: 'review' });
    expect(g.verdict).toBe('needs_fix');
    expect(g.recommended_phase).toBe('review-fix');
    expect(computeStatus({ schema: s, projectRoot, changeId }).next).toContain('review-fix');
  });

  it('ignores a stale or differently checkpointed decision', () => {
    const s = parseSchema(`
phases:
  - id: first-review
    requires: []
    produces: [review/first.json]
    gate: first-gate
  - id: second-review
    requires: []
    produces: [review/second.json]
    gate: second-gate
gates:
  first-gate:
    reads: [review/first.json]
    needs_human_review_when: "decision == 'needs_human_review'"
  second-gate:
    reads: [review/second.json]
    needs_human_review_when: "decision == 'needs_human_review'"
`);
    writeJson('review/first.json', { decision: 'needs_human_review' });
    writeJson('review/second.json', { decision: 'needs_human_review' });
    const staleHash = sha256File(path.join(changeDir(), 'review/first.json'))!;
    writeJson('review/first.json', { decision: 'needs_human_review', changed: true });
    appendEvents(projectRoot, changeId, [
      {
        source: 'decide',
        type: 'human_decision',
        checkpoint: 'first-gate',
        action: 'accept_risk',
        reason: 'stale',
        who: 'reviewer',
        review_file: 'review/first.json',
        review_sha256: staleHash,
      },
      {
        source: 'decide',
        type: 'human_decision',
        checkpoint: 'second-gate',
        action: 'accept_risk',
        reason: 'another gate',
        who: 'reviewer',
        review_file: 'review/second.json',
        review_sha256: sha256File(path.join(changeDir(), 'review/second.json'))!,
      },
      {
        source: 'decide',
        type: 'human_decision',
        checkpoint: 'first-gate',
        action: 'accept_risk',
        reason: '',
        who: '',
        review_file: 'review/first.json',
        review_sha256: sha256File(path.join(changeDir(), 'review/first.json'))!,
      },
    ]);

    const g = checkGate({ schema: s, projectRoot, changeId, phaseId: 'first-review' });
    expect(g.verdict).toBe('needs_human_review');
    expect(computeStatus({ schema: s, projectRoot, changeId }).pending_decision).toMatchObject({
      checkpoint: 'first-gate',
      phase: 'first-review',
      gate: 'first-gate',
    });
  });

  it('does not fall back to an older valid decision when the latest matching decision is stale', () => {
    const s = parseSchema(`
phases:
  - id: review
    requires: []
    produces: [review/review.json]
    gate: review-gate
gates:
  review-gate:
    reads: [review/review.json]
    needs_human_review_when: "decision == 'needs_human_review'"
`);
    writeJson('review/review.json', { decision: 'needs_human_review' });
    const currentHash = sha256File(path.join(changeDir(), 'review/review.json'))!;
    appendEvents(projectRoot, changeId, [
      {
        source: 'decide', type: 'human_decision', checkpoint: 'review',
        action: 'accept_risk', reason: 'older valid approval', who: 'reviewer',
        review_file: 'review/review.json', review_sha256: currentHash,
      },
      {
        source: 'decide', type: 'human_decision', checkpoint: 'review-gate',
        action: 'accept_risk', reason: 'newer stale approval', who: 'reviewer',
        review_file: 'review/review.json', review_sha256: 'stale-sha',
      },
    ]);

    expect(checkGate({ schema: s, projectRoot, changeId, phaseId: 'review' }).verdict)
      .toBe('needs_human_review');
  });

  it('does not let decisions override reject or codegen hard gates', () => {
    const s = parseSchema(`
phases:
  - id: review
    requires: []
    produces: [review/review.json]
    gate: review-gate
  - id: api-codegen
    requires: []
    produces: [review/codegen.json]
    gate: api-codegen-precondition-gate
gates:
  review-gate:
    reads: [review/review.json]
    reject_when: "decision == 'reject'"
  api-codegen-precondition-gate:
    reads: [review/codegen.json]
    needs_human_review_when: "decision == 'needs_human_review'"
`);
    writeJson('review/review.json', { decision: 'reject' });
    writeJson('review/codegen.json', { decision: 'needs_human_review' });
    appendEvents(projectRoot, changeId, [
      {
        source: 'decide', type: 'human_decision', checkpoint: 'review',
        action: 'accept_risk', reason: 'cannot revive reject', who: 'reviewer',
        review_file: 'review/review.json',
        review_sha256: sha256File(path.join(changeDir(), 'review/review.json'))!,
      },
      {
        source: 'decide', type: 'human_decision', checkpoint: 'api-codegen',
        action: 'accept_risk', reason: 'cannot bypass hard gate', who: 'reviewer',
        review_file: 'review/codegen.json',
        review_sha256: sha256File(path.join(changeDir(), 'review/codegen.json'))!,
      },
    ]);

    expect(checkGate({ schema: s, projectRoot, changeId, phaseId: 'review' }).verdict).toBe('reject');
    expect(checkGate({ schema: s, projectRoot, changeId, phaseId: 'api-codegen' }).verdict)
      .toBe('needs_human_review');
  });

  it('consumes a SHA-bound healing.safety accept_risk decision at fixer-safety-gate', () => {
    const s = parseSchema(`
phases:
  - id: healing-rerun
    requires: []
    produces: []
    gate: fixer-safety-gate
gates:
  fixer-safety-gate:
    reads: [healing/fixer-safety-check.json]
    needs_human_review_when: "needs_review == true"
`);
    writeJson('healing/fixer-safety-check.json', { needs_review: true, passed: false });
    appendEvents(projectRoot, changeId, [{
      source: 'decide',
      type: 'human_decision',
      checkpoint: 'healing.safety',
      action: 'accept_risk',
      reason: 'operator reviewed the safety exception',
      who: 'operator',
      review_file: 'healing/fixer-safety-check.json',
      review_sha256: sha256File(path.join(changeDir(), 'healing/fixer-safety-check.json'))!,
    }]);

    expect(checkGate({ schema: s, projectRoot, changeId, phaseId: 'healing-rerun' }).verdict)
      .toBe('pass');
  });
});

describe('force_continue gate matrix (real schema)', () => {
  let realSchema: Schema;
  beforeAll(() => { realSchema = loadSchemaFromFile(REAL_SCHEMA); });

  function writeState(params: Record<string, unknown>): void {
    fs.writeFileSync(
      path.join(changeDir(), 'workflow-state.yaml'),
      yaml.dump({ params, phases: {} }),
      'utf-8',
    );
  }

  it('defaults force_continue to false', () => {
    expect(realSchema.params.force_continue).toEqual({ type: 'bool', default: false });
  });

  it('human_review_required + pass decision → needs_human_review without force_continue', () => {
    writeState({ force_continue: false });
    writeJson('review/api-plan-review.json', {
      decision: 'pass',
      codegen_readiness: 'ready',
      human_review_required: true,
      risk_level: 'low',
    });
    const g = checkGate({
      schema: realSchema, projectRoot, changeId, phaseId: 'api-plan-review',
    });
    expect(g.verdict).toBe('needs_human_review');
  });

  it('force_continue bypasses human_review_required when decision is already pass', () => {
    writeState({ force_continue: true });
    writeJson('review/api-plan-review.json', {
      decision: 'pass',
      codegen_readiness: 'ready',
      human_review_required: true,
      risk_level: 'high',
    });
    const g = checkGate({
      schema: realSchema, projectRoot, changeId, phaseId: 'api-plan-review',
    });
    expect(g.verdict).toBe('pass');
  });

  it('force_continue cannot bypass explicit decision needs_human_review', () => {
    writeState({ force_continue: true });
    writeJson('review/api-plan-review.json', {
      decision: 'needs_human_review',
      codegen_readiness: 'ready',
      human_review_required: false,
      risk_level: 'low',
    });
    const g = checkGate({
      schema: realSchema, projectRoot, changeId, phaseId: 'api-plan-review',
    });
    expect(g.verdict).toBe('needs_human_review');
  });

  it('case-review: force_continue bypasses human_review_required on pass', () => {
    writeState({ force_continue: true });
    writeJson('review/case-review.json', {
      decision: 'pass',
      human_review_required: true,
    });
    const g = checkGate({
      schema: realSchema, projectRoot, changeId, phaseId: 'case-review',
    });
    expect(g.verdict).toBe('pass');
  });
});

describe('params resolution + healing summary', () => {
  it('defaults params from schema and ignores persisted healing status counters', () => {
    writeWorkflowState({
      params: { run_mode: 'quick', max_healing_attempts: 3 },
      phases: { healing: { status: 'resolved', attempts: [{}, {}] } },
    });
    const e = new Engine({ schema, projectRoot, changeId });
    expect(e.params.run_mode).toBe('quick');
    expect(e.params.max_healing_attempts).toBe(3);
    const r = e.computeStatus();
    expect(r.healing).toEqual({ attempts_used: 0, max: 3, status: 'pending' });
  });

  it('healing defaults to pending with 0 attempts', () => {
    const r = computeStatus({ schema, projectRoot, changeId });
    expect(r.healing.status).toBe('pending');
    expect(r.healing.attempts_used).toBe(0);
  });
});

describe('real workflow-schema.yaml smoke', () => {
  it('computes status without throwing and covers all phases', () => {
    const real = loadSchemaFromFile(REAL_SCHEMA);
    writeWorkflowState({ params: { run_mode: 'full', test_types: ['api', 'e2e'] } });
    const r = computeStatus({ schema: real, projectRoot, changeId });
    expect(r.phases.length).toBe(real.phases.length);
    expect(r.params.run_mode).toBe('full');
    // every phase has a valid status kind
    const kinds = new Set(['pruned', 'out_of_scope', 'blocked', 'ready', 'awaiting_gate', 'done', 'stopped']);
    expect(r.phases.every(p => kinds.has(p.status))).toBe(true);
  });

  it('routes a failed fixer safety check to human review rather than stop', () => {
    const real = loadSchemaFromFile(REAL_SCHEMA);
    writeJson('healing/fixer-safety-check.json', {
      passed: false,
      needs_review: false,
      product_code_modified: true,
      assertion_expected_value_changes_detected: false,
      skip_or_xfail_added: false,
      unrelated_tests_modified: false,
      high_risk_proposal_applied: false,
    });

    expect(new Engine({ schema: real, projectRoot, changeId })
      .resolveGate('fixer-safety-gate').verdict).toBe('needs_human_review');
  });

  it('ignores persisted attempt arrays and stale all_fixers_no_op in loop gates', () => {
    const real = loadSchemaFromFile(REAL_SCHEMA);
    writeWorkflowState({
      params: { max_healing_attempts: 2 },
      phases: {
        execution: { status: 'FAIL' },
        healing: { attempts: [{}, {}], all_fixers_no_op: true },
      },
    });
    fs.mkdirSync(path.join(changeDir(), 'execution'), { recursive: true });
    fs.writeFileSync(
      path.join(changeDir(), 'execution', 'execution-manifest.yaml'),
      yaml.dump({ batch_id: 'b1' }),
    );
    writeJson('inspect/failure-analysis.json', {
      source_batch_id: 'b1',
      failures: [{ case_id: 'TC-1', target: 'api', fix_proposal_eligible: true }],
    });

    expect(new Engine({ schema: real, projectRoot, changeId })
      .resolveGate('healing-loop-gate').verdict).toBe('continue');
  });

  it('stops interactive intake case-design when user approval metadata is missing', () => {
    const real = loadSchemaFromFile(REAL_SCHEMA);
    fs.writeFileSync(
      path.join(changeDir(), 'workflow-state.yaml'),
      yaml.dump({
        params: { run_mode: 'case-only', test_types: ['api', 'e2e'] },
        phases: { skill_registry_check: { status: 'pass' } },
        run_context: {
          orchestrator_skill: 'aws-intake',
          interaction_mode: 'interactive',
          active_scope: 'intake',
        },
      }),
      'utf-8'
    );
    writeJson('explore/advisory.json', { open_questions_for_case_design: [] });
    writeChangeFile('.qa.yaml', yaml.dump({ change: { change_id: changeId } }));
    writeChangeFile('proposal.md', '# proposal\n');
    writeChangeFile('cases/role/case.yaml', 'schema_version: "1.0"\nadded: []\n');

    const r = computeStatus({ schema: real, projectRoot, changeId });
    const phase = r.phases.find(p => p.id === 'case-design')!;
    expect(phase.status).toBe('stopped');
    expect(phase.gate_verdict).toBe('stop');
    expect(r.terminal).toMatchObject({ kind: 'stopped', phase: 'case-design' });
  });

  it('passes interactive intake case-design when approval metadata is present', () => {
    const real = loadSchemaFromFile(REAL_SCHEMA);
    fs.writeFileSync(
      path.join(changeDir(), 'workflow-state.yaml'),
      yaml.dump({
        params: { run_mode: 'case-only', test_types: ['api', 'e2e'] },
        phases: { skill_registry_check: { status: 'pass' } },
        run_context: {
          orchestrator_skill: 'aws-intake',
          interaction_mode: 'interactive',
          active_scope: 'intake',
        },
      }),
      'utf-8'
    );
    writeJson('explore/advisory.json', { open_questions_for_case_design: [] });
    writeChangeFile('.qa.yaml', yaml.dump({
      schema_version: '1.0',
      schema: 'aws',
      created_at: '2026-07-04T07:00:00.000Z',
      change: {
        change_id: changeId,
        requirement_id: 'REQ-001',
        feature_name: 'Case design',
        status: 'draft',
      },
      targets: {
        cases: [{
          module: 'role',
          change_case_file: 'cases/role/case.yaml',
          target_case_file: 'qa/cases/role/case.yaml',
        }],
      },
      approval: {
        approved_by: 'user',
        approved_approach: 'api_e2e_core',
        approved_at: '2026-07-04T07:00:00.000Z',
      },
    }));
    writeChangeFile('proposal.md', '# proposal\n');
    writeChangeFile(
      'cases/role/case.yaml',
      'schema_version: "1.0"\nadded: []\nmodified: []\nremoved: []\n',
    );

    const r = computeStatus({ schema: real, projectRoot, changeId });
    const phase = r.phases.find(p => p.id === 'case-design')!;
    expect(phase.status).toBe('done');
    expect(phase.gate_verdict).toBe('pass');
  });
});

const HEAL_MINI = `
schema_version: "test-heal"
name: heal-mini
params:
  max_healing_attempts: { type: int, default: 3 }
phases:
  - id: inspect
    requires: []
    produces: [inspect.json]
  - id: report
    requires: [inspect]
    ready_when: "state.phases.healing.status in ['not_needed', 'skipped', 'resolved', 'exhausted', 'failed']"
    produces: [report.json]
  - id: fix-proposal
    requires: [inspect]
    produces: [fix.json]
    when: "gate('entry').verdict == 'enter'"
gates:
  entry:
    reads: [workflow-state.yaml]
    enter_when: >
      state.phases.execution.status == 'FAIL'
      and state.phases.healing.attempts_used < params.max_healing_attempts
    skip_when: "state.phases.execution.status == 'PASS'"
`;

describe('ready_when readiness guard', () => {
  let healSchema: Schema;
  beforeEach(() => { healSchema = parseSchema(HEAL_MINI); });

  function healStatusOf(id: string) {
    return computeStatus({ schema: healSchema, projectRoot, changeId }).phases.find(p => p.id === id);
  }

  it('blocks the phase (not ready) while the predicate is undefined — healing never recorded', () => {
    writeJson('inspect.json', { ok: true });
    writeWorkflowState({ phases: { execution: { status: 'PASS' } } });
    const r = computeStatus({ schema: healSchema, projectRoot, changeId });
    const report = healStatusOf('report')!;
    expect(report.status).toBe('blocked');
    expect(report.reason).toContain('ready_when');
    expect(r.next).not.toContain('report');
  });

  it('blocks while healing.status is a mid-loop value', () => {
    writeJson('inspect.json', { ok: true });
    writeWorkflowState({ phases: { healing: { status: 'proposal_created', attempts: [{}] } } });
    expect(healStatusOf('report')!.status).toBe('blocked');
  });

  it('becomes ready once the healing decision is a resting status', () => {
    writeJson('inspect.json', { ok: true });
    fs.mkdirSync(path.join(changeDir(), 'execution'), { recursive: true });
    fs.writeFileSync(
      path.join(changeDir(), 'execution', 'execution-manifest.yaml'),
      yaml.dump({ batch_id: 'b1' }),
    );
    writeWorkflowState({ phases: { healing: { status: 'not_needed', attempts: [] } } });
    appendEvents(projectRoot, changeId, [{
      source: 'status',
      type: 'heal_transition',
      from: 'pending',
      to: 'not_needed',
      source_batch_id: 'b1',
    }]);
    const r = computeStatus({ schema: healSchema, projectRoot, changeId });
    expect(healStatusOf('report')!.status).toBe('ready');
    expect(r.next).toContain('report');
  });

  it('does not retroactively block a phase whose produces already exist', () => {
    writeJson('inspect.json', { ok: true });
    writeJson('report.json', { ok: true });
    // healing.status left unrecorded — the audit layer flags this, not the router
    expect(healStatusOf('report')!.status).toBe('done');
  });

  it('entry gate fires enter when phases.healing is absent (defined() hardening)', () => {
    writeJson('inspect.json', { ok: true });
    writeWorkflowState({ phases: { execution: { status: 'FAIL' } } });
    const fix = healStatusOf('fix-proposal')!;
    expect(fix.status).toBe('ready');
  });

  it('real schema: report stays blocked after inspect until aws state heal records a decision', () => {
    const real = loadSchemaFromFile(REAL_SCHEMA);
    const report = real.phasesById.get('report')!;
    expect(report.ready_when).toContain('state.phases.healing.status');
  });
});

const DISPATCH_MINI = `
schema_version: "1"
name: dispatch-test
params:
  run_mode: { type: enum, values: [full], default: full }
  test_types: { type: list, default: [api] }
  max_healing_attempts: { type: int, default: 0 }
phases:
  - id: design
    skill: aws-case-design
    agent: aws-doc-author
    requires: []
    produces: [design.json]
    gate: design-gate
  - id: skill-registry-check
    skill: null
    requires: []
    produces: [workflow-state.yaml]
    gate: registry-gate
  - id: execution
    skill: null
    requires: [design]
    produces: [run.json]
  - id: mystery-cli
    skill: null
    requires: [design]
    produces: [mystery.json]
loops: {}
gates: {}
`;

describe('resolveNextDispatch', () => {
  let dispatchSchema: Schema;
  beforeAll(() => { dispatchSchema = parseSchema(DISPATCH_MINI); });

  it('maps an agent phase to agent:opencode with skill, agent, and gate', () => {
    const result = resolveNextDispatch(['design'], dispatchSchema);
    expect(result).toEqual<PhaseDispatchEntry[]>([
      {
        phase: 'design',
        kind: 'agent',
        executor: 'agent:opencode',
        skill: 'aws-case-design',
        agent: 'aws-doc-author',
        gate: 'design-gate',
      },
    ]);
  });

  it('maps skill-registry-check to internal executor', () => {
    const result = resolveNextDispatch(['skill-registry-check'], dispatchSchema);
    expect(result).toEqual<PhaseDispatchEntry[]>([
      {
        phase: 'skill-registry-check',
        kind: 'internal',
        executor: 'internal:skill-registry-check',
        skill: null,
        agent: null,
        gate: 'registry-gate',
      },
    ]);
  });

  it('maps execution (skill: null) to cli:aws-run', () => {
    const result = resolveNextDispatch(['execution'], dispatchSchema);
    expect(result).toEqual<PhaseDispatchEntry[]>([
      {
        phase: 'execution',
        kind: 'cli',
        executor: 'cli:aws-run',
        skill: null,
        agent: null,
        gate: null,
      },
    ]);
  });

  it('throws for unknown skill:null phase', () => {
    expect(() => resolveNextDispatch(['mystery-cli'], dispatchSchema))
      .toThrow(/unknown skill:null phase|fail-closed|mystery-cli/i);
  });

  it('returns an empty array for an empty next list', () => {
    expect(resolveNextDispatch([], dispatchSchema)).toEqual([]);
  });

  it('throws for an unknown phase id', () => {
    expect(() => resolveNextDispatch(['ghost'], dispatchSchema))
      .toThrow("resolveNextDispatch: unknown phase 'ghost'");
  });

  it('handles multiple phases in one call', () => {
    const result = resolveNextDispatch(['design', 'execution'], dispatchSchema);
    expect(result).toHaveLength(2);
    expect(result[0].executor).toBe('agent:opencode');
    expect(result[1].executor).toBe('cli:aws-run');
  });

  it('dispatches the real report phase to aws-reporter', () => {
    const realSchema = loadSchemaFromFile(REAL_SCHEMA);
    expect(resolveNextDispatch(['report'], realSchema)).toEqual<PhaseDispatchEntry[]>([
      {
        phase: 'report',
        kind: 'agent',
        executor: 'agent:opencode',
        skill: 'aws-report-generator',
        agent: 'aws-reporter',
        gate: null,
      },
    ]);
  });

  it('dispatches the real archive phase to aws-archiver', () => {
    const realSchema = loadSchemaFromFile(REAL_SCHEMA);
    expect(resolveNextDispatch(['archive'], realSchema)).toEqual<PhaseDispatchEntry[]>([
      {
        phase: 'archive',
        kind: 'agent',
        executor: 'agent:opencode',
        skill: 'aws-archive',
        agent: 'aws-archiver',
        gate: 'archive-gate',
      },
    ]);
  });

  it('dispatches real healing-rerun to cli:aws-run with fixer-safety-gate', () => {
    const realSchema = loadSchemaFromFile(REAL_SCHEMA);
    expect(resolveNextDispatch(['healing-rerun'], realSchema)).toEqual<PhaseDispatchEntry[]>([
      {
        phase: 'healing-rerun',
        kind: 'cli',
        executor: 'cli:aws-run',
        skill: null,
        agent: null,
        gate: 'fixer-safety-gate',
      },
    ]);
  });

  it('dispatches real skill-registry-check to internal executor', () => {
    const realSchema = loadSchemaFromFile(REAL_SCHEMA);
    expect(resolveNextDispatch(['skill-registry-check'], realSchema)[0].executor)
      .toBe('internal:skill-registry-check');
  });
});
