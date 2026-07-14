import { runReviewFixLoop } from '../../../src/driver/review_fix_loop';
import { createStubAdapter } from '../../../src/driver/headless_adapter';
import type { GateReport, PhaseDispatchEntry } from '../../../src/orchestration/engine';
import type { ProgressSnapshot } from '../../../src/orchestration/progression';
import { decideGate } from '../../../src/orchestration/gate_routing';

function gate(partial: Partial<GateReport> & Pick<GateReport, 'verdict'>): GateReport {
  return {
    schema_version: '1',
    change_id: 'c',
    phase: 'api-plan-review',
    gate: 'api-plan-review-gate',
    reads: [],
    evidence: {},
    matched_rule: null,
    recommended_phase: null,
    ...partial,
  };
}

describe('review_fix_loop', () => {
  it('runs fixer → apply → reviewer → apply → gate until pass', async () => {
    const applies: Array<{ phase: string; skill?: string; minMtimeMs?: number }> = [];

    const resolveDispatch = (phase: string): PhaseDispatchEntry => {
      if (phase === 'api-plan-fix') {
        return {
          phase, kind: 'agent', executor: 'agent:opencode',
          skill: 'aws-api-plan-fixer', agent: 'aws-doc-author', gate: null,
        };
      }
      return {
        phase: 'api-plan-review', kind: 'agent', executor: 'agent:opencode',
        skill: 'aws-api-plan-reviewer', agent: 'aws-reviewer', gate: 'api-plan-review-gate',
      };
    };

    const adapter = createStubAdapter();
    const progression = {
      inspect: () => ({} as ProgressSnapshot),
      resolveRepair: () => ({ phase: 'api-plan-fix', maxAttempts: 3, attemptsUsed: 0 }),
      decideGate,
      applyOutcome: (outcome: { phase: string; skillMdPath?: string; minMtimeMs?: number }) => {
        applies.push({
          phase: outcome.phase,
          skill: outcome.skillMdPath,
          minMtimeMs: outcome.minMtimeMs,
        });
        return {
          snapshot: {} as ProgressSnapshot,
          gate: outcome.phase === 'api-plan-review' ? gate({ verdict: 'pass' }) : null,
          decision: null,
          replayed: false,
        };
      },
    };
    const result = await runReviewFixLoop(
      'api-plan-review',
      gate({ verdict: 'needs_fix', recommended_phase: 'api-plan-fix' }),
      {
        projectRoot: '/tmp',
        changeId: 'c',
        adapter,
        resolveDispatch,
        progression,
        skillMdPathFor: skill => `/skills/${skill}/SKILL.md`,
      },
    );

    expect(result).toEqual({ kind: 'pass' });
    expect(adapter.prompts.length).toBe(2); // fixer + reviewer
    expect(applies.map(apply => apply.phase)).toEqual(['api-plan-fix', 'api-plan-review']);
    expect(applies.every(apply => apply.skill?.endsWith('/SKILL.md'))).toBe(true);
    expect(applies[0].minMtimeMs).toBeUndefined();
    expect(typeof applies[1].minMtimeMs).toBe('number');
  });

  it('exhausts when still needs_fix after max attempts', async () => {
    const resolveDispatch = (phase: string): PhaseDispatchEntry => ({
      phase,
      kind: 'agent',
      executor: 'agent:opencode',
      skill: phase.includes('fix') ? 'fixer' : 'reviewer',
      agent: 'aws-doc-author',
      gate: null,
    });
    const progression = {
      inspect: () => ({} as ProgressSnapshot),
      resolveRepair: () => ({ phase: 'api-plan-fix', maxAttempts: 2, attemptsUsed: 0 }),
      decideGate,
      applyOutcome: (outcome: { phase: string }) => ({
        snapshot: {} as ProgressSnapshot,
        gate: outcome.phase === 'api-plan-review'
          ? gate({ verdict: 'needs_fix', recommended_phase: 'api-plan-fix' })
          : null,
        decision: null,
        replayed: false,
      }),
    };

    const result = await runReviewFixLoop(
      'api-plan-review',
      gate({ verdict: 'needs_fix', recommended_phase: 'api-plan-fix' }),
      {
        projectRoot: '/tmp',
        changeId: 'c',
        adapter: createStubAdapter(),
        resolveDispatch,
        progression,
      },
    );
    expect(result.kind).toBe('exhausted');
  });
});
