import type { PhaseAgentAdapter } from './adapter';
import { buildPhasePrompt } from './phase_prompt';
import { appendEvents, buildDriverEvent } from '../core/events';
import type { GateReport, PhaseDispatchEntry } from '../orchestration/engine';
import type { RepairRoute, WorkflowProgressionRuntime } from '../orchestration/progression';
import { createDispatchAttemptId } from './driver_state';

export interface ReviewFixLoopDeps {
  projectRoot: string;
  changeId: string;
  adapter: PhaseAgentAdapter;
  resolveDispatch: (phase: string) => PhaseDispatchEntry;
  skillMdPathFor?: (skill: string) => string | undefined;
  progression: Pick<WorkflowProgressionRuntime, 'applyOutcome' | 'resolveRepair' | 'decideGate'>;
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
  let repair: RepairRoute;
  try {
    repair = deps.progression.resolveRepair(reviewerPhase);
    attempts = repair.attemptsUsed;
  } catch (err) {
    return {
      kind: 'exhausted',
      reason: (err as Error).message,
      exitCode: 40,
    };
  }

  while (gate.verdict === 'needs_fix') {
    attempts++;
    if (attempts > repair.maxAttempts) {
      return {
        kind: 'exhausted',
        reason: `review fix attempts exhausted for ${reviewerPhase} (max=${repair.maxAttempts})`,
        exitCode: 40,
      };
    }

    const routed = deps.progression.decideGate(gate);
    if (routed.action !== 'needs_fix') {
      break;
    }

    const fixerEntry = deps.resolveDispatch(repair.phase);
    if (fixerEntry.kind !== 'agent' || !fixerEntry.skill) {
      return {
        kind: 'exhausted',
        reason: `fixer phase ${repair.phase} is not an agent phase`,
        exitCode: 40,
      };
    }

    const fixerAttemptId = createDispatchAttemptId(repair.phase);
    if (deps.runId) {
      appendEvents(deps.projectRoot, deps.changeId, [
        buildDriverEvent('phase_dispatched', deps.runId, {
          phase: repair.phase,
          attempt_id: fixerAttemptId,
        }),
      ]);
    }
    const fixerSession = await deps.adapter.createPhaseSession({
      title: `Phase ${repair.phase} attempt ${attempts}`,
    });
    await deps.adapter.promptSync(fixerSession.id, {
      agent: fixerEntry.agent,
      text: buildPhasePrompt(fixerEntry.skill, repair.phase, deps.changeId),
    });

    try {
      // Fixer skills rewrite plan/case artifacts / apply-summaries; they must NOT
      // rewrite the review JSON produce (see aws-*-fixer: "Never write review
      // JSON"). Enforce presence only here; freshness is checked on the
      // subsequent reviewer re-apply after the review file is regenerated.
      deps.progression.applyOutcome({
        phase: repair.phase,
        attemptId: fixerAttemptId,
        skillMdPath: deps.skillMdPathFor?.(fixerEntry.skill),
      });
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
      const reviewerAttemptId = createDispatchAttemptId(reviewerPhase);
      const reviewResult = deps.progression.applyOutcome({
        phase: reviewerPhase,
        attemptId: reviewerAttemptId,
        skillMdPath: deps.skillMdPathFor?.(reviewerEntry.skill),
        minMtimeMs: reviewerDispatchAt,
      });
      if (!reviewResult.gate) {
        throw new Error(`reviewer ${reviewerPhase} produced no Gate result`);
      }
      gate = reviewResult.gate;
    } catch (err) {
      return {
        kind: 'exhausted',
        reason: `state apply reviewer failed: ${(err as Error).message}`,
        exitCode: 40,
      };
    }

  }

  const finalRoute = deps.progression.decideGate(gate);
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
