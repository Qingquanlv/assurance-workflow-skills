import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { applyAuditsToReport, AuditIssue, runStatusAudits } from '../core/audit';
import {
  appendEventsStrict,
  buildGateVerdictEvent,
  DispatchSignedEvent,
  getEventsFile,
  PhaseOutcomeCommittedEvent,
  HealingAttemptAllocatedEvent,
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
import { pinHealingEntryBaseline } from '../core/healing_state';
import {
  HealingEpisodeSnapshot,
  projectHealingEpisode,
} from './healing_episode';
import { deriveNextAction, Action } from './next_action';
import {
  computeStateGuard,
  signDispatch,
  signHeal,
} from './action_envelope';

export interface ProgressionOptions extends EngineOptions {
  /** Package root containing skills/<skill>/SKILL.md for skill-load attestation. */
  packageRoot?: string;
}

export interface ProgressSnapshot {
  report: StatusReport;
  nextActions: PhaseDispatchEntry[];
  auditIssues: AuditIssue[];
  healingEpisode: HealingEpisodeSnapshot;
}

export interface PhaseOutcome {
  attemptId: string;
  stateGuard: string;
  kind: 'dispatch_phase' | 'heal';
  phase?: string;
  target?: 'api' | 'e2e';
  agentExit?: number;
  agentLog?: string;
}

export interface ProgressResult {
  snapshot: ProgressSnapshot;
  action: Action;
}

export interface PhaseApplicationResult {
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

export interface HealingOperation {
  kind: 'allocate_attempt';
  operationId: string;
}

export interface HealingProgressResult {
  snapshot: ProgressSnapshot;
  healingEpisode: HealingEpisodeSnapshot;
  replayed: boolean;
}

export interface WorkflowProgressionRuntime {
  inspect(): ProgressResult;
  advance(outcome: PhaseOutcome): ProgressResult;
  resume(): ProgressResult;
}

export function createWorkflowProgression(
  options: ProgressionOptions,
): WorkflowProgressionRuntime {
  const inspectedDispatches = new Map<string, Extract<Action, {
    kind: 'dispatch_phase' | 'heal';
  }>>();
  const project = (): ProgressResult => {
    const snapshot = inspectProgression(options);
    const events = readEvents(options.projectRoot, options.changeId);
    const raw = deriveNextAction(snapshot, {
      schema: options.schema,
      events,
      healingTarget: resolveHealingTarget(options.projectRoot, options.changeId),
    });
    const action = raw.kind === 'dispatch_phase'
      ? signDispatch(raw, { ...options, events })
      : raw.kind === 'heal'
        ? signHeal(raw, { ...options, events })
        : raw;
    if (action.kind === 'dispatch_phase' || action.kind === 'heal') {
      inspectedDispatches.set(action.attemptId, action);
    }
    return { snapshot, action };
  };

  return {
    inspect: project,
    advance: (outcome) => {
      commitOutcome(options, outcome, inspectedDispatches.get(outcome.attemptId));
      return project();
    },
    resume: () => {
      reconcileDispatchedAttempts(options);
      return project();
    },
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

  const events = readEvents(options.projectRoot, options.changeId);
  return {
    report,
    nextActions: resolveNextDispatch(report.next, options.schema),
    auditIssues: audit.issues,
    healingEpisode: projectHealingEpisode({
      schema: options.schema,
      derived: options.schema.loops.healing
        ? deriveHealingState(options.projectRoot, options.changeId)
        : undefined,
      events,
    }),
  };
}

export function applyHealingOperation(
  options: ProgressionOptions,
  operation: HealingOperation,
): HealingProgressResult {
  if (!operation.operationId.trim()) {
    throw new Error('Workflow Progression requires a non-empty Healing operationId');
  }
  if (!options.schema.loops.healing) {
    throw new Error("Workflow Progression: schema has no 'healing' loop");
  }

  const existing = readEvents(options.projectRoot, options.changeId).find(
    (event): event is HealingAttemptAllocatedEvent =>
      event.type === 'healing_attempt_allocated' &&
      event.operation_id === operation.operationId,
  );
  if (existing) {
    const snapshot = inspectProgression(options);
    return { snapshot, healingEpisode: snapshot.healingEpisode, replayed: true };
  }

  const baselineBefore = captureFile(path.join(
    options.projectRoot,
    'qa',
    'changes',
    options.changeId,
    'healing',
    'entry-baseline.json',
  ));
  const eventsBefore = captureFile(getEventsFile(options.projectRoot, options.changeId));
  try {
    const baseline = pinHealingEntryBaseline(options.projectRoot, options.changeId);
    if (!baseline.batch_id) {
      throw new Error('Workflow Progression requires an active batch for Healing');
    }
    const attempts = readEvents(options.projectRoot, options.changeId).filter(event =>
      event.type === 'healing_attempt_allocated' && event.episode_id === baseline.episode_id,
    );
    appendEventsStrict(options.projectRoot, options.changeId, [{
      source: 'progression',
      type: 'healing_attempt_allocated',
      episode_id: baseline.episode_id,
      attempt_id: randomUUID(),
      attempt_number: attempts.length + 1,
      operation_id: operation.operationId,
      source_batch_id: baseline.batch_id,
    }]);
  } catch (err) {
    restoreFile(eventsBefore);
    restoreFile(baselineBefore);
    throw err;
  }

  const snapshot = inspectProgression(options);
  return { snapshot, healingEpisode: snapshot.healingEpisode, replayed: false };
}

/**
 * Apply one dispatched Phase outcome through the Workflow Progression write
 * boundary, then return the resulting Gate decision and dispatch snapshot.
 * Kept as a standalone compatibility seam while the driver migrates.
 */
export interface LegacyPhaseOutcome {
  phase: string;
  attemptId: string;
  minMtimeMs?: number;
  skillMdPath?: string;
}

export function applyPhaseOutcome(
  options: ProgressionOptions,
  outcome: LegacyPhaseOutcome,
): PhaseApplicationResult {
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

/**
 * Commit a signed dispatch after its executor returns. The envelope is the
 * authority for phase and freshness; agent diagnostics cannot select either.
 */
function commitOutcome(
  options: ProgressionOptions,
  outcome: PhaseOutcome,
  expectedAction?: Extract<Action, { kind: 'dispatch_phase' | 'heal' }>,
): void {
  if (!outcome.attemptId.trim()) {
    throw new Error('Workflow Progression requires a non-empty attemptId');
  }

  const committed = findCommittedOutcome(options, outcome.attemptId);
  if (committed) return;

  const events = readEvents(options.projectRoot, options.changeId);
  let dispatch = events.find(
    (event): event is DispatchSignedEvent =>
      event.type === 'dispatch_signed' && event.attempt_id === outcome.attemptId,
  );
  const currentGuard = computeStateGuard(options.projectRoot, options.changeId);
  if (currentGuard !== outcome.stateGuard) {
    throw new Error(`H0 violation: workflow-state changed since dispatch '${outcome.attemptId}'`);
  }

  if (dispatch) {
    assertOutcomeMatchesDispatch(outcome, dispatch);
  } else {
    assertOutcomeMatchesExpectedAction(outcome, expectedAction);
    const phase = sealedPhase(outcome);
    appendEventsStrict(options.projectRoot, options.changeId, [{
      source: 'progression',
      type: 'dispatch_signed',
      phase,
      kind: outcome.kind,
      ...(outcome.target ? { target: outcome.target } : {}),
      attempt_id: outcome.attemptId,
      state_guard: outcome.stateGuard,
      dispatched_at: Date.now(),
    }]);
    dispatch = readEvents(options.projectRoot, options.changeId).find(
      (event): event is DispatchSignedEvent =>
        event.type === 'dispatch_signed' && event.attempt_id === outcome.attemptId,
    );
  }
  if (!dispatch) {
    throw new Error(`Workflow Progression could not persist dispatch '${outcome.attemptId}'`);
  }

  const phase = dispatch.phase;

  // Heal dispatches are reconciled as durable no-op outcomes for now. Their
  // dedicated state machine owns evidence application in the healing driver.
  if (outcome.kind === 'heal') {
    appendEventsStrict(options.projectRoot, options.changeId, [{
      source: 'progression',
      type: 'phase_outcome_committed',
      phase,
      attempt_id: outcome.attemptId,
      gate_report: null,
    }]);
    return;
  }

  if (!options.schema.phasesById.has(phase)) {
    throw new Error(`Workflow Progression: unknown phase '${phase}'`);
  }
  applyPhaseOutcome(options, {
    phase,
    attemptId: outcome.attemptId,
    minMtimeMs: dispatch.dispatched_at,
    skillMdPath: resolveSkillMdPath(options, phase),
  });
}

function reconcileDispatchedAttempts(options: ProgressionOptions): void {
  const events = readEvents(options.projectRoot, options.changeId);
  const committed = new Set(
    events
      .filter((event): event is PhaseOutcomeCommittedEvent => event.type === 'phase_outcome_committed')
      .map(event => event.attempt_id),
  );
  for (const dispatch of events) {
    if (dispatch.type !== 'dispatch_signed' || committed.has(dispatch.attempt_id)) continue;
    if (!expectedEvidencePresent(options, dispatch.phase)) continue;
    const target = dispatch.phase.startsWith('heal:')
      ? dispatch.phase.slice('heal:'.length) as 'api' | 'e2e'
      : undefined;
    commitOutcome(options, {
      attemptId: dispatch.attempt_id,
      stateGuard: dispatch.state_guard,
      kind: target ? 'heal' : 'dispatch_phase',
      phase: target ? undefined : dispatch.phase,
      target,
    });
  }
}

function sealedPhase(outcome: PhaseOutcome): string {
  if (outcome.kind === 'heal') {
    if (!outcome.target) throw new Error('Workflow Progression heal outcome requires a target');
    return `heal:${outcome.target}`;
  }
  if (!outcome.phase) throw new Error('Workflow Progression dispatch outcome requires a phase');
  return outcome.phase;
}

function assertOutcomeMatchesDispatch(outcome: PhaseOutcome, dispatch: DispatchSignedEvent): void {
  const dispatchKind = dispatch.kind ?? (
    dispatch.phase.startsWith('heal:') ? 'heal' : 'dispatch_phase'
  );
  if (
    dispatch.state_guard !== outcome.stateGuard ||
    dispatchKind !== outcome.kind ||
    dispatch.phase !== sealedPhase(outcome) ||
    (dispatch.target !== undefined && dispatch.target !== outcome.target)
  ) {
    throw new Error(
      `Workflow Progression envelope mismatch for dispatch '${outcome.attemptId}'`,
    );
  }
}

function assertOutcomeMatchesExpectedAction(
  outcome: PhaseOutcome,
  action: Extract<Action, { kind: 'dispatch_phase' | 'heal' }> | undefined,
): void {
  if (!action) {
    throw new Error(
      `Workflow Progression envelope mismatch for dispatch '${outcome.attemptId}'`,
    );
  }
  const expectedPhase = action.kind === 'heal' ? `heal:${action.target}` : action.phase;
  if (
    action.kind !== outcome.kind ||
    action.attemptId !== outcome.attemptId ||
    expectedPhase !== sealedPhase(outcome) ||
    (action.kind === 'heal' && action.target !== outcome.target)
  ) {
    throw new Error(
      `Workflow Progression envelope mismatch for dispatch '${outcome.attemptId}'`,
    );
  }
}

function resolveSkillMdPath(options: ProgressionOptions, phaseId: string): string | undefined {
  const skill = options.schema.phasesById.get(phaseId)?.skill;
  if (!skill || !options.packageRoot) return undefined;
  const candidate = path.join(options.packageRoot, 'skills', skill, 'SKILL.md');
  return fs.existsSync(candidate) ? candidate : undefined;
}

function expectedEvidencePresent(options: ProgressionOptions, phase: string): boolean {
  const expected = phase.startsWith('heal:')
    ? [`healing/${phase.slice('heal:'.length)}-apply-summary.json`, 'healing/fix-proposal.json']
    : options.schema.phasesById.get(phase)?.produces ?? [];
  return expected.every(pattern => changeEvidenceMatches(
    path.join(options.projectRoot, 'qa', 'changes', options.changeId),
    pattern,
  ));
}

function changeEvidenceMatches(changeDir: string, pattern: string): boolean {
  if (!/[*?[\]{}]/.test(pattern)) {
    return fs.existsSync(path.join(changeDir, pattern));
  }
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(absolute) : [path.relative(changeDir, absolute)];
  });
  const matcher = require('minimatch').minimatch as (value: string, pattern: string) => boolean;
  return walk(changeDir).some(file => matcher(file, pattern));
}

/** Disk-only adapter; deriveNextAction remains deterministic over its inputs. */
export function resolveHealingTarget(projectRoot: string, changeId: string): 'api' | 'e2e' {
  const file = path.join(projectRoot, 'qa', 'changes', changeId, 'healing', 'fix-proposal.json');
  if (!fs.existsSync(file)) return 'api';
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
    const targets = [
      parsed.eligible_targets,
      parsed.eligibleTargets,
      parsed.targets,
    ].find(Array.isArray) as unknown[] | undefined;
    const target = targets?.find(value => value === 'api' || value === 'e2e');
    return target === 'e2e' ? 'e2e' : 'api';
  } catch {
    return 'api';
  }
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
