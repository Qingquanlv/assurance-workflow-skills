import * as fs from 'fs';
import { applyAuditsToReport, AuditIssue, runStatusAudits } from '../core/audit';
import {
  appendEventsStrict,
  buildGateVerdictEvent,
  getEventsFile,
  PhaseOutcomeCommittedEvent,
  readEvents,
} from '../core/events';
import { applyPhaseState, getWorkflowStateFile } from '../core/workflow_state';
import {
  checkGate,
  computeStatus,
  Engine,
  EngineOptions,
  GateReport,
  PhaseDispatchEntry,
  resolveNextDispatch,
  StatusReport,
} from './engine';
import { decideGate, GateDecision } from './gate_routing';
import { deriveHealingState } from '../core/healing_state';
import {
  HealingEpisodeSnapshot,
  projectHealingEpisode,
} from './healing_episode';

export interface ProgressionOptions extends EngineOptions {}

export interface ProgressSnapshot {
  report: StatusReport;
  nextActions: PhaseDispatchEntry[];
  auditIssues: AuditIssue[];
  healingEpisode: HealingEpisodeSnapshot;
}

export interface PhaseOutcome {
  phase: string;
  attemptId: string;
  minMtimeMs?: number;
  skillMdPath?: string;
}

export interface ProgressResult {
  snapshot: ProgressSnapshot;
  gate: GateReport | null;
  decision: GateDecision | null;
  replayed: boolean;
}

export interface RepairRoute {
  phase: string;
  maxAttempts: number;
  attemptsUsed: number;
}

export interface WorkflowProgressionRuntime {
  inspect(): ProgressSnapshot;
  applyOutcome(outcome: PhaseOutcome): ProgressResult;
  resolveRepair(reviewerPhase: string): RepairRoute;
  inspectGate(gateId: string): GateReport;
  decideGate(gate: GateReport): GateDecision;
  resolveLoopBudget(loopId: string): number;
  adjudicatePhaseGate(phaseId: string): GateReport;
}

export function createWorkflowProgression(
  options: ProgressionOptions,
): WorkflowProgressionRuntime {
  return {
    inspect: () => inspectProgression(options),
    applyOutcome: (outcome) => applyPhaseOutcome(options, outcome),
    resolveRepair: (reviewerPhase) => resolveRepair(options, reviewerPhase),
    inspectGate: (gateId) => inspectNamedGate(options, gateId),
    decideGate,
    resolveLoopBudget: (loopId) => resolveLoopBudget(options, loopId),
    adjudicatePhaseGate: (phaseId) => adjudicatePhaseGate(options, phaseId),
  };
}

export function adjudicatePhaseGate(
  options: ProgressionOptions,
  phaseId: string,
): GateReport {
  return checkGate({ ...options, phaseId });
}

export function inspectNamedGate(
  options: ProgressionOptions,
  gateId: string,
): GateReport {
  if (!options.schema.gates[gateId]) {
    throw new Error(`Workflow Progression: unknown gate '${gateId}'`);
  }
  const resolution = new Engine(options).resolveGate(gateId);
  return {
    schema_version: options.schema.schema_version,
    change_id: options.changeId,
    phase: null,
    gate: gateId,
    verdict: resolution.verdict,
    reads: resolution.reads,
    evidence: resolution.evidence,
    matched_rule: resolution.matchedRule,
    recommended_phase: null,
  };
}

export function resolveLoopBudget(
  options: ProgressionOptions,
  loopId: string,
): number {
  const loop = options.schema.loops[loopId];
  if (!loop) {
    throw new Error(`Workflow Progression: unknown loop '${loopId}'`);
  }
  const configured = inspectProgression(options).report.params[loop.max_param];
  if (typeof configured !== 'number' || !Number.isInteger(configured) || configured < 0) {
    throw new Error(
      `Workflow Progression parameter '${loop.max_param}' must be a non-negative integer`,
    );
  }
  return configured;
}

export function resolveRepair(
  options: ProgressionOptions,
  reviewerPhase: string,
): RepairRoute {
  const repairs = options.schema.phases.filter(phase => phase.repair_of === reviewerPhase);
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
  const configured = inspectProgression(options).report.params[repair.max_attempts_param];
  if (typeof configured !== 'number' || !Number.isInteger(configured) || configured < 0) {
    throw new Error(
      `Workflow Progression parameter '${repair.max_attempts_param}' must be a non-negative integer`,
    );
  }
  const events = readEvents(options.projectRoot, options.changeId);
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
    event.type === 'phase_dispatched' && event.phase === repair.id,
  ).length;
  return { phase: repair.id, maxAttempts: configured, attemptsUsed };
}

/**
 * Inspect the durable workflow projection without changing it.
 *
 * This is the read side of the Workflow Progression Runtime. Callers receive
 * audited status and concrete dispatch actions from one schema-driven seam;
 * observing progress never creates workflow Events or rewrites state.
 */
export function inspectProgression(options: ProgressionOptions): ProgressSnapshot {
  const computed = computeStatus(options);
  const audit = runStatusAudits(
    options.projectRoot,
    options.changeId,
    computed,
    options.schema,
  );
  const report = applyAuditsToReport(computed, audit);

  return {
    report,
    nextActions: resolveNextDispatch(report.next, options.schema),
    auditIssues: audit.issues,
    healingEpisode: projectHealingEpisode({
      schema: options.schema,
      derived: options.schema.loops.healing
        ? deriveHealingState(options.projectRoot, options.changeId)
        : undefined,
    }),
  };
}

/**
 * Apply one dispatched Phase outcome through the Workflow Progression write
 * boundary, then return the resulting Gate decision and dispatch snapshot.
 */
export function applyPhaseOutcome(
  options: ProgressionOptions,
  outcome: PhaseOutcome,
): ProgressResult {
  if (!outcome.attemptId.trim()) {
    throw new Error('Workflow Progression requires a non-empty attemptId');
  }

  const phase = options.schema.phasesById.get(outcome.phase);
  if (!phase) {
    throw new Error(`Workflow Progression: unknown phase '${outcome.phase}'`);
  }

  const committed = findCommittedOutcome(options, outcome.attemptId);
  if (committed) {
    if (committed.phase !== outcome.phase) {
      throw new Error(
        `Workflow Progression attempt '${outcome.attemptId}' is already committed ` +
        `for phase '${committed.phase}'`,
      );
    }
    return {
      snapshot: inspectProgression(options),
      gate: committed.gate_report,
      decision: committed.gate_report ? decideGate(committed.gate_report) : null,
      replayed: true,
    };
  }

  const stateBefore = captureFile(
    getWorkflowStateFile(options.projectRoot, options.changeId),
  );
  const eventsBefore = captureFile(
    getEventsFile(options.projectRoot, options.changeId),
  );

  let gate: GateReport | null;
  try {
    applyPhaseState(options.projectRoot, options.changeId, outcome.phase, {
      minMtimeMs: outcome.minMtimeMs,
      skillMdPath: outcome.skillMdPath,
    });

    gate = phase.gate
      ? checkGate({ ...options, phaseId: outcome.phase })
      : null;
    appendEventsStrict(options.projectRoot, options.changeId, [
      ...(gate
        ? [buildGateVerdictEvent(
            options.projectRoot,
            options.changeId,
            gate,
            options.schema,
          )]
        : []),
      {
        source: 'progression',
        type: 'phase_outcome_committed',
        phase: outcome.phase,
        attempt_id: outcome.attemptId,
        gate_report: gate,
      },
    ]);
  } catch (err) {
    restoreFile(eventsBefore);
    restoreFile(stateBefore);
    throw err;
  }

  return {
    snapshot: inspectProgression(options),
    gate,
    decision: gate ? decideGate(gate) : null,
    replayed: false,
  };
}

interface FileSnapshot {
  path: string;
  existed: boolean;
  contents?: Buffer;
  mode?: number;
}

function captureFile(file: string): FileSnapshot {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return { path: file, existed: false };
  }
  const stat = fs.statSync(file);
  return {
    path: file,
    existed: true,
    contents: fs.readFileSync(file),
    mode: stat.mode,
  };
}

function restoreFile(snapshot: FileSnapshot): void {
  if (!snapshot.existed) {
    if (fs.existsSync(snapshot.path) && fs.statSync(snapshot.path).isFile()) {
      fs.unlinkSync(snapshot.path);
    }
    return;
  }

  if (fs.existsSync(snapshot.path) && fs.statSync(snapshot.path).isFile()) {
    fs.chmodSync(snapshot.path, 0o600);
  }
  fs.writeFileSync(snapshot.path, snapshot.contents ?? Buffer.alloc(0));
  if (snapshot.mode !== undefined) {
    fs.chmodSync(snapshot.path, snapshot.mode);
  }
}

function findCommittedOutcome(
  options: ProgressionOptions,
  attemptId: string,
): PhaseOutcomeCommittedEvent | undefined {
  return readEvents(options.projectRoot, options.changeId).find(
    (event): event is PhaseOutcomeCommittedEvent =>
      event.type === 'phase_outcome_committed' && event.attempt_id === attemptId,
  );
}
