import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { parseSchema, loadSchemaFromFile, Schema } from '../../../src/orchestration/schema';
import { Engine, computeStatus, checkGate, resolveNextDispatch, PhaseDispatchEntry } from '../../../src/orchestration/engine';

const REAL_SCHEMA = path.resolve(__dirname, '../../../docs/design/workflow-schema.yaml');

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
  writeChangeFile(rel, JSON.stringify(obj));
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
    fs.writeFileSync(
      path.join(changeDir(), 'workflow-state.yaml'),
      yaml.dump({ params: { run_mode: 'quick' } }),
      'utf-8'
    );
    writeJson('design.json', { ok: true });
    writeJson('review.json', { decision: 'pass' });
    writeJson('codegen.json', { ok: true });
    expect(statusOf('build')!.status).toBe('pruned');
    // exec requires [build(pruned), codegen(done)] any_active → not blocked
    expect(statusOf('exec')!.status).toBe('ready');
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
});

describe('params resolution + healing summary', () => {
  it('defaults from schema, overridden by workflow-state params', () => {
    fs.writeFileSync(
      path.join(changeDir(), 'workflow-state.yaml'),
      yaml.dump({
        params: { run_mode: 'quick', max_healing_attempts: 3 },
        phases: { healing: { status: 'resolved', attempts: [{}, {}] } },
      }),
      'utf-8'
    );
    const e = new Engine({ schema, projectRoot, changeId });
    expect(e.params.run_mode).toBe('quick');
    expect(e.params.max_healing_attempts).toBe(3);
    const r = e.computeStatus();
    expect(r.healing).toEqual({ attempts_used: 2, max: 3, status: 'resolved' });
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
    fs.writeFileSync(
      path.join(changeDir(), 'workflow-state.yaml'),
      yaml.dump({ params: { run_mode: 'full', test_types: ['api', 'e2e'] } }),
      'utf-8'
    );
    const r = computeStatus({ schema: real, projectRoot, changeId });
    expect(r.phases.length).toBe(real.phases.length);
    expect(r.params.run_mode).toBe('full');
    // every phase has a valid status kind
    const kinds = new Set(['pruned', 'blocked', 'ready', 'awaiting_gate', 'done', 'stopped']);
    expect(r.phases.every(p => kinds.has(p.status))).toBe(true);
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
    agent: aws-author
    requires: []
    produces: [design.json]
  - id: run
    skill: null
    requires: [design]
    produces: [run.json]
loops: {}
gates: {}
`;

describe('resolveNextDispatch', () => {
  let dispatchSchema: Schema;
  beforeAll(() => { dispatchSchema = parseSchema(DISPATCH_MINI); });

  it('maps an agent phase to kind:agent with skill and agent', () => {
    const result = resolveNextDispatch(['design'], dispatchSchema);
    expect(result).toEqual<PhaseDispatchEntry[]>([
      { phase: 'design', kind: 'agent', skill: 'aws-case-design', agent: 'aws-author' },
    ]);
  });

  it('maps a CLI phase (skill: null) to kind:cli with null skill and agent', () => {
    const result = resolveNextDispatch(['run'], dispatchSchema);
    expect(result).toEqual<PhaseDispatchEntry[]>([
      { phase: 'run', kind: 'cli', skill: null, agent: null },
    ]);
  });

  it('returns an empty array for an empty next list', () => {
    expect(resolveNextDispatch([], dispatchSchema)).toEqual([]);
  });

  it('throws for an unknown phase id', () => {
    expect(() => resolveNextDispatch(['ghost'], dispatchSchema))
      .toThrow("resolveNextDispatch: unknown phase 'ghost'");
  });

  it('handles multiple phases in one call', () => {
    const result = resolveNextDispatch(['design', 'run'], dispatchSchema);
    expect(result).toHaveLength(2);
    expect(result[0].kind).toBe('agent');
    expect(result[1].kind).toBe('cli');
  });

  it('dispatches the real report phase to aws-reporter', () => {
    const realSchema = loadSchemaFromFile(REAL_SCHEMA);
    expect(resolveNextDispatch(['report'], realSchema)).toEqual<PhaseDispatchEntry[]>([
      { phase: 'report', kind: 'agent', skill: 'aws-report-generator', agent: 'aws-reporter' },
    ]);
  });

  it('dispatches the real archive phase to aws-archiver', () => {
    const realSchema = loadSchemaFromFile(REAL_SCHEMA);
    expect(resolveNextDispatch(['archive'], realSchema)).toEqual<PhaseDispatchEntry[]>([
      { phase: 'archive', kind: 'agent', skill: 'aws-archive', agent: 'aws-archiver' },
    ]);
  });
});
