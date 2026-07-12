import { routeGateVerdict } from '../../../src/driver/gate_router';

describe('gate_router', () => {
  it('routes pass to continue', () => {
    expect(routeGateVerdict({
      verdict: 'pass', recommended_phase: null, gate: 'x', phase: 'p',
    })).toEqual({ action: 'continue' });
  });

  it('routes needs_fix with recommended_phase', () => {
    expect(routeGateVerdict({
      verdict: 'needs_fix', recommended_phase: 'api-plan-fix', gate: 'g', phase: 'api-plan-review',
    })).toEqual({ action: 'needs_fix', recommended_phase: 'api-plan-fix' });
  });

  it('fails needs_fix without recommended_phase', () => {
    expect(routeGateVerdict({
      verdict: 'needs_fix', recommended_phase: null, gate: 'g', phase: 'p',
    }).action).toBe('fail');
  });

  it('routes needs_human_review', () => {
    expect(routeGateVerdict({
      verdict: 'needs_human_review', recommended_phase: null, gate: 'g', phase: 'p',
    }).action).toBe('needs_human_review');
  });

  it('routes reject/stop to stopped exit 20', () => {
    expect(routeGateVerdict({
      verdict: 'reject', recommended_phase: null, gate: 'g', phase: 'p',
    })).toMatchObject({ action: 'stopped', exitCode: 20 });
    expect(routeGateVerdict({
      verdict: 'stop', recommended_phase: null, gate: 'g', phase: 'p',
    })).toMatchObject({ action: 'stopped', exitCode: 20 });
  });

  it('accepts enter/skip only for healing-entry-gate', () => {
    expect(routeGateVerdict({
      verdict: 'enter', recommended_phase: null, gate: 'healing-entry-gate', phase: null,
    }).action).toBe('healing_enter');
    expect(routeGateVerdict({
      verdict: 'enter', recommended_phase: null, gate: 'other', phase: null,
    }).action).toBe('fail');
    expect(routeGateVerdict({
      verdict: 'skip', recommended_phase: null, gate: 'healing-entry-gate', phase: null,
    }).action).toBe('healing_skip');
  });

  it('accepts continue/exit only for healing-loop-gate', () => {
    expect(routeGateVerdict({
      verdict: 'continue', recommended_phase: null, gate: 'healing-loop-gate', phase: null,
    }).action).toBe('healing_continue');
    expect(routeGateVerdict({
      verdict: 'exit', recommended_phase: null, gate: 'healing-loop-gate', phase: null,
    }).action).toBe('healing_exit');
  });

  it('fail-closes unknown verdicts', () => {
    expect(routeGateVerdict({
      verdict: 'weird', recommended_phase: null, gate: 'g', phase: 'p',
    })).toMatchObject({ action: 'fail', exitCode: 40 });
  });
});
