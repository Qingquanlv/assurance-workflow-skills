import type { GateReport } from '../orchestration/engine';

export type GateRouteAction =
  | { action: 'continue' }
  | { action: 'needs_fix'; recommended_phase: string }
  | { action: 'needs_human_review'; reason: string }
  | { action: 'stopped'; reason: string; exitCode: 20 }
  | { action: 'healing_enter' }
  | { action: 'healing_skip' }
  | { action: 'healing_continue' }
  | { action: 'healing_exit' }
  | { action: 'fail'; reason: string; exitCode: 40 };

/**
 * Route on JSON verdict — never on process exit code.
 */
export function routeGateVerdict(
  gate: Pick<GateReport, 'verdict' | 'recommended_phase' | 'gate' | 'phase'>,
): GateRouteAction {
  const v = gate.verdict;
  switch (v) {
    case 'pass':
      return { action: 'continue' };
    case 'needs_fix': {
      if (!gate.recommended_phase) {
        return {
          action: 'fail',
          reason: `needs_fix without recommended_phase (gate=${gate.gate})`,
          exitCode: 40,
        };
      }
      return { action: 'needs_fix', recommended_phase: gate.recommended_phase };
    }
    case 'needs_human_review':
      return {
        action: 'needs_human_review',
        reason: `gate ${gate.gate} requires human review`,
      };
    case 'reject':
    case 'stop':
      return {
        action: 'stopped',
        reason: `gate ${gate.gate} verdict=${v}`,
        exitCode: 20,
      };
    case 'enter':
      if (gate.gate !== 'healing-entry-gate') {
        return { action: 'fail', reason: `enter only valid for healing-entry-gate`, exitCode: 40 };
      }
      return { action: 'healing_enter' };
    case 'skip':
      if (gate.gate !== 'healing-entry-gate') {
        return { action: 'fail', reason: `skip only valid for healing-entry-gate`, exitCode: 40 };
      }
      return { action: 'healing_skip' };
    case 'continue':
      if (gate.gate !== 'healing-loop-gate') {
        return { action: 'fail', reason: `continue only valid for healing-loop-gate`, exitCode: 40 };
      }
      return { action: 'healing_continue' };
    case 'exit':
      if (gate.gate !== 'healing-loop-gate') {
        return { action: 'fail', reason: `exit only valid for healing-loop-gate`, exitCode: 40 };
      }
      return { action: 'healing_exit' };
    default:
      return {
        action: 'fail',
        reason: `unknown gate verdict '${v}' (fail-closed)`,
        exitCode: 40,
      };
  }
}
