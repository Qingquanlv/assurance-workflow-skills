import type { QaEvent, GateVerdictEvent } from '../core/events';
import type { Schema } from './schema';
import type { ProgressSnapshot } from './progression';

export type Action =
  | { kind: 'dispatch_phase'; phase: string; goal: string; expectedEvidence: string[]; attemptId: string; stateGuard: string }
  | { kind: 'heal'; target: 'api' | 'e2e'; attemptId: string; attemptNumber: number; maxAttempts: number; expectedEvidence: string[]; stateGuard: string }
  | { kind: 'pause_for_human'; checkpoint: string; reason: string }
  | { kind: 'terminal'; status: 'completed' | 'stopped' | 'exhausted'; exitCode: 0 | 20 | 40; reason: string };

/** Unsigned dispatch (Task 1). Task 2's signDispatch() adds attemptId + stateGuard. */
export type UnsignedDispatch = Omit<Extract<Action, { kind: 'dispatch_phase' }>, 'attemptId' | 'stateGuard'>;

export interface RepairRoute {
  phase: string;
  maxAttempts: number;
  attemptsUsed: number;
}

export interface LatestCommittedGate {
  phase: string;
  verdict: string;
  gate: string;
}

/** Gate verdict paired with the newest phase_outcome_committed in the ledger. */
export function latestCommittedGate(events: QaEvent[]): LatestCommittedGate | null {
  let commitIndex = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'phase_outcome_committed') {
      commitIndex = i;
      break;
    }
  }
  if (commitIndex <= 0) {
    return null;
  }

  const prev = events[commitIndex - 1];
  if (prev.type !== 'gate_verdict') {
    return null;
  }
  const gv = prev as GateVerdictEvent;
  if (!gv.phase) {
    return null;
  }
  return { phase: gv.phase, verdict: gv.verdict, gate: gv.gate };
}

export function repairEvidence(schema: Schema, phase: string): string[] {
  return schema.phasesById.get(phase)?.produces ?? [];
}

export function resolveRepairRoute(
  schema: Schema,
  reviewerPhase: string,
  params: Record<string, unknown>,
  events: QaEvent[],
): RepairRoute {
  const repairs = schema.phases.filter(phase => phase.repair_of === reviewerPhase);
  if (repairs.length !== 1) {
    throw new Error(
      `Workflow Progression requires exactly one repair phase for '${reviewerPhase}', ` +
      `found ${repairs.length}`,
    );
  }

  const repair = repairs[0];
  if (!repair.max_attempts_param) {
    throw new Error(
      `Workflow Progression repair phase '${repair.id}' has no max_attempts_param`,
    );
  }
  const configured = params[repair.max_attempts_param];
  if (typeof configured !== 'number' || !Number.isInteger(configured) || configured < 0) {
    throw new Error(
      `Workflow Progression parameter '${repair.max_attempts_param}' must be a non-negative integer`,
    );
  }

  let episodeStart = -1;
  events.forEach((event, index) => {
    if (
      event.type === 'gate_verdict' &&
      event.phase === reviewerPhase &&
      event.verdict !== 'needs_fix'
    ) {
      episodeStart = index;
    }
  });
  const attemptsUsed = events.slice(episodeStart + 1).filter(event =>
    event.type === 'dispatch_signed' && event.phase === repair.id,
  ).length;
  return { phase: repair.id, maxAttempts: configured, attemptsUsed };
}

export function healingEvidence(target: 'api' | 'e2e'): string[] {
  return [`healing/${target}-apply-summary.json`, 'healing/fix-proposal.json'];
}

export function deriveNextAction(
  snapshot: ProgressSnapshot,
  ctx: { schema: Schema; events: QaEvent[]; healingTarget?: 'api' | 'e2e' },
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

  const healing = snapshot.healingEpisode;
  if (healing.state === 'awaiting_human') {
    const awaitHuman = healing.nextActions.find(
      (action): action is Extract<typeof action, { kind: 'await_human' }> =>
        action.kind === 'await_human',
    );
    if (awaitHuman) {
      return {
        kind: 'pause_for_human',
        checkpoint: awaitHuman.checkpoint,
        reason: awaitHuman.reason,
      };
    }
  }
  if (healing.state === 'active') {
    const maxAttempts = Number(
      report.params[ctx.schema.loops.healing?.max_param ?? ''] ?? 0,
    );
    const completingApplied =
      healing.stage === 'rerun_required' || healing.stage === 'reinspect_required';
    if (!completingApplied && healing.attemptNumber >= maxAttempts) {
      return {
        kind: 'terminal',
        status: 'exhausted',
        exitCode: 40,
        reason: `max_healing_attempts=${maxAttempts}`,
      };
    }
    const target = ctx.healingTarget ?? 'api';
    return {
      kind: 'heal',
      target,
      attemptNumber: healing.attemptNumber + 1,
      maxAttempts,
      expectedEvidence: healingEvidence(target),
      attemptId: '',
      stateGuard: '',
    };
  }

  const gate = latestCommittedGate(ctx.events);
  if (gate) {
    switch (gate.verdict) {
      case 'needs_human_review':
        return {
          kind: 'pause_for_human',
          checkpoint: gate.phase,
          reason: `gate ${gate.gate} requires human review`,
        };
      case 'stop':
      case 'reject':
        return {
          kind: 'terminal',
          status: 'stopped',
          exitCode: 20,
          reason: `gate ${gate.gate} verdict=${gate.verdict}`,
        };
      case 'needs_fix': {
        const repair = resolveRepairRoute(ctx.schema, gate.phase, report.params, ctx.events);
        if (repair.attemptsUsed >= repair.maxAttempts) {
          return {
            kind: 'terminal',
            status: 'exhausted',
            exitCode: 40,
            reason: `repair budget for ${gate.phase} exhausted`,
          };
        }
        return {
          kind: 'dispatch_phase',
          phase: repair.phase,
          goal: `Repair ${gate.phase}`,
          expectedEvidence: repairEvidence(ctx.schema, repair.phase),
        };
      }
      // pass → fall through to base routing
    }
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
