import * as path from 'path';
import { buildRetroContext } from '../../../src/retro/aggregator';

const fixtureRoot = path.join(
  __dirname,
  '../../retro/fixtures/project'
);

describe('buildRetroContext', () => {
  it('aggregates archived evidence into deterministic retro signals', () => {
    const context = buildRetroContext(fixtureRoot, {
      since: '2026-07-01T00:00:00.000Z',
      now: '2026-07-08T00:00:00.000Z',
      retroId: 'retro-test',
    });

    expect(context.retro_id).toBe('retro-test');
    expect(context.window.change_ids).toEqual(['RET-a', 'RET-b']);
    expect(context.signals.failure_distribution).toEqual([
      {
        category: 'test_data_failure',
        count: 2,
        changes: ['RET-a', 'RET-b'],
        top_modules: ['depts'],
        evidence_ids: ['RET-a#heal-proposal:fix-dept-name-1', 'RET-b#fail-1'],
      },
      {
        category: 'perf_threshold_exceeded',
        count: 1,
        changes: ['RET-b'],
        top_modules: ['depts'],
        evidence_ids: ['RET-b#fail-2'],
      },
    ]);
    expect(context.signals.gate_pushback[0]).toMatchObject({
      gate: 'api-plan-review-gate',
      verdict: 'stop',
      count: 2,
    });
    expect(context.signals.gate_pushback[0].top_reasons).toEqual([
      '(no evidence)',
      'assertion_traceability missing',
    ]);
    expect(context.signals.human_overrides[0]).toMatchObject({
      phase: 'e2e-plan-review',
      action: 'fix_and_proceed',
      count: 1,
    });
    expect(context.signals.skill_execution).toEqual([
      {
        phase: 'inspect',
        count: 1,
        changes: ['RET-a'],
        evidence_ids: ['RET-a#workflow-state:inspect'],
      },
      {
        phase: 'report',
        count: 1,
        changes: ['RET-a'],
        evidence_ids: ['RET-a#workflow-state:report'],
      },
    ]);
    expect(context.signals.healing_efficiency.proposal_created).toBe(1);
    expect(context.signals.healing_efficiency.applied).toBe(1);
    expect(context.signals.healing_efficiency.resolved).toBe(1);
    expect(context.signals.healing_efficiency.created_proposals).toBe(5);
    expect(context.signals.healing_efficiency.applied_proposals).toBe(5);
  });
});
