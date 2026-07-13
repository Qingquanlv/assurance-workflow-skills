import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { appendEvents, approxDurationSince, PhaseTransitionStatus, readEvents } from './events';
import { findSchemaFile, loadSchemaFromFile } from '../orchestration/schema';

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

/** Legacy CLI-backed apply phases (kept for typed call sites). */
export type ApplyPhase = 'execution' | 'healing-rerun' | 'inspect' | 'healing-reinspect' | 'report';
export type OrchestratorSkill = 'aws-workflow' | 'aws-intake' | 'aws-execute';

export interface ApplyPhaseOptions {
  /**
   * Absolute (or project-root-relative) path to the SKILL.md the phase executor
   * read. Only meaningful for agent-backed phases. When provided, the Skill Load
   * Gate fields are written atomically with the phase status. Ignored for pure
   * CLI phases (execution / healing-rerun), which are always `skill_loaded: n/a`.
   */
  skillMdPath?: string;
  /**
   * Optional freshness floor: every produced artifact must have mtimeMs >= this
   * value (dispatch-time watermark). Prevents stale artifacts from marking a
   * failed retry as successful.
   */
  minMtimeMs?: number;
}

/** Phases that have no dedicated executor SKILL.md — the CLI does the work. */
const CLI_ONLY_APPLY_PHASES = new Set<string>(['execution', 'healing-rerun']);

/** Params keys the configure command may write (schema-aligned allowlist). */
const CONFIGURE_PARAM_KEYS = new Set([
  'run_mode',
  'test_types',
  'run_tests',
  'max_case_fix_attempts',
  'max_plan_fix_attempts',
  'max_healing_attempts',
  'auto_archive',
  'force_continue',
  'e2e_framework',
]);

interface RunContext {
  orchestrator_skill: OrchestratorSkill;
  interaction_mode: 'autonomous' | 'interactive';
  active_scope: 'full' | 'intake' | 'execute';
  stamped_at: string;
}

export function getWorkflowStateFile(projectRoot: string, changeId: string): string {
  return path.join(projectRoot, 'qa', 'changes', changeId, 'workflow-state.yaml');
}

export function applyPhaseState(
  projectRoot: string,
  changeId: string,
  phase: string,
  opts: ApplyPhaseOptions = {}
): void {
  if (CLI_ONLY_APPLY_PHASES.has(phase) && opts.skillMdPath) {
    throw new Error(
      `skillMdPath is not applicable to CLI-only phase "${phase}"; ` +
      `it is recorded as skill_loaded: n/a`,
    );
  }
  if (phase === 'execution' || phase === 'healing-rerun') {
    applyExecutionState(projectRoot, changeId, phase);
    return;
  }
  const skillFields = skillLoadFields(projectRoot, opts.skillMdPath);
  if (phase === 'inspect' || phase === 'healing-reinspect') {
    applyInspectState(projectRoot, changeId, phase, skillFields);
    return;
  }
  if (phase === 'report') {
    applyReportState(projectRoot, changeId, skillFields);
    return;
  }
  if (phase === 'skill-registry-check') {
    applySkillRegistryCheckState(projectRoot, changeId);
    return;
  }

  // Schema-driven registry for agent / repair phases.
  const schemaPath = findSchemaFile(projectRoot);
  const schema = loadSchemaFromFile(schemaPath);
  const def = schema.phasesById.get(phase);
  if (!def) {
    throw new Error(`Unsupported phase "${phase}" for state apply (not in workflow schema)`);
  }

  if (def.repair_of) {
    applyReviewFixerState(projectRoot, changeId, phase, def.repair_of, def.produces, opts);
    return;
  }

  const reviewJson = def.produces.find(p => /review\/.+\.json$/.test(p) || p.endsWith('-review.json'));
  if (def.gate && reviewJson && def.skill) {
    applyReviewPhaseState(projectRoot, changeId, phase, reviewJson, def.produces, skillFields, opts);
    return;
  }

  if (def.skill) {
    applyOrdinaryAgentPhaseState(projectRoot, changeId, phase, def.produces, skillFields, opts);
    return;
  }

  throw new Error(`Unsupported phase "${phase}" for state apply (no registered reducer)`);
}

/**
 * Merge runtime params into workflow-state.yaml, preserve existing phase state,
 * then stamp run_context for the logical orchestrator.
 */
export function configureWorkflowParams(
  projectRoot: string,
  changeId: string,
  paramsJson: Record<string, unknown>,
  orchestratorSkill: OrchestratorSkill,
  stampedAt = new Date().toISOString(),
): void {
  const file = getWorkflowStateFile(projectRoot, changeId);
  const state = readWorkflowState(file);
  const root = isRecord(state) ? state : {};
  const existingParams = isRecord(root.params) ? { ...root.params } as Record<string, unknown> : {};

  for (const [key, value] of Object.entries(paramsJson)) {
    if (!CONFIGURE_PARAM_KEYS.has(key)) {
      throw new Error(`configure: unknown param "${key}" (not in allowlist)`);
    }
    existingParams[key] = value;
  }
  root.params = existingParams;
  // Preserve phases / other top-level keys as-is.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml.dump(root, { lineWidth: 120 }), 'utf-8');
  stampRunContext(projectRoot, changeId, orchestratorSkill, stampedAt);
}

/**
 * Resolve the Skill Load Gate fields for an agent-backed phase. Returns null
 * when no skill path was supplied (the phase's existing skill_loaded value is
 * left untouched). Throws when the supplied path does not exist on disk, so a
 * bogus path cannot cosmetically satisfy the gate.
 */
export function skillLoadFields(
  projectRoot: string,
  skillMdPath: string | undefined,
  now: string = new Date().toISOString()
): Record<string, unknown> | null {
  if (!skillMdPath) return null;
  const abs = path.isAbsolute(skillMdPath) ? skillMdPath : path.join(projectRoot, skillMdPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`skillMdPath not found on disk: ${abs}`);
  }
  return {
    skill_loaded: true,
    skill_md_path: abs,
    skill_loaded_at: now,
  };
}

/**
 * Merge a single `gates.<key>` flag into workflow-state.yaml.
 *
 * `gates.healing_available` is normally derived by the orchestrator during the
 * skill-registry phase (see FALLBACK-RUNBOOK Phase 1.1). The TS driver replaces
 * that orchestrator, so it must stamp the same flag or the healing-entry-gate
 * (`enter_when` requires `state.gates.healing_available == true`) can never fire.
 */
export function setWorkflowGate(
  projectRoot: string,
  changeId: string,
  key: string,
  value: unknown,
): void {
  const file = getWorkflowStateFile(projectRoot, changeId);
  const state = readWorkflowState(file);
  const root = isRecord(state) ? state : {};
  const gates = isRecord(root.gates) ? (root.gates as Record<string, unknown>) : {};
  gates[key] = value;
  root.gates = gates;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml.dump(root, { lineWidth: 120 }), 'utf-8');
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

function assertProducesPresentAndFresh(
  projectRoot: string,
  changeId: string,
  produces: string[],
  minMtimeMs?: number,
): string[] {
  const present: string[] = [];
  // Freshness watermark detects a no-op dispatch (agent produced nothing new).
  // It requires that the phase produced *some* fresh artifact this dispatch, not
  // that every produce is rewritten: phases legitimately leave pre-existing
  // config/input produces (e.g. .qa.yaml, proposal.md seeded before the run)
  // untouched while regenerating their real outputs (e.g. cases/). Enforcing
  // per-file freshness makes such phases fail non-deterministically on whether
  // the agent happened to rewrite an unchanged file.
  let freshCount = 0;
  for (const rel of produces) {
    // Directories (trailing /) — require existence as directory.
    if (rel.endsWith('/')) {
      const abs = resolveChangePath(projectRoot, changeId, rel);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
        throw new Error(`state apply: required produce missing or not a directory: ${rel}`);
      }
      if (minMtimeMs !== undefined && fs.statSync(abs).mtimeMs >= minMtimeMs) {
        freshCount++;
      }
      present.push(rel);
      continue;
    }
    const abs = resolveChangePath(projectRoot, changeId, rel);
    if (!fs.existsSync(abs)) {
      throw new Error(`state apply: required produce missing: ${rel}`);
    }
    if (minMtimeMs !== undefined && fs.statSync(abs).mtimeMs >= minMtimeMs) {
      freshCount++;
    }
    present.push(rel);
  }
  if (minMtimeMs !== undefined && produces.length > 0 && freshCount === 0) {
    throw new Error(
      `state apply: stale produces (no produce written since dispatch): ${produces.join(', ')}`,
    );
  }
  return present;
}

function applySkillRegistryCheckState(projectRoot: string, changeId: string): void {
  recordPhaseCompletion(projectRoot, changeId, {
    phase: 'skill-registry-check',
    phaseKey: 'skill_registry_check',
    state: { status: 'pass' },
    transitionTo: 'done',
    outputs: ['workflow-state.yaml'],
  });
}

function applyOrdinaryAgentPhaseState(
  projectRoot: string,
  changeId: string,
  phase: string,
  produces: string[],
  skillFields: Record<string, unknown> | null,
  opts: ApplyPhaseOptions,
): void {
  const outputs = assertProducesPresentAndFresh(projectRoot, changeId, produces, opts.minMtimeMs);
  recordPhaseCompletion(projectRoot, changeId, {
    phase,
    state: {
      status: 'done',
      ...(skillFields ?? {}),
      outputs,
    },
    transitionTo: 'done',
    outputs,
  });
}

function reviewDecisionStatus(decision: string | null): string {
  if (decision === 'pass' || decision === 'approved') return 'pass';
  if (decision === 'needs_fix') return 'needs_fix';
  if (decision === 'needs_human_review' || decision === 'changes_requested') return 'needs_human_review';
  if (decision === 'reject') return 'reject';
  return decision ?? 'unknown';
}

function applyReviewPhaseState(
  projectRoot: string,
  changeId: string,
  phase: string,
  reviewRel: string,
  produces: string[],
  skillFields: Record<string, unknown> | null,
  opts: ApplyPhaseOptions,
): void {
  const outputs = assertProducesPresentAndFresh(projectRoot, changeId, produces, opts.minMtimeMs);
  const review = readJsonRecord(changeFile(projectRoot, changeId, reviewRel));
  if (!review) throw new Error(`state apply: review JSON unreadable: ${reviewRel}`);
  const decision = asString(review.decision);
  const status = reviewDecisionStatus(decision);
  recordPhaseCompletion(projectRoot, changeId, {
    phase,
    state: {
      status,
      ...(skillFields ?? {}),
      decision,
      gate_file: reviewRel,
      outputs,
    },
    transitionTo: status === 'pass' ? 'done' : status,
    outputs,
  });
}

function applyReviewFixerState(
  projectRoot: string,
  changeId: string,
  fixerPhase: string,
  repairOf: string,
  produces: string[],
  opts: ApplyPhaseOptions,
): void {
  assertProducesPresentAndFresh(projectRoot, changeId, produces, opts.minMtimeMs);
  const reviewKey = phaseIdToStateKey(repairOf);
  const file = getWorkflowStateFile(projectRoot, changeId);
  const state = readWorkflowState(file);
  const root = isRecord(state) ? state : {};
  const phases = isRecord(root.phases) ? root.phases as Record<string, unknown> : {};
  const existing = isRecord(phases[reviewKey]) ? { ...(phases[reviewKey] as Record<string, unknown>) } : {};
  const attempts = Array.isArray(existing.fix_attempts) ? [...existing.fix_attempts] : [];
  attempts.push({
    fixer_phase: fixerPhase,
    at: new Date().toISOString(),
  });
  // Fixer must NOT flip reviewer status to pass — only append attempts.
  const reviewerStatus = typeof existing.status === 'string' ? existing.status : 'needs_fix';
  if (reviewerStatus === 'pass') {
    throw new Error(
      `state apply fixer: review phase "${repairOf}" is already pass; fixer must not re-apply`,
    );
  }
  phases[reviewKey] = {
    ...existing,
    status: reviewerStatus === 'pass' ? reviewerStatus : 'needs_fix',
    fix_attempts: attempts,
  };
  root.phases = phases;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml.dump(root, { lineWidth: 120 }), 'utf-8');

  // Record fixer phase itself as done (attempt applied), without claiming review
  // pass. Stamp skill load so the fixer phase can be terminal (Skill Load Gate):
  // the caller dispatched this fixer skill and passes its SKILL.md path.
  recordPhaseCompletion(projectRoot, changeId, {
    phase: fixerPhase,
    state: { status: 'done', repaired: repairOf, ...skillLoadFields(projectRoot, opts.skillMdPath) },
    transitionTo: 'done',
    outputs: produces,
  });
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
    // Pure CLI phase: no dedicated executor SKILL.md. Record n/a so the retro
    // skill-drift detector does not treat the seeded `false` as real drift.
    skill_loaded: 'n/a',
    skill_md_path: null,
    skill_loaded_at: null,
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

  if (phase === 'healing-rerun') {
    // Also record the dedicated healing_rerun phase evidence.
    updateWorkflowStatePhase(projectRoot, changeId, 'healing_rerun', {
      status,
      batch_id: batchId,
    });
  }
}

function applyInspectState(
  projectRoot: string,
  changeId: string,
  phase: 'inspect' | 'healing-reinspect',
  skillFields: Record<string, unknown> | null = null
): void {
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
      ...(skillFields ?? {}),
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
      ...(skillFields ?? {}),
      inspect_mode: asString(analysis.inspect_mode) ?? 'primary',
      classification_performed: Boolean(analysis.classification_performed),
    });
  }
}

function applyReportState(
  projectRoot: string,
  changeId: string,
  skillFields: Record<string, unknown> | null = null
): void {
  const report = readJsonRecord(changeFile(projectRoot, changeId, 'report/quality-report.json'));
  if (!report) throw new Error('report/quality-report.json not found; run aws report generate before state apply');

  recordPhaseCompletion(projectRoot, changeId, {
    phase: 'report',
    state: {
      status: 'done',
      ...(skillFields ?? {}),
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
