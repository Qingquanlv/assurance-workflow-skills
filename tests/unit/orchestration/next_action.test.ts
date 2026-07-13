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

describe('deriveNextAction — base routing', () => {
  const schema = { phases: [], phasesById: new Map(), gates: {}, loops: {} } as any;

  it('projects a dispatch_phase for the first pending phase', () => {
    const snap = snapshot({});
    snap.nextActions = [{ phase: 'design', kind: 'agent', skill: 'aws-design' } as any];
    const action = deriveNextAction(snap, { schema });
    expect(action.kind).toBe('dispatch_phase');
    expect(action).toMatchObject({ phase: 'design' });
  });

  it('projects terminal completed', () => {
    const action = deriveNextAction(
      snapshot({ terminal: { kind: 'completed', reason: 'all gates passed' } as any }),
      { schema },
    );
    expect(action).toMatchObject({ kind: 'terminal', status: 'completed', exitCode: 0 });
  });

  it('projects terminal stopped with exit 20', () => {
    const action = deriveNextAction(
      snapshot({ terminal: { kind: 'stopped', reason: 'gate reject' } as any }),
      { schema },
    );
    expect(action).toMatchObject({ kind: 'terminal', status: 'stopped', exitCode: 20 });
  });

  it('projects pause_for_human from pending_decision', () => {
    const action = deriveNextAction(
      snapshot({ pending_decision: { phase: 'review', reason: 'needs human' } as any }),
      { schema },
    );
    expect(action).toMatchObject({ kind: 'pause_for_human', checkpoint: 'review', reason: 'needs human' });
  });
});
