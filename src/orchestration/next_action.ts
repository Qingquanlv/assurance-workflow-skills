import type { Schema } from './schema';
import type { ProgressSnapshot } from './progression';

export type Action =
  | { kind: 'dispatch_phase'; phase: string; goal: string; expectedEvidence: string[]; attemptId: string; stateGuard: string }
  | { kind: 'heal'; target: 'api' | 'e2e'; attemptId: string; attemptNumber: number; maxAttempts: number; expectedEvidence: string[]; stateGuard: string }
  | { kind: 'pause_for_human'; checkpoint: string; reason: string }
  | { kind: 'terminal'; status: 'completed' | 'stopped' | 'exhausted'; exitCode: 0 | 20 | 40; reason: string };

/** Unsigned dispatch (Task 1). Task 2's signDispatch() adds attemptId + stateGuard. */
export type UnsignedDispatch = Omit<Extract<Action, { kind: 'dispatch_phase' }>, 'attemptId' | 'stateGuard'>;

export function deriveNextAction(
  snapshot: ProgressSnapshot,
  ctx: { schema: Schema },
): Action | UnsignedDispatch {
  const { report } = snapshot;

  if (report.terminal?.kind === 'completed') {
    return { kind: 'terminal', status: 'completed', exitCode: 0, reason: report.terminal.reason };
  }
  if (report.terminal?.kind === 'stopped') {
    return { kind: 'terminal', status: 'stopped', exitCode: 20, reason: report.terminal.reason };
  }
  if (report.pending_decision) {
    return {
      kind: 'pause_for_human',
      checkpoint: report.pending_decision.phase,
      reason: report.pending_decision.reason,
    };
  }

  const next = snapshot.nextActions[0];
  if (next) {
    const def = ctx.schema.phasesById.get(next.phase);
    return {
      kind: 'dispatch_phase',
      phase: next.phase,
      goal: def?.skill ? `Run ${def.skill}` : `Run phase ${next.phase}`,
      expectedEvidence: def?.produces ?? [],
    };
  }

  // No pending phase, no terminal → exhausted (fail-closed).
  return { kind: 'terminal', status: 'exhausted', exitCode: 40, reason: 'no dispatchable phase and no terminal state' };
}
