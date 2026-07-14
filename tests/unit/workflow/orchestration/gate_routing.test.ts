import { decideGate } from '../../../../src/workflow/orchestration/gate_routing';

describe('decideGate', () => {
  it('routes pass to continue', () => {
    expect(decideGate({
      verdict: 'pass', recommended_phase: null, gate: 'x', phase: 'p',
    })).toEqual({ action: 'continue' });
  });

  it('routes needs_fix with recommended_phase', () => {
    expect(decideGate({
      verdict: 'needs_fix', recommended_phase: 'api-plan-fix', gate: 'g', phase: 'api-plan-review',
    })).toEqual({ action: 'needs_fix', recommended_phase: 'api-plan-fix' });
  });

  it('fails needs_fix without recommended_phase', () => {
    expect(decideGate({
      verdict: 'needs_fix', recommended_phase: null, gate: 'g', phase: 'p',
    }).action).toBe('fail');
  });

  it('routes needs_human_review', () => {
    expect(decideGate({
      verdict: 'needs_human_review', recommended_phase: null, gate: 'g', phase: 'p',
    }).action).toBe('needs_human_review');
  });

  it('routes reject/stop to stopped exit 20', () => {
    expect(decideGate({
      verdict: 'reject', recommended_phase: null, gate: 'g', phase: 'p',
    })).toMatchObject({ action: 'stopped', exitCode: 20 });
    expect(decideGate({
      verdict: 'stop', recommended_phase: null, gate: 'g', phase: 'p',
    })).toMatchObject({ action: 'stopped', exitCode: 20 });
  });

  it('accepts enter/skip only for healing-entry-gate', () => {
    expect(decideGate({
      verdict: 'enter', recommended_phase: null, gate: 'healing-entry-gate', phase: null,
    }).action).toBe('healing_enter');
    expect(decideGate({
      verdict: 'enter', recommended_phase: null, gate: 'other', phase: null,
    }).action).toBe('fail');
    expect(decideGate({
      verdict: 'skip', recommended_phase: null, gate: 'healing-entry-gate', phase: null,
    }).action).toBe('healing_skip');
  });

  it('accepts continue/exit only for healing-loop-gate', () => {
    expect(decideGate({
      verdict: 'continue', recommended_phase: null, gate: 'healing-loop-gate', phase: null,
    }).action).toBe('healing_continue');
    expect(decideGate({
      verdict: 'exit', recommended_phase: null, gate: 'healing-loop-gate', phase: null,
    }).action).toBe('healing_exit');
  });

  it('fail-closes unknown verdicts', () => {
    expect(decideGate({
      verdict: 'weird', recommended_phase: null, gate: 'g', phase: 'p',
    })).toMatchObject({ action: 'fail', exitCode: 40 });
  });
});
