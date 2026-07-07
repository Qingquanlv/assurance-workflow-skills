import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { appendEvents, approxDurationSince, PhaseTransitionStatus, readEvents } from './events';

export interface PhaseCompletionOptions {
  /** Schema phase id used in events.jsonl. */
  phase: string;
  /** workflow-state phases key; defaults to phase. */
  phaseKey?: string;
  /** Fields to merge into phases.<phaseKey>. */
  state: Record<string, unknown>;
  /** Change-relative output paths to include in phase_transition when present. */
  outputs?: string[];
  /** Event transition target; defaults to done for ordinary orchestrator phase completion. */
  transitionTo?: PhaseTransitionStatus;
}

export type ApplyPhase = 'execution' | 'healing-rerun' | 'inspect' | 'healing-reinspect' | 'report';
export type OrchestratorSkill = 'aws-workflow' | 'aws-intake' | 'aws-execute';

interface RunContext {
  orchestrator_skill: OrchestratorSkill;
  interaction_mode: 'autonomous' | 'interactive';
  active_scope: 'full' | 'intake' | 'execute';
  stamped_at: string;
}

export function getWorkflowStateFile(projectRoot: string, changeId: string): string {
  return path.join(projectRoot, 'qa', 'changes', changeId, 'workflow-state.yaml');
}

export function applyPhaseState(projectRoot: string, changeId: string, phase: ApplyPhase): void {
  if (phase === 'execution' || phase === 'healing-rerun') {
    applyExecutionState(projectRoot, changeId, phase);
    return;
  }
  if (phase === 'inspect' || phase === 'healing-reinspect') {
    applyInspectState(projectRoot, changeId, phase);
    return;
  }
  applyReportState(projectRoot, changeId);
}

export function stampRunContext(
  projectRoot: string,
  changeId: string,
  orchestratorSkill: OrchestratorSkill,
  stampedAt = new Date().toISOString()
): void {
  const file = getWorkflowStateFile(projectRoot, changeId);
  const state = readWorkflowState(file);
  const root = isRecord(state) ? state : {};
  const params = isRecord(root.params) ? root.params as Record<string, unknown> : {};
  const runMode = typeof params.run_mode === 'string' ? params.run_mode : undefined;
  assertRunModeAllowed(orchestratorSkill, runMode);

  root.run_context = {
    ...runContextFor(orchestratorSkill),
    stamped_at: stampedAt,
  };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml.dump(root, { lineWidth: 120 }), 'utf-8');
}

export function recordPhaseCompletion(
  projectRoot: string,
  changeId: string,
  options: PhaseCompletionOptions
): void {
  const phaseKey = options.phaseKey ?? phaseIdToStateKey(options.phase);
  const transitionTo = options.transitionTo ?? 'done';

  updateWorkflowStatePhase(projectRoot, changeId, phaseKey, options.state);

  const { from, readyAt } = latestPhaseTransition(projectRoot, changeId, options.phase);
  if (from !== transitionTo) {
    const duration = approxDurationSince(readyAt);
    appendEvents(projectRoot, changeId, [{
      source: 'status',
      type: 'phase_transition',
      phase: options.phase,
      from,
      to: transitionTo,
      outputs: existingOutputs(projectRoot, changeId, options.outputs ?? []),
      ...(duration !== null ? { duration_ms: duration } : {}),
    }]);
  }

  syncPhaseTimingFromEvents(projectRoot, changeId, options.phase, phaseKey);
}

function runContextFor(orchestratorSkill: OrchestratorSkill): Omit<RunContext, 'stamped_at'> {
  if (orchestratorSkill === 'aws-intake') {
    return {
      orchestrator_skill: orchestratorSkill,
      interaction_mode: 'interactive',
      active_scope: 'intake',
    };
  }
  if (orchestratorSkill === 'aws-execute') {
    return {
      orchestrator_skill: orchestratorSkill,
      interaction_mode: 'autonomous',
      active_scope: 'execute',
    };
  }
  return {
    orchestrator_skill: orchestratorSkill,
    interaction_mode: 'autonomous',
    active_scope: 'full',
  };
}

function assertRunModeAllowed(orchestratorSkill: OrchestratorSkill, runMode: string | undefined): void {
  if (!runMode) return;
  const allowed: Record<OrchestratorSkill, Set<string>> = {
    'aws-workflow': new Set(['full', 'case-only', 'api-only', 'e2e-only', 'plan-only', 'codegen-only', 'review-case', 'review-plan']),
    'aws-intake': new Set(['full', 'case-only', 'review-case']),
    'aws-execute': new Set(['full', 'api-only', 'e2e-only', 'plan-only', 'codegen-only', 'review-plan']),
  };
  if (!allowed[orchestratorSkill].has(runMode)) {
    throw new Error(`${orchestratorSkill} cannot run with run_mode ${runMode}`);
  }
}

/** Mirror human-readable timing from events.jsonl into one workflow-state phase. */
export function syncPhaseTimingFromEvents(
  projectRoot: string,
  changeId: string,
  phase: string,
  phaseKey = phaseIdToStateKey(phase)
): void {
  const file = getWorkflowStateFile(projectRoot, changeId);
  if (!fs.existsSync(file)) return;

  const events = readEvents(projectRoot, changeId);
  const state = readWorkflowState(file);
  if (!isRecord(state)) return;

  const phases = isRecord(state.phases) ? { ...state.phases } : {};
  let changed = false;

  if (phase === 'execution' || phase === 'healing-rerun') {
    const timing = latestExecutionTimingFromEvents(events);
    if (timing !== null) {
      const existing = isRecord(phases[phaseKey]) ? phases[phaseKey] as Record<string, unknown> : {};
      const next: Record<string, unknown> = { ...existing };
      if (timing.started_at !== undefined) next.started_at = timing.started_at;
      next.duration_ms = timing.duration_ms;
      if (JSON.stringify(next) !== JSON.stringify(existing)) {
        phases[phaseKey] = next;
        changed = true;
      }
    }
  }

  if (!changed) return;

  state.phases = phases;
  fs.writeFileSync(file, yaml.dump(state, { lineWidth: 120 }), 'utf-8');
}

export function updateWorkflowStatePhase(
  projectRoot: string,
  changeId: string,
  phaseKey: string,
  patch: Record<string, unknown>
): void {
  const file = getWorkflowStateFile(projectRoot, changeId);
  const state = readWorkflowState(file);
  const root = isRecord(state) ? state : {};
  const phases = isRecord(root.phases) ? root.phases : {};
  const existing = isRecord(phases[phaseKey]) ? phases[phaseKey] as Record<string, unknown> : {};

  phases[phaseKey] = mergeRecord(existing, patch);
  root.phases = phases;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml.dump(root, { lineWidth: 120 }), 'utf-8');
}

function applyExecutionState(projectRoot: string, changeId: string, phase: 'execution' | 'healing-rerun'): void {
  const manifest = readYamlRecord(changeFile(projectRoot, changeId, 'execution/execution-manifest.yaml'));
  const gate = readJsonRecord(changeFile(projectRoot, changeId, 'execution/quality-gate-result.json'));
  const status = asString(gate?.final_status) ?? asString(manifest?.final_status);
  const batchId = asString(manifest?.batch_id) ?? asString(gate?.batch_id);

  if (!status) throw new Error('execution final_status not found; run aws run before state apply');
  if (!batchId) throw new Error('execution batch_id not found; run aws run before state apply');

  const patch: Record<string, unknown> = {
    status,
    batch_id: batchId,
    manifest: 'execution/execution-manifest.yaml',
  };
  const timing = latestExecutionTimingFromEvents(readEvents(projectRoot, changeId));
  if (timing !== null) {
    if (timing.started_at !== undefined) patch.started_at = timing.started_at;
    patch.duration_ms = timing.duration_ms;
  }

  recordPhaseCompletion(projectRoot, changeId, {
    phase,
    phaseKey: 'execution',
    state: patch,
    transitionTo: status,
    outputs: [
      'execution/execution-manifest.yaml',
      'execution/summary.md',
      'execution/quality-gate-result.json',
      'execution/api-result.json',
      'execution/e2e-result.json',
      'execution/coverage-result.json',
      'execution/fuzz-result.json',
      'execution/performance-result.json',
    ],
  });

  // Scaffold phases.healing so downstream predicates (healing-entry-gate's
  // `len(state.phases.healing.attempts)`, report's `ready_when` on
  // healing.status) evaluate against concrete values instead of undefined.
  // Without this the entry gate falls to its fail-closed default and the
  // router skips the healing loop entirely, dispatching report while
  // healing.status was never recorded (HEAL-STATE-INCONSISTENT).
  ensureHealingStateInitialized(projectRoot, changeId);

  if (phase === 'healing-rerun') {
    // Also record the healing_rerun phase key: `aws state heal --to resolved`
    // reads phases.healing_rerun.status, which mirroring into `execution`
    // alone would leave unset.
    updateWorkflowStatePhase(projectRoot, changeId, 'healing_rerun', {
      status,
      batch_id: batchId,
    });
  }
}

/** Initialize phases.healing to its pending baseline when absent (idempotent). */
function ensureHealingStateInitialized(projectRoot: string, changeId: string): void {
  const file = getWorkflowStateFile(projectRoot, changeId);
  const state = readWorkflowState(file);
  if (!isRecord(state)) return;
  const phases = isRecord(state.phases) ? state.phases as Record<string, unknown> : {};
  const existing = isRecord(phases.healing) ? phases.healing as Record<string, unknown> : {};
  if (typeof existing.status === 'string' && Array.isArray(existing.attempts)) return;

  phases.healing = { status: 'pending', attempts: [], ...existing };
  state.phases = phases;
  fs.writeFileSync(file, yaml.dump(state, { lineWidth: 120 }), 'utf-8');
}

function applyInspectState(projectRoot: string, changeId: string, phase: 'inspect' | 'healing-reinspect'): void {
  const analysis = readJsonRecord(changeFile(projectRoot, changeId, 'inspect/failure-analysis.json'));
  if (!analysis) throw new Error('inspect/failure-analysis.json not found; run aws report inspect before state apply');

  if (phase === 'healing-reinspect') {
    // A healing re-inspect must be based on the healing-rerun batch, not a
    // stale analysis of an earlier one.
    const manifest = readYamlRecord(changeFile(projectRoot, changeId, 'execution/execution-manifest.yaml'));
    const latestBatch = asString(manifest?.batch_id);
    const sourceBatch = asString(analysis.source_batch_id);
    if (latestBatch && sourceBatch && latestBatch !== sourceBatch) {
      throw new Error(
        `healing-reinspect requires failure-analysis.source_batch_id == latest execution batch ` +
        `(${latestBatch}), got ${sourceBatch}; re-run aws report inspect`,
      );
    }
  }

  const status = inspectPhaseStatus(analysis);
  recordPhaseCompletion(projectRoot, changeId, {
    phase,
    state: {
      status,
      inspect_mode: asString(analysis.inspect_mode) ?? 'primary',
      classification_performed: Boolean(analysis.classification_performed),
      outputs: existingOutputs(projectRoot, changeId, [
        'inspect/failure-analysis.json',
        'inspect/failure-summary.md',
        'inspect/quality-gate-result.json',
        'inspect/inspection-partial.json',
        'inspect/inspection-error.json',
      ]),
    },
    transitionTo: status,
    outputs: [
      'inspect/failure-analysis.json',
      'inspect/failure-summary.md',
      'inspect/quality-gate-result.json',
      'inspect/inspection-partial.json',
      'inspect/inspection-error.json',
    ],
  });

  if (phase === 'healing-reinspect') {
    // The re-inspect also refreshes the canonical inspect phase state and
    // records which batch it analyzed.
    updateWorkflowStatePhase(projectRoot, changeId, 'healing_reinspect', {
      batch_id: asString(analysis.source_batch_id),
    });
    updateWorkflowStatePhase(projectRoot, changeId, 'inspect', {
      status,
      inspect_mode: asString(analysis.inspect_mode) ?? 'primary',
      classification_performed: Boolean(analysis.classification_performed),
    });
  }
}

function applyReportState(projectRoot: string, changeId: string): void {
  const report = readJsonRecord(changeFile(projectRoot, changeId, 'report/quality-report.json'));
  if (!report) throw new Error('report/quality-report.json not found; run aws report generate before state apply');

  recordPhaseCompletion(projectRoot, changeId, {
    phase: 'report',
    state: {
      status: 'done',
      quality_score: typeof report.quality_score === 'number' ? report.quality_score : null,
    },
    transitionTo: 'done',
    outputs: [
      'report/quality-report.json',
      'report/quality-report.md',
      'report/executive-summary.md',
    ],
  });
}

function inspectPhaseStatus(analysis: Record<string, unknown>): 'done' | 'partial' | 'failed' {
  if (analysis.inspection_status === 'failed') return 'failed';
  if (analysis.inspect_mode === 'compat_fallback') return 'partial';
  return 'done';
}

function latestPhaseTransition(
  projectRoot: string,
  changeId: string,
  phase: string
): { from: PhaseTransitionStatus | null; readyAt: string | null } {
  let from: PhaseTransitionStatus | null = null;
  let readyAt: string | null = null;
  for (const event of readEvents(projectRoot, changeId)) {
    if (event.type !== 'phase_transition' || event.phase !== phase) continue;
    from = event.to;
    if (event.to === 'ready') readyAt = event.ts;
  }
  return { from, readyAt };
}

function latestExecutionTimingFromEvents(events: ReturnType<typeof readEvents>): {
  started_at?: string;
  duration_ms: number;
} | null {
  let start: string | undefined;
  let end: { duration_ms: number } | null = null;
  for (const event of events) {
    if (event.type === 'execution_start') start = event.ts;
    if (event.type === 'execution_end') end = { duration_ms: event.duration_ms };
  }
  if (end === null) return null;
  return { started_at: start, duration_ms: end.duration_ms };
}

function readWorkflowState(file: string): unknown {
  if (!fs.existsSync(file)) return {};
  const parsed = yaml.load(fs.readFileSync(file, 'utf-8'));
  return parsed ?? {};
}

function mergeRecord(
  current: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (isRecord(value) && isRecord(next[key])) {
      next[key] = mergeRecord(next[key] as Record<string, unknown>, value);
    } else {
      next[key] = value;
    }
  }
  return next;
}

function readJsonRecord(file: string): Record<string, unknown> | null {
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readYamlRecord(file: string): Record<string, unknown> | null {
  if (!fs.existsSync(file)) return null;
  const parsed = yaml.load(fs.readFileSync(file, 'utf-8'));
  return isRecord(parsed) ? parsed : null;
}

function existingOutputs(projectRoot: string, changeId: string, outputs: string[]): string[] {
  return outputs.filter(output => fs.existsSync(resolveChangePath(projectRoot, changeId, output)));
}

function changeFile(projectRoot: string, changeId: string, p: string): string {
  return path.join(projectRoot, 'qa', 'changes', changeId, p);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function phaseIdToStateKey(phaseId: string): string {
  return phaseId.replace(/-/g, '_');
}

function resolveChangePath(projectRoot: string, changeId: string, p: string): string {
  const resolved = p.replace(/<change-id>/g, changeId);
  if (resolved.startsWith('repo:')) return path.join(projectRoot, resolved.slice('repo:'.length));
  if (resolved.startsWith('qa/')) return path.join(projectRoot, resolved);
  return path.join(projectRoot, 'qa', 'changes', changeId, resolved);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
