import { deriveNextAction } from '../../../src/orchestration/next_action';
import type { ProgressSnapshot } from '../../../src/orchestration/progression';

function snapshot(partial: Partial<ProgressSnapshot['report']>): ProgressSnapshot {
  return {
    report: {
      terminal: null,
      pending_decision: null,
      next: [],
      params: {},
      phases: [],
      ...partial,
    } as ProgressSnapshot['report'],
    nextActions: [],
    auditIssues: [],
    healingEpisode: {
      state: 'inactive',
      episodeId: null,
      attemptKey: null,
      attemptNumber: 0,
      stage: null,
      nextActions: [],
    } as ProgressSnapshot['healingEpisode'],
  };
}

function gateEvents(
  phase: string,
  verdict: string,
  gate = 'review-gate',
): Array<{ type: string; phase: string; verdict: string; gate: string }> {
  return [
    { type: 'gate_verdict', phase, verdict, gate },
    { type: 'phase_outcome_committed', phase, attempt_id: `${phase}#1` } as any,
  ];
}

describe('deriveNextAction — base routing', () => {
  const schema = { phases: [], phasesById: new Map(), gates: {}, loops: {} } as any;

  it('projects a dispatch_phase for the first pending phase', () => {
    const snap = snapshot({});
    snap.nextActions = [{ phase: 'design', kind: 'agent', skill: 'aws-design' } as any];
    const action = deriveNextAction(snap, { schema, events: [] });
    expect(action.kind).toBe('dispatch_phase');
    expect(action).toMatchObject({ phase: 'design' });
  });

  it('projects terminal completed', () => {
    const action = deriveNextAction(
      snapshot({ terminal: { kind: 'completed', reason: 'all gates passed' } as any }),
      { schema, events: [] },
    );
    expect(action).toMatchObject({ kind: 'terminal', status: 'completed', exitCode: 0 });
  });

  it('projects terminal stopped with exit 20', () => {
    const action = deriveNextAction(
      snapshot({ terminal: { kind: 'stopped', reason: 'gate reject' } as any }),
      { schema, events: [] },
    );
    expect(action).toMatchObject({ kind: 'terminal', status: 'stopped', exitCode: 20 });
  });

  it('projects pause_for_human from pending_decision', () => {
    const action = deriveNextAction(
      snapshot({ pending_decision: { phase: 'review', reason: 'needs human' } as any }),
      { schema, events: [] },
    );
    expect(action).toMatchObject({ kind: 'pause_for_human', checkpoint: 'review', reason: 'needs human' });
  });
});

describe('deriveNextAction — gate folding', () => {
  const schema = {
    phases: [{ id: 'api-fixer', repair_of: 'review', max_attempts_param: 'max_fix_attempts' }],
    phasesById: new Map([
      ['review', { id: 'review' }],
      ['api-fixer', { id: 'api-fixer', repair_of: 'review', max_attempts_param: 'max_fix_attempts' }],
    ]),
    gates: {},
    loops: {},
  } as any;

  it('needs_fix routes to the schema repair phase with budget remaining', () => {
    const snap = snapshot({ params: { max_fix_attempts: 3 } });
    const events = gateEvents('review', 'needs_fix') as any;
    const action = deriveNextAction(snap, { schema, events });
    expect(action).toMatchObject({ kind: 'dispatch_phase', phase: 'api-fixer' });
  });

  it('needs_fix with budget exhausted routes to terminal exhausted', () => {
    const snap = snapshot({ params: { max_fix_attempts: 1 } });
    const events = [
      ...gateEvents('review', 'needs_fix'),
      { type: 'dispatch_signed', phase: 'api-fixer', attempt_id: 'api-fixer#1' },
    ] as any;
    const action = deriveNextAction(snap, { schema, events });
    expect(action).toMatchObject({ kind: 'terminal', status: 'exhausted', exitCode: 40 });
  });

  it('needs_human_review routes to pause', () => {
    const snap = snapshot({});
    const events = gateEvents('review', 'needs_human_review', 'review-gate') as any;
    const action = deriveNextAction(snap, { schema, events });
    expect(action).toMatchObject({ kind: 'pause_for_human', checkpoint: 'review' });
  });

  it('stop routes to terminal stopped', () => {
    const snap = snapshot({});
    const events = gateEvents('review', 'stop', 'review-gate') as any;
    const action = deriveNextAction(snap, { schema, events });
    expect(action).toMatchObject({ kind: 'terminal', status: 'stopped', exitCode: 20 });
  });
});

describe('deriveNextAction — healing (coarse grained)', () => {
  const schema = {
    phases: [],
    phasesById: new Map(),
    gates: {},
    loops: { healing: { max_param: 'max_healing_attempts' } },
  } as any;
  const ctx = { schema, events: [], healingTarget: 'api' as const };

  it('projects a heal action for an active episode under budget', () => {
    const snap = snapshot({ params: { max_healing_attempts: 3 } });
    snap.healingEpisode = {
      state: 'active',
      episodeId: 'ep-1',
      attemptKey: 'heal-api#1',
      attemptNumber: 1,
      stage: 'proposal_required',
      nextActions: [{ kind: 'dispatch_phase', phase: 'fix-proposal' }],
    };
    const action = deriveNextAction(snap, ctx);
    expect(action).toMatchObject({
      kind: 'heal',
      target: 'api',
      attemptNumber: 2,
      maxAttempts: 3,
      expectedEvidence: ['healing/api-apply-summary.json', 'healing/fix-proposal.json'],
      attemptId: '',
      stateGuard: '',
    });
  });

  it('projects terminal exhausted when healing budget spent', () => {
    const snap = snapshot({ params: { max_healing_attempts: 2 } });
    snap.healingEpisode = {
      state: 'active',
      episodeId: 'ep-1',
      attemptKey: 'heal-api#2',
      attemptNumber: 2,
      stage: 'proposal_required',
      nextActions: [{ kind: 'dispatch_phase', phase: 'fix-proposal' }],
    };
    const action = deriveNextAction(snap, ctx);
    expect(action).toMatchObject({ kind: 'terminal', status: 'exhausted', exitCode: 40 });
  });

  it('projects pause_for_human when a healing safety gate needs a decision', () => {
    const snap = snapshot({ params: { max_healing_attempts: 3 } });
    snap.healingEpisode = {
      state: 'awaiting_human',
      episodeId: 'ep-1',
      attemptKey: 'heal-api#1',
      attemptNumber: 1,
      stage: 'awaiting_human',
      nextActions: [
        { kind: 'await_human', checkpoint: 'healing.safety', reason: 'unrelated tests modified' },
      ],
    };
    const action = deriveNextAction(snap, ctx);
    expect(action).toMatchObject({
      kind: 'pause_for_human',
      checkpoint: 'healing.safety',
      reason: 'unrelated tests modified',
    });
  });

  it('inactive healing episode falls through to base phase dispatch (skip path)', () => {
    const snap = snapshot({ params: { max_healing_attempts: 3 } });
    snap.nextActions = [{ phase: 'execution', kind: 'cli' } as any];
    const action = deriveNextAction(snap, ctx);
    expect(action).toMatchObject({ kind: 'dispatch_phase', phase: 'execution' });
  });

  it('applied-resume at max budget still projects heal to finish in-flight attempt', () => {
    const snap = snapshot({ params: { max_healing_attempts: 1 } });
    snap.healingEpisode = {
      state: 'active',
      episodeId: 'ep-1',
      attemptKey: 'proposal-sha:batch-1',
      attemptNumber: 1,
      stage: 'rerun_required',
      nextActions: [{ kind: 'dispatch_phase', phase: 'healing-rerun' }],
    };
    const action = deriveNextAction(snap, ctx);
    expect(action).toMatchObject({ kind: 'heal', target: 'api', attemptNumber: 2 });
  });
});

describe('deriveNextAction — scenario regressions (S1–S5)', () => {
  const repairSchema = {
    phases: [{ id: 'api-fixer', repair_of: 'review', max_attempts_param: 'max_fix_attempts' }],
    phasesById: new Map([
      ['review', { id: 'review' }],
      ['api-fixer', { id: 'api-fixer', repair_of: 'review', max_attempts_param: 'max_fix_attempts', produces: ['plans/api-plan.md'] }],
      ['verify', { id: 'verify', produces: [] }],
    ]),
    gates: {},
    loops: {},
  } as any;

  it('S1: pass gate verdict falls through to next pending phase', () => {
    const snap = snapshot({});
    snap.nextActions = [{ phase: 'verify', kind: 'agent' } as any];
    const events = gateEvents('review', 'pass') as any;
    const action = deriveNextAction(snap, { schema: repairSchema, events });
    expect(action).toMatchObject({ kind: 'dispatch_phase', phase: 'verify' });
  });

  it('S2: needs_fix then fixer dispatched without a phase_dispatched workaround', () => {
    const events = [
      { type: 'gate_verdict', phase: 'review', verdict: 'needs_fix', gate: 'review-gate' },
      { type: 'phase_outcome_committed', phase: 'review', attempt_id: 'review#1' },
    ] as any;
    const snap = snapshot({ params: { max_fix_attempts: 3 } });
    const action = deriveNextAction(snap, { schema: repairSchema, events });
    expect(action).toMatchObject({ kind: 'dispatch_phase', phase: 'api-fixer' });
  });

  it('S3: second fixer attempt still dispatches when prior dispatch_signed exists', () => {
    const events = [
      ...gateEvents('review', 'needs_fix'),
      { type: 'dispatch_signed', phase: 'api-fixer', attempt_id: 'api-fixer#1' },
      { type: 'phase_outcome_committed', phase: 'api-fixer', attempt_id: 'api-fixer#1' },
      { type: 'gate_verdict', phase: 'review', verdict: 'needs_fix', gate: 'review-gate' },
      { type: 'phase_outcome_committed', phase: 'review', attempt_id: 'review#2' },
    ] as any;
    const snap = snapshot({ params: { max_fix_attempts: 3 } });
    const action = deriveNextAction(snap, { schema: repairSchema, events });
    expect(action).toMatchObject({ kind: 'dispatch_phase', phase: 'api-fixer' });
  });

  it('S4: repair budget exhausted yields terminal exhausted', () => {
    const snap = snapshot({ params: { max_fix_attempts: 1 } });
    const events = [
      ...gateEvents('review', 'needs_fix'),
      { type: 'dispatch_signed', phase: 'api-fixer', attempt_id: 'api-fixer#1' },
    ] as any;
    const action = deriveNextAction(snap, { schema: repairSchema, events });
    expect(action).toMatchObject({ kind: 'terminal', status: 'exhausted', exitCode: 40 });
  });

  it('S5: needs_human_review yields pause_for_human', () => {
    const snap = snapshot({});
    const events = gateEvents('review', 'needs_human_review', 'review-gate') as any;
    const action = deriveNextAction(snap, { schema: repairSchema, events });
    expect(action).toMatchObject({ kind: 'pause_for_human', checkpoint: 'review' });
  });

  it('reject gate verdict routes to terminal stopped', () => {
    const snap = snapshot({});
    const events = gateEvents('review', 'reject', 'review-gate') as any;
    const action = deriveNextAction(snap, { schema: repairSchema, events });
    expect(action).toMatchObject({ kind: 'terminal', status: 'stopped', exitCode: 20 });
  });
});
