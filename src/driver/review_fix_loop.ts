import type { PhaseAgentAdapter } from './adapter';
import type { ProcessRunner } from './process_runner';
import { parseJsonStdout } from './process_runner';
import { buildPhasePrompt } from './phase_prompt';
import { routeGateVerdict } from './gate_router';
import { appendEvents, buildDriverEvent } from '../core/events';
import type { GateReport, PhaseDispatchEntry } from '../orchestration/engine';
import { applyPhaseState } from '../core/workflow_state';

export interface ReviewFixLoopDeps {
  projectRoot: string;
  changeId: string;
  runner: ProcessRunner;
  adapter: PhaseAgentAdapter;
  maxAttempts: number;
  resolveDispatch: (phase: string) => PhaseDispatchEntry;
  skillMdPathFor?: (skill: string) => string | undefined;
  applyPhase?: typeof applyPhaseState;
  /**
   * Driver run id, used to log a `phase_dispatched` event for each fixer
   * attempt. Once a repair phase's status is already `done` (e.g. its
   * first attempt succeeded but the review streak re-opens on a later
   * attempt), re-running `state apply` for it is a no-op transition and
   * emits no fresh `phase_transition ... to=done` event — the signal
   * `auditVerdictTransitions` uses to prove a repair happened. Logging
   * `phase_dispatched` here gives the audit a per-attempt, dedup-proof
   * trail so legitimate multi-attempt fixer loops aren't flagged
   * GATE-TRANSITION-ILLEGAL. Optional only for legacy test callers that
   * don't care about audit evidence.
   */
  runId?: string;
}

export type ReviewFixLoopResult =
  | { kind: 'pass' }
  | { kind: 'needs_human_review'; reason: string }
  | { kind: 'stopped'; reason: string; exitCode: 20 }
  | { kind: 'exhausted'; reason: string; exitCode: 40 };

/**
 * needs_fix → fixer → state apply fixer → reviewer → state apply reviewer → gate.
 * Reviewer must produce a fresh review JSON each cycle.
 */
export async function runReviewFixLoop(
  reviewerPhase: string,
  initialGate: GateReport,
  deps: ReviewFixLoopDeps,
): Promise<ReviewFixLoopResult> {
  let gate = initialGate;
  let attempts = 0;

  while (gate.verdict === 'needs_fix') {
    attempts++;
    if (attempts > deps.maxAttempts) {
      return {
        kind: 'exhausted',
        reason: `review fix attempts exhausted for ${reviewerPhase} (max=${deps.maxAttempts})`,
        exitCode: 40,
      };
    }

    const routed = routeGateVerdict(gate);
    if (routed.action !== 'needs_fix') {
      break;
    }

    const fixerEntry = deps.resolveDispatch(routed.recommended_phase);
    if (fixerEntry.kind !== 'agent' || !fixerEntry.skill) {
      return {
        kind: 'exhausted',
        reason: `fixer phase ${routed.recommended_phase} is not an agent phase`,
        exitCode: 40,
      };
    }

    if (deps.runId) {
      appendEvents(deps.projectRoot, deps.changeId, [
        buildDriverEvent('phase_dispatched', deps.runId, { phase: routed.recommended_phase }),
      ]);
    }
    const fixerSession = await deps.adapter.createPhaseSession({
      title: `Phase ${routed.recommended_phase} attempt ${attempts}`,
    });
    const fixerDispatchAt = Date.now();
    await deps.adapter.promptSync(fixerSession.id, {
      agent: fixerEntry.agent,
      text: buildPhasePrompt(fixerEntry.skill, routed.recommended_phase, deps.changeId),
    });

    try {
      (deps.applyPhase ?? applyPhaseState)(
        deps.projectRoot,
        deps.changeId,
        routed.recommended_phase,
        {
          skillMdPath: deps.skillMdPathFor?.(fixerEntry.skill),
          minMtimeMs: fixerDispatchAt,
        },
      );
    } catch (err) {
      return {
        kind: 'exhausted',
        reason: `state apply fixer failed: ${(err as Error).message}`,
        exitCode: 40,
      };
    }

    const reviewerEntry = deps.resolveDispatch(reviewerPhase);
    if (!reviewerEntry.skill) {
      return { kind: 'exhausted', reason: `reviewer ${reviewerPhase} missing skill`, exitCode: 40 };
    }
    const reviewSession = await deps.adapter.createPhaseSession({
      title: `Phase ${reviewerPhase} re-review ${attempts}`,
    });
    const reviewerDispatchAt = Date.now();
    await deps.adapter.promptSync(reviewSession.id, {
      agent: reviewerEntry.agent,
      text: buildPhasePrompt(reviewerEntry.skill, reviewerPhase, deps.changeId),
    });

    try {
      (deps.applyPhase ?? applyPhaseState)(
        deps.projectRoot,
        deps.changeId,
        reviewerPhase,
        {
          skillMdPath: deps.skillMdPathFor?.(reviewerEntry.skill),
          minMtimeMs: reviewerDispatchAt,
        },
      );
    } catch (err) {
      return {
        kind: 'exhausted',
        reason: `state apply reviewer failed: ${(err as Error).message}`,
        exitCode: 40,
      };
    }

    const gateResult = deps.runner.runAws(
      ['gate', 'check', '--phase', reviewerPhase, '--change', deps.changeId, '--json'],
      deps.projectRoot,
    );
    gate = parseJsonStdout<GateReport>(gateResult);
  }

  const finalRoute = routeGateVerdict(gate);
  if (finalRoute.action === 'continue') return { kind: 'pass' };
  if (finalRoute.action === 'needs_human_review') {
    return { kind: 'needs_human_review', reason: finalRoute.reason };
  }
  if (finalRoute.action === 'stopped') {
    return { kind: 'stopped', reason: finalRoute.reason, exitCode: 20 };
  }
  if (finalRoute.action === 'needs_fix') {
    return {
      kind: 'exhausted',
      reason: `still needs_fix after loop for ${reviewerPhase}`,
      exitCode: 40,
    };
  }
  return {
    kind: 'exhausted',
    reason: `unexpected post-fix route ${finalRoute.action}`,
    exitCode: 40,
  };
}

export function maxFixAttemptsForPhase(
  phase: string,
  params: Record<string, unknown>,
): number {
  if (phase.startsWith('case-')) {
    return typeof params.max_case_fix_attempts === 'number' ? params.max_case_fix_attempts : 3;
  }
  return typeof params.max_plan_fix_attempts === 'number' ? params.max_plan_fix_attempts : 3;
}
