import { runReviewFixLoop } from '../../../src/driver/review_fix_loop';
import { createStubAdapter } from '../../../src/driver/headless_adapter';
import type { ProcessRunner, ProcessResult } from '../../../src/driver/process_runner';
import type { GateReport, PhaseDispatchEntry } from '../../../src/orchestration/engine';

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
    let gateChecks = 0;
    const calls: string[] = [];
    const applies: Array<{ phase: string; skill?: string; minMtimeMs?: number }> = [];
    const runner: ProcessRunner = {
      runAws(args): ProcessResult {
        calls.push(args.join(' '));
        if (args[0] === 'state' && args[1] === 'apply') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (args[0] === 'gate') {
          gateChecks += 1;
          const g = gate({ verdict: 'pass' });
          return { exitCode: 0, stdout: JSON.stringify(g), stderr: '' };
        }
        return { exitCode: 1, stdout: '', stderr: 'unexpected' };
      },
    };

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
    const result = await runReviewFixLoop(
      'api-plan-review',
      gate({ verdict: 'needs_fix', recommended_phase: 'api-plan-fix' }),
      {
        projectRoot: '/tmp',
        changeId: 'c',
        runner,
        adapter,
        maxAttempts: 3,
        resolveDispatch,
        applyPhase: (_root, _change, phase, options) => {
          applies.push({
            phase,
            skill: options?.skillMdPath,
            minMtimeMs: options?.minMtimeMs,
          });
        },
        skillMdPathFor: skill => `/skills/${skill}/SKILL.md`,
      },
    );

    expect(result).toEqual({ kind: 'pass' });
    expect(adapter.prompts.length).toBe(2); // fixer + reviewer
    expect(gateChecks).toBe(1);
    expect(calls.some(c => c.startsWith('state apply'))).toBe(false);
    expect(applies.map(apply => apply.phase)).toEqual(['api-plan-fix', 'api-plan-review']);
    expect(applies.every(apply => apply.skill?.endsWith('/SKILL.md'))).toBe(true);
    expect(applies.every(apply => typeof apply.minMtimeMs === 'number')).toBe(true);
  });

  it('exhausts when still needs_fix after max attempts', async () => {
    const runner: ProcessRunner = {
      runAws(args): ProcessResult {
        if (args[0] === 'state') return { exitCode: 0, stdout: '', stderr: '' };
        if (args[0] === 'gate') {
          return {
            exitCode: 30,
            stdout: JSON.stringify(gate({
              verdict: 'needs_fix',
              recommended_phase: 'api-plan-fix',
            })),
            stderr: '',
          };
        }
        return { exitCode: 1, stdout: '', stderr: 'x' };
      },
    };
    const resolveDispatch = (phase: string): PhaseDispatchEntry => ({
      phase,
      kind: 'agent',
      executor: 'agent:opencode',
      skill: phase.includes('fix') ? 'fixer' : 'reviewer',
      agent: 'aws-doc-author',
      gate: null,
    });

    const result = await runReviewFixLoop(
      'api-plan-review',
      gate({ verdict: 'needs_fix', recommended_phase: 'api-plan-fix' }),
      {
        projectRoot: '/tmp',
        changeId: 'c',
        runner,
        adapter: createStubAdapter(),
        maxAttempts: 2,
        resolveDispatch,
        applyPhase: () => undefined,
      },
    );
    expect(result.kind).toBe('exhausted');
  });
});
