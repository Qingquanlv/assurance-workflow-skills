import { createHash } from 'crypto';
import * as fs from 'fs';
import type { QaEvent } from '../core/events';
import { getWorkflowStateFile } from '../core/workflow_state';
import type { UnsignedDispatch, Action } from './next_action';

export function mintAttemptId(events: QaEvent[], phase: string): string {
  const n = events.filter(
    (e) => e.type === 'dispatch_signed' && e.phase === phase,
  ).length;
  return `${phase}#${n + 1}`;
}

export function computeStateGuard(projectRoot: string, changeId: string): string {
  const file = getWorkflowStateFile(projectRoot, changeId);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return '';
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function signDispatch(
  unsigned: UnsignedDispatch,
  ctx: { projectRoot: string; changeId: string; events: QaEvent[] },
): Extract<Action, { kind: 'dispatch_phase' }> {
  return {
    ...unsigned,
    attemptId: mintAttemptId(ctx.events, unsigned.phase),
    stateGuard: computeStateGuard(ctx.projectRoot, ctx.changeId),
  };
}
