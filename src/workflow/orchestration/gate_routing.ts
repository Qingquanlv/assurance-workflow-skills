import type { GateReport } from './engine';

export type GateDecision =
  | { action: 'continue' }
  | { action: 'needs_fix'; recommended_phase: string }
  | { action: 'needs_human_review'; reason: string }
  | { action: 'stopped'; reason: string; exitCode: 20 }
  | { action: 'healing_enter' }
  | { action: 'healing_skip' }
  | { action: 'healing_continue' }
  | { action: 'healing_exit' }
  | { action: 'fail'; reason: string; exitCode: 40 };

/** Convert a schema Gate verdict into the single action the executor must take. */
export function decideGate(
  gate: Pick<GateReport, 'verdict' | 'recommended_phase' | 'gate' | 'phase'>,
): GateDecision {
  const verdict = gate.verdict;
  switch (verdict) {
    case 'pass':
      return { action: 'continue' };
    case 'needs_fix':
      return gate.recommended_phase
        ? { action: 'needs_fix', recommended_phase: gate.recommended_phase }
        : {
            action: 'fail',
            reason: `needs_fix without recommended_phase (gate=${gate.gate})`,
            exitCode: 40,
          };
    case 'needs_human_review':
      return { action: 'needs_human_review', reason: `gate ${gate.gate} requires human review` };
    case 'reject':
    case 'stop':
      return { action: 'stopped', reason: `gate ${gate.gate} verdict=${verdict}`, exitCode: 20 };
    case 'enter':
      return gate.gate === 'healing-entry-gate'
        ? { action: 'healing_enter' }
        : { action: 'fail', reason: 'enter only valid for healing-entry-gate', exitCode: 40 };
    case 'skip':
      return gate.gate === 'healing-entry-gate'
        ? { action: 'healing_skip' }
        : { action: 'fail', reason: 'skip only valid for healing-entry-gate', exitCode: 40 };
    case 'continue':
      return gate.gate === 'healing-loop-gate'
        ? { action: 'healing_continue' }
        : { action: 'fail', reason: 'continue only valid for healing-loop-gate', exitCode: 40 };
    case 'exit':
      return gate.gate === 'healing-loop-gate'
        ? { action: 'healing_exit' }
        : { action: 'fail', reason: 'exit only valid for healing-loop-gate', exitCode: 40 };
    default:
      return {
        action: 'fail',
        reason: `unknown gate verdict '${verdict}' (fail-closed)`,
        exitCode: 40,
      };
  }
}
