import type { HumanDecisionAction } from './events';
import type { Schema } from '../orchestration/schema';

export type HumanDecisionConsumer =
  | 'terminal-status'
  | 'gate-decision'
  | 'healing-safety'
  | 'execution-test-changes'
  | 'bootstrap-decision';

export interface DecisionSupport {
  consumer: HumanDecisionConsumer;
  gateId?: string;
}

export const SPECIAL_DECISION_SUPPORT = {
  'healing.safety': {
    accept_risk: 'healing-safety',
    stop: 'terminal-status',
  },
  'execution.test-changes': {
    allow_test_changes: 'execution-test-changes',
    stop: 'terminal-status',
  },
  bootstrap: {
    skip_branch: 'bootstrap-decision',
    stop: 'terminal-status',
  },
} as const satisfies Record<
  string,
  Partial<Record<HumanDecisionAction, HumanDecisionConsumer>>
>;

type WorkflowDecisionAction = 'fix_and_proceed' | 'accept_risk' | 'stop';
type WorkflowCheckpointKind = 'gate' | 'gated_phase' | 'phase';

/** Bare phases only support `stop`. Gate actions require a gated checkpoint. */
export const WORKFLOW_DECISION_SUPPORT = {
  fix_and_proceed: {
    gate: 'gate-decision',
    gated_phase: 'gate-decision',
  },
  accept_risk: {
    gate: 'gate-decision',
    gated_phase: 'gate-decision',
  },
  stop: {
    gate: 'terminal-status',
    gated_phase: 'terminal-status',
    phase: 'terminal-status',
  },
} as const satisfies Record<
  WorkflowDecisionAction,
  Partial<Record<WorkflowCheckpointKind, HumanDecisionConsumer>>
>;

export function resolveDecisionSupport(
  schema: Schema,
  checkpoint: string,
  action: HumanDecisionAction,
): DecisionSupport {
  const special = SPECIAL_DECISION_SUPPORT[
    checkpoint as keyof typeof SPECIAL_DECISION_SUPPORT
  ] as Partial<Record<HumanDecisionAction, HumanDecisionConsumer>> | undefined;
  if (special) {
    const consumer = special[action];
    if (!consumer) throw unsupported(checkpoint, action);
    return { consumer };
  }

  const phase = schema.phasesById.get(checkpoint);
  const gate = schema.gates[checkpoint];
  if (!phase && !gate) throw new Error(`Unknown checkpoint '${checkpoint}'`);
  if (!isWorkflowDecisionAction(action)) throw unsupported(checkpoint, action);

  const kind: WorkflowCheckpointKind = gate
    ? 'gate'
    : phase?.gate
      ? 'gated_phase'
      : 'phase';
  const supportMap = WORKFLOW_DECISION_SUPPORT[action] as Partial<
    Record<WorkflowCheckpointKind, HumanDecisionConsumer>
  >;
  const consumer = supportMap[kind];
  if (!consumer) throw unsupported(checkpoint, action);
  return {
    consumer,
    ...(gate ? { gateId: checkpoint } : phase?.gate ? { gateId: phase.gate } : {}),
  };
}

function isWorkflowDecisionAction(action: HumanDecisionAction): action is WorkflowDecisionAction {
  return action === 'fix_and_proceed' || action === 'accept_risk' || action === 'stop';
}

function unsupported(checkpoint: string, action: HumanDecisionAction): Error {
  return new Error(
    `Unsupported decision: checkpoint '${checkpoint}' does not support action '${action}'`,
  );
}
