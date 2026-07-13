/**
 * Deterministic orchestration engine — the heart of `aws status` / `aws gate
 * check`. No LLM. Pure function of workflow-schema.yaml + the change directory's
 * workflow-state.yaml and JSON artifacts.
 *
 * Two public operations (see docs/design/orchestration-cli-contract.md):
 *   - computeStatus(): state of every phase node (pruned/blocked/ready/
 *     awaiting_gate/done/stopped) + next + terminal.
 *   - checkGate():     adjudicate one phase's gate to a single verdict.
 *
 * AWS-specific rule (vs OpenSpec): a phase with a `gate` is NEVER `done` on
 * produces-existence alone — `done` requires gate verdict == 'pass'.
 *
 * Gate adjudication follows predicate-dsl.md §6 three-state resolution and is
 * fail-closed: when in doubt the verdict is the gate's `default` ('stop').
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
  compile,
  evaluate,
  Scope,
  EvalContext,
  DslValue,
  EvalResult,
} from './dsl';
import { Schema, PhaseDef, GateDef, deriveAlias } from './schema';
import { HumanDecisionEvent, isHumanDecisionAction, readEvents } from '../core/events';
import { resolveDecisionSupport } from '../core/decision_support';
import { sha256File } from '../core/hash';
import { isAuditedGateRead } from '../core/audit_scope';
import { deriveHealingState } from '../core/healing_state';
import { validateArtifactFile } from '../schema';

// ─── Report types (match the CLI JSON contract) ─────────────────────────────

export type PhaseStatusKind =
  | 'pruned'
  | 'out_of_scope'
  | 'blocked'
  | 'ready'
  | 'awaiting_gate'
  | 'done'
  | 'stopped'
  | 'tampered';

export interface PhaseStatus {
  id: string;
  status: PhaseStatusKind;
  gate: string | null;
  produces_present?: boolean;
  gate_verdict?: string | null;
  missingDeps?: string[];
  reason?: string;
}

export interface Terminal {
  kind: 'stopped' | 'completed';
  reason: string;
  phase?: string;
}

export interface RunContextReport {
  orchestrator_skill?: string;
  interaction_mode?: string;
  active_scope?: string;
  stamped_at?: string;
}

export interface OpenQuestionSummary {
  total: number;
  answered: number;
  deferred: number;
  unanswered: number;
}

export interface StatusReport {
  schema_version: string;
  schema: string;
  change_id: string;
  params: Record<string, DslValue>;
  run_context: RunContextReport | null;
  intake?: { open_questions: OpenQuestionSummary };
  phases: PhaseStatus[];
  next: string[];
  healing: { attempts_used: number; max: number; status: string };
  pending_decision: {
    checkpoint: string;
    phase: string;
    gate: string;
    reason: string;
  } | null;
  terminal: Terminal | null;
}

export interface GateReport {
  schema_version: string;
  change_id: string;
  phase: string | null;
  gate: string;
  verdict: string;
  reads: string[];
  evidence: Record<string, DslValue>;
  matched_rule: string | null;
  recommended_phase: string | null;
}

interface GateResolution {
  verdict: string;
  matchedRule: string | null;
  evidence: Record<string, DslValue>;
  reads: string[];
}

const TERMINAL_VERDICTS = new Set(['stop', 'reject']);

// ─── Document loading ────────────────────────────────────────────────────────

interface LoadedDoc {
  present: boolean;
  parseError: boolean;
  value: DslValue | undefined;
}

function isObject(v: unknown): v is Record<string, DslValue> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ─── Engine ──────────────────────────────────────────────────────────────────

export interface EngineOptions {
  schema: Schema;
  projectRoot: string;
  changeId: string;
}

export class Engine {
  private schema: Schema;
  private projectRoot: string;
  private changeId: string;
  private changeDir: string;

  private docCache = new Map<string, LoadedDoc>();
  private gateMemo = new Map<string, GateResolution>();
  private gateInProgress = new Set<string>();

  /** alias → canonical path, derived from every phase `produces`. */
  private reverseAlias = new Map<string, string>();

  readonly params: Record<string, DslValue>;
  private stateDoc: DslValue;
  private activeScope: string | null;

  constructor(opts: EngineOptions) {
    this.schema = opts.schema;
    this.projectRoot = opts.projectRoot;
    this.changeId = opts.changeId;
    this.changeDir = path.join(opts.projectRoot, 'qa', 'changes', opts.changeId);

    for (const phase of this.schema.phases) {
      for (const p of phase.produces) {
        const alias = deriveAlias(p);
        if (!this.reverseAlias.has(alias)) this.reverseAlias.set(alias, p);
      }
    }

    const state = this.loadDoc('workflow-state.yaml').value;
    this.stateDoc = isObject(state) ? state : {};
    const derivedHealing = deriveHealingState(this.projectRoot, this.changeId);
    const phases = isObject((this.stateDoc as Record<string, DslValue>).phases)
      ? (this.stateDoc as Record<string, DslValue>).phases as Record<string, DslValue>
      : {};
    const persistedHealing = isObject(phases.healing) ? phases.healing : {};
    phases.healing = {
      ...persistedHealing,
      status: derivedHealing.status,
      attempts_used: derivedHealing.attempts_used,
      all_fixers_no_op: derivedHealing.all_fixers_no_op,
    };
    (this.stateDoc as Record<string, DslValue>).phases = phases;
    const runContext = isObject((this.stateDoc as Record<string, DslValue>).run_context)
      ? (this.stateDoc as Record<string, DslValue>).run_context as Record<string, DslValue>
      : {};
    this.activeScope = typeof runContext.active_scope === 'string' ? runContext.active_scope : null;

    this.params = {};
    for (const [k, spec] of Object.entries(this.schema.params)) {
      this.params[k] = spec.default;
    }
    const stateParams = (this.stateDoc as Record<string, DslValue>).params;
    if (isObject(stateParams)) {
      Object.assign(this.params, stateParams);
    }
  }

  // ── path + file helpers ────────────────────────────────────────────────────

  /** Resolve a schema path string to an absolute filesystem path. */
  resolvePath(p: string): string {
    const sub = p.replace(/<change-id>/g, this.changeId);
    if (sub.startsWith('repo:')) {
      return path.join(this.projectRoot, sub.slice('repo:'.length));
    }
    // archive produces (`qa/archive/...`) are repo-root relative; everything
    // else is relative to the change directory.
    if (sub.startsWith('qa/')) {
      return path.join(this.projectRoot, sub);
    }
    return path.join(this.changeDir, sub);
  }

  fileExists(p: string): boolean {
    const abs = this.resolvePath(p);
    const wantsDir = p.endsWith('/');
    if (!fs.existsSync(abs)) return false;
    const stat = fs.statSync(abs);
    if (wantsDir) {
      return stat.isDirectory() && fs.readdirSync(abs).length > 0;
    }
    return true;
  }

  private loadDoc(p: string): LoadedDoc {
    const abs = this.resolvePath(p);
    const cached = this.docCache.get(abs);
    if (cached) return cached;

    let result: LoadedDoc;
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      result = { present: fs.existsSync(abs), parseError: false, value: undefined };
    } else {
      try {
        const text = fs.readFileSync(abs, 'utf-8');
        const isYaml = /\.ya?ml$/.test(abs);
        const parsed = isYaml ? yaml.load(text) : JSON.parse(text);
        result = { present: true, parseError: false, value: parsed as DslValue };
      } catch {
        result = { present: true, parseError: true, value: undefined };
      }
    }
    this.docCache.set(abs, result);
    return result;
  }

  private docValue(p: string): DslValue | undefined {
    return this.loadDoc(p).value;
  }

  // ── scope + eval context ────────────────────────────────────────────────────

  private makeContext(): EvalContext {
    return {
      fileExists: p => this.fileExists(p),
      gateVerdict: id => this.resolveGate(id).verdict,
    };
  }

  /**
   * Scope with lazy document resolution.
   * @param aliasMap  alias → path for the docs reachable in this scope
   * @param hoisted   primary-doc top-level keys (gates only); null otherwise
   */
  private makeScope(aliasMap: Map<string, string>, hoisted: Record<string, DslValue> | null): Scope {
    const engine = this;
    return {
      lookup(name: string): EvalResult {
        if (name === 'params') return engine.params;
        if (name === 'state' || name === 'workflow_state') return engine.stateDoc;
        if (hoisted && Object.prototype.hasOwnProperty.call(hoisted, name)) {
          return hoisted[name];
        }
        const aliasPath = aliasMap.get(name);
        if (aliasPath !== undefined) return engine.docValue(aliasPath);
        return undefined;
      },
    };
  }

  private evalPredicate(expr: string, scope: Scope): EvalResult {
    return evaluate(compile(expr), scope, this.makeContext());
  }

  /** Scope for phase `when` / loop `allocate_on` (no primary-doc hoisting). */
  private predicateScope(): Scope {
    return this.makeScope(this.reverseAlias, null);
  }

  // ── gate adjudication (predicate-dsl §6) ────────────────────────────────────

  resolveGate(gateId: string): GateResolution {
    const memo = this.gateMemo.get(gateId);
    if (memo) return memo;

    const gate = this.schema.gates[gateId];
    if (!gate) {
      const res: GateResolution = {
        verdict: 'stop',
        matchedRule: null,
        evidence: {},
        reads: [],
      };
      this.gateMemo.set(gateId, res);
      return res;
    }

    if (this.gateInProgress.has(gateId)) {
      // Cycle — validator should have caught this; fail closed.
      return { verdict: 'stop', matchedRule: 'cycle', evidence: {}, reads: gate.reads.map(r => r.path) };
    }
    this.gateInProgress.add(gateId);
    try {
      const res = this.applyGateDecision(gateId, this.adjudicate(gate));
      this.gateMemo.set(gateId, res);
      return res;
    } finally {
      this.gateInProgress.delete(gateId);
    }
  }

  private applyGateDecision(gateId: string, base: GateResolution): GateResolution {
    if (base.verdict !== 'needs_human_review' || isCodegenHardGate(gateId)) return base;
    const decision = this.latestValidGateDecision(gateId);
    if (!decision) return base;

    const verdict = decision.action === 'accept_risk'
      ? 'pass'
      : decision.action === 'fix_and_proceed'
        ? 'needs_fix'
        : base.verdict;
    if (verdict === base.verdict) return base;
    return {
      ...base,
      verdict,
      matchedRule: `${base.matchedRule ?? 'default'}; human_decision:${decision.action}`,
      evidence: {
        ...base.evidence,
        decision_checkpoint: decision.checkpoint,
        decision_action: decision.action,
        decision_who: decision.who,
        decision_reason: decision.reason,
        decision_review_file: decision.review_file!,
        decision_review_sha256: decision.review_sha256!,
      },
    };
  }

  private latestValidGateDecision(gateId: string): HumanDecisionEvent | null {
    const gate = this.schema.gates[gateId];
    if (!gate) return null;
    const auditedReads = new Set(gate.reads.filter(read => isAuditedGateRead(read.path)).map(read => read.path));
    if (auditedReads.size === 0) return null;

    const events = readEvents(this.projectRoot, this.changeId);
    let latestMatching: HumanDecisionEvent | null = null;
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index];
      if (event.source !== 'decide' || event.type !== 'human_decision') continue;
      const phase = this.schema.phasesById.get(event.checkpoint);
      const healingSafety = gateId === 'fixer-safety-gate' && event.checkpoint === 'healing.safety';
      if (event.checkpoint === gateId || phase?.gate === gateId || healingSafety) {
        latestMatching = event;
        break;
      }
    }
    if (
      !latestMatching
      || (latestMatching.action !== 'accept_risk' && latestMatching.action !== 'fix_and_proceed')
      || typeof latestMatching.reason !== 'string'
      || latestMatching.reason.trim() === ''
      || typeof latestMatching.who !== 'string'
      || latestMatching.who.trim() === ''
      || !latestMatching.review_file
      || !latestMatching.review_sha256
      || !auditedReads.has(latestMatching.review_file)
    ) {
      return null;
    }
    try {
      const support = resolveDecisionSupport(this.schema, latestMatching.checkpoint, latestMatching.action);
      const normalGateDecision = support.consumer === 'gate-decision' && support.gateId === gateId;
      const healingSafetyDecision =
        support.consumer === 'healing-safety' && gateId === 'fixer-safety-gate';
      if (!normalGateDecision && !healingSafetyDecision) return null;
    } catch {
      return null;
    }
    const current = sha256File(this.resolvePath(latestMatching.review_file));
    return current === latestMatching.review_sha256 ? latestMatching : null;
  }

  private adjudicate(gate: GateDef): GateResolution {
    const readPaths = gate.reads.map(r => r.path);

    // Step 1 — invalid_json: stop
    if (gate.invalid_json === 'stop') {
      for (const r of gate.reads) {
        const doc = this.loadDoc(r.path);
        if (doc.present && doc.parseError) {
          return { verdict: 'stop', matchedRule: 'invalid_json', evidence: {}, reads: readPaths };
        }
      }
    }

    // Schema-invalid structured artifacts fail closed like parse failures.
    const schemaInvalid: string[] = [];
    for (const r of gate.reads) {
      const doc = this.loadDoc(r.path);
      if (!doc.present || doc.parseError) continue;
      const invalid = validateArtifactFile(this.resolvePath(r.path), r.path)
        .filter(result => !result.ok);
      schemaInvalid.push(
        ...invalid.map(result => `${result.path}: ${result.errors.join('; ')}`),
      );
    }
    if (schemaInvalid.length > 0) {
      return {
        verdict: gate.invalid_json ?? gate.default,
        matchedRule: 'schema_invalid',
        evidence: { schema_invalid: schemaInvalid },
        reads: readPaths,
      };
    }

    // Build scope: primary doc hoisting + per-gate aliases.
    const aliasMap = new Map<string, string>();
    for (const r of gate.reads) aliasMap.set(r.alias, r.path);

    const primary = gate.reads[0];
    const primaryVal = primary ? this.docValue(primary.path) : undefined;
    const hoisted: Record<string, DslValue> = isObject(primaryVal) ? primaryVal : {};
    const scope = this.makeScope(aliasMap, hoisted);

    const evidence = scalarFields(hoisted);

    // Step 2 — evaluate rules in order; first `true` wins.
    let sawUndefined = false;
    for (const rule of gate.rules) {
      const r = this.evalPredicate(rule.expr, scope);
      if (r === true) {
        return {
          verdict: rule.verdict,
          matchedRule: `${rule.field}: ${rule.expr}`,
          evidence,
          reads: readPaths,
        };
      }
      if (r === undefined) sawUndefined = true;
    }

    // Step 3 — no rule matched + an undefined path + missing_field_is
    if (sawUndefined && gate.missing_field_is) {
      return { verdict: gate.missing_field_is, matchedRule: null, evidence, reads: readPaths };
    }

    // Step 4 — a reads file entirely missing + missing_file_is
    const anyMissing = gate.reads.some(r => !this.fileExists(r.path));
    if (anyMissing && gate.missing_file_is) {
      return { verdict: gate.missing_file_is, matchedRule: null, evidence, reads: readPaths };
    }

    // Step 5 — default (fail-closed).
    return { verdict: gate.default, matchedRule: null, evidence, reads: readPaths };
  }

  /** Public gate check for a phase (resolves the phase's `gate:`). */
  checkGate(phaseId: string): GateReport {
    const phase = this.schema.phasesById.get(phaseId);
    if (!phase) throw new Error(`Unknown phase '${phaseId}'`);
    if (!phase.gate) throw new Error(`Phase '${phaseId}' has no gate`);

    const res = this.resolveGate(phase.gate);
    let recommended: string | null = null;
    if (res.verdict === 'needs_fix') {
      recommended = this.schema.phases.find(p => p.repair_of === phaseId)?.id ?? null;
    }
    return {
      schema_version: this.schema.schema_version,
      change_id: this.changeId,
      phase: phaseId,
      gate: phase.gate,
      verdict: res.verdict,
      reads: res.reads,
      evidence: res.evidence,
      matched_rule: res.matchedRule,
      recommended_phase: recommended,
    };
  }

  // ── state detection ──────────────────────────────────────────────────────────

  computeStatus(): StatusReport {
    const prunedMap = this.computePruned();
    const order = this.topoOrder();
    const statusMap = new Map<string, PhaseStatus>();

    for (const id of order) {
      const phase = this.schema.phasesById.get(id)!;
      statusMap.set(id, this.computePhaseStatus(phase, prunedMap, statusMap));
    }

    // Preserve declaration order in the output.
    const phases = this.schema.phases.map(p => statusMap.get(p.id)!);

    const recordedTerminal = this.recordedStoppedTerminal();
    const next = recordedTerminal
      ? []
      : phases.filter(p => p.status === 'ready').map(p => p.id);
    const stopped = phases.find(p => p.status === 'stopped');
    const pendingPhase = phases.find(
      phase => phase.produces_present
        && phase.status === 'awaiting_gate'
        && phase.gate_verdict === 'needs_human_review'
        && phase.gate,
    );
    const pendingDecision = pendingPhase?.gate
      ? {
          checkpoint: pendingPhase.gate,
          phase: pendingPhase.id,
          gate: pendingPhase.gate,
          reason: `gate ${pendingPhase.gate} requires human review`,
        }
      : null;
    let terminal: Terminal | null = null;
    if (recordedTerminal) {
      terminal = recordedTerminal;
    } else if (stopped) {
      terminal = {
        kind: 'stopped',
        phase: stopped.id,
        reason: `gate '${stopped.gate}' verdict '${stopped.gate_verdict}'`,
      };
    } else {
      const active = phases.filter(p => p.status !== 'pruned' && this.phaseInActiveScope(p.id));
      if (active.length > 0 && active.every(p => p.status === 'done')) {
        terminal = {
          kind: 'completed',
          reason: this.activeScope && this.activeScope !== 'full'
            ? 'all in-scope phases done'
            : 'all active phases done',
        };
      }
    }

    return {
      schema_version: this.schema.schema_version,
      schema: this.schema.name,
      change_id: this.changeId,
      params: this.params,
      run_context: this.runContextReport(),
      intake: this.intakeSummary(),
      phases,
      next,
      healing: this.healingSummary(),
      pending_decision: pendingDecision,
      terminal,
    };
  }

  private recordedStoppedTerminal(): Terminal | null {
    const decisions = readEvents(this.projectRoot, this.changeId);
    for (let index = decisions.length - 1; index >= 0; index--) {
      const event = decisions[index];
      if (
        event.source !== 'decide'
        || event.type !== 'human_decision'
        || event.action !== 'stop'
        || !isHumanDecisionAction(event.action)
        || typeof event.checkpoint !== 'string'
        || typeof event.reason !== 'string'
        || event.reason.trim() === ''
        || typeof event.who !== 'string'
        || event.who.trim() === ''
      ) {
        continue;
      }
      try {
        if (resolveDecisionSupport(this.schema, event.checkpoint, event.action).consumer !== 'terminal-status') {
          continue;
        }
      } catch {
        continue;
      }
      return {
        kind: 'stopped',
        reason: event.reason,
        phase: event.checkpoint,
      };
    }
    return null;
  }

  private computePruned(): Map<string, boolean> {
    const map = new Map<string, boolean>();
    const scope = this.predicateScope();
    for (const phase of this.schema.phases) {
      if (!phase.when) {
        map.set(phase.id, false);
        continue;
      }
      map.set(phase.id, this.evalPredicate(phase.when, scope) !== true);
    }
    return map;
  }

  private computePhaseStatus(
    phase: PhaseDef,
    pruned: Map<string, boolean>,
    statusMap: Map<string, PhaseStatus>
  ): PhaseStatus {
    const gate = phase.gate ?? null;

    // Direct pruning via the phase's own `when` predicate.
    if (pruned.get(phase.id)) {
      return { id: phase.id, status: 'pruned', gate, reason: 'when predicate false' };
    }

    // Active deps = required phases that are not pruned (directly or
    // transitively). A dep's *computed* status drives this, so pruning cascades
    // down the graph (topological order guarantees deps are computed first).
    const isPrunedDep = (d: string) => statusMap.get(d)?.status === 'pruned';
    const activeDeps = phase.requires.filter(d => !isPrunedDep(d));

    // Transitive pruning: if a phase has requirements but every one of them is
    // pruned, its entire upstream branch is inactive → prune this phase too.
    if (phase.requires.length > 0 && activeDeps.length === 0) {
      return { id: phase.id, status: 'pruned', gate, reason: 'all dependencies pruned' };
    }

    const producesPresent = phase.produces.every(p => this.fileExists(p));

    if (!producesPresent && !this.phaseInActiveScope(phase.id)) {
      return {
        id: phase.id,
        status: 'out_of_scope',
        gate,
        produces_present: false,
        reason: `outside active_scope '${this.activeScope}'`,
      };
    }

    const isDone = (d: string) => {
      if (statusMap.get(d)?.status === 'done') return true;
      if (phase.repair_of !== d) return false;
      const repaired = this.schema.phasesById.get(d);
      return repaired?.gate ? this.resolveGate(repaired.gate).verdict === 'needs_fix' : false;
    };
    const doneDeps = activeDeps.filter(isDone);
    const missingDeps = activeDeps.filter(d => !isDone(d));

    const blocked =
      phase.requires_mode === 'any_active'
        ? activeDeps.length > 0 && doneDeps.length === 0
        : missingDeps.length > 0;

    if (blocked) {
      return { id: phase.id, status: 'blocked', gate, missingDeps };
    }

    const repairedPhase = phase.repair_of
      ? this.schema.phasesById.get(phase.repair_of)
      : undefined;
    const repairRequested = repairedPhase?.gate
      ? this.resolveGate(repairedPhase.gate).verdict === 'needs_fix'
      : false;
    if (repairRequested) {
      return { id: phase.id, status: 'ready', gate, produces_present: producesPresent };
    }

    if (!producesPresent) {
      // Readiness guard: deps are done but a `ready_when` predicate must also
      // hold before the router may dispatch this phase (three-state: false or
      // undefined both block — fail closed).
      if (phase.ready_when && this.evalPredicate(phase.ready_when, this.predicateScope()) !== true) {
        return {
          id: phase.id,
          status: 'blocked',
          gate,
          missingDeps: [],
          reason: `ready_when not satisfied: ${phase.ready_when}`,
        };
      }
      return { id: phase.id, status: 'ready', gate, produces_present: false };
    }

    if (!gate) {
      return { id: phase.id, status: 'done', gate, produces_present: true };
    }

    const verdict = this.resolveGate(gate).verdict;
    let status: PhaseStatusKind;
    if (TERMINAL_VERDICTS.has(verdict)) status = 'stopped';
    else if (verdict === 'pass') status = 'done';
    else status = 'awaiting_gate';

    return {
      id: phase.id,
      status,
      gate,
      produces_present: true,
      gate_verdict: verdict,
    };
  }

  private phaseInActiveScope(phaseId: string): boolean {
    if (!this.activeScope || this.activeScope === 'full') return true;
    const phase = this.schema.phasesById.get(phaseId);
    if (!phase?.owned_by?.length) return true;
    return phase.owned_by.includes(this.activeScope);
  }

  private runContextReport(): RunContextReport | null {
    const runContext = (this.stateDoc as Record<string, DslValue>).run_context;
    if (!isObject(runContext)) return null;
    const report: RunContextReport = {};
    for (const key of ['orchestrator_skill', 'interaction_mode', 'active_scope', 'stamped_at'] as const) {
      const value = runContext[key];
      if (typeof value === 'string') report[key] = value;
    }
    return Object.keys(report).length > 0 ? report : null;
  }

  private intakeSummary(): { open_questions: OpenQuestionSummary } | undefined {
    const advisory = this.docValue('explore/advisory.json');
    if (!isObject(advisory)) return undefined;
    const raw = advisory.open_questions_for_case_design;
    if (!Array.isArray(raw)) return undefined;

    let answered = 0;
    let deferred = 0;
    for (const item of raw) {
      if (!isObject(item)) continue;
      if (item.status === 'answered' || (item.status === undefined && item.answer != null && item.answered_via === 'explore')) {
        answered += 1;
      } else if (item.status === 'deferred') {
        deferred += 1;
      }
    }
    const total = raw.length;
    return {
      open_questions: {
        total,
        answered,
        deferred,
        unanswered: Math.max(0, total - answered - deferred),
      },
    };
  }

  private healingSummary(): { attempts_used: number; max: number; status: string } {
    const state = this.stateDoc as Record<string, DslValue>;
    const phases = isObject(state.phases) ? state.phases : {};
    const healing = isObject((phases as Record<string, DslValue>).healing)
      ? ((phases as Record<string, DslValue>).healing as Record<string, DslValue>)
      : {};
    const attemptsUsed = typeof healing.attempts_used === 'number' ? healing.attempts_used : 0;
    const max = typeof this.params.max_healing_attempts === 'number'
      ? (this.params.max_healing_attempts as number)
      : 0;
    const status = typeof healing.status === 'string' ? healing.status : 'pending';
    return { attempts_used: attemptsUsed, max, status };
  }

  /** Kahn topological sort over `requires`; falls back to declaration order. */
  private topoOrder(): string[] {
    const indeg = new Map<string, number>();
    const adj = new Map<string, string[]>();
    for (const p of this.schema.phases) {
      indeg.set(p.id, 0);
      adj.set(p.id, []);
    }
    for (const p of this.schema.phases) {
      for (const dep of p.requires) {
        if (!adj.has(dep)) continue; // dangling — validator reports it
        adj.get(dep)!.push(p.id);
        indeg.set(p.id, (indeg.get(p.id) ?? 0) + 1);
      }
    }
    const queue = this.schema.phases.filter(p => (indeg.get(p.id) ?? 0) === 0).map(p => p.id);
    const out: string[] = [];
    while (queue.length) {
      const id = queue.shift()!;
      out.push(id);
      for (const next of adj.get(id) ?? []) {
        indeg.set(next, (indeg.get(next) ?? 0) - 1);
        if (indeg.get(next) === 0) queue.push(next);
      }
    }
    if (out.length !== this.schema.phases.length) {
      return this.schema.phases.map(p => p.id); // cycle fallback
    }
    return out;
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Keep only scalar top-level fields for gate evidence (avoid dumping arrays). */
function scalarFields(obj: Record<string, DslValue>): Record<string, DslValue> {
  const out: Record<string, DslValue> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
      out[k] = v;
    }
  }
  return out;
}

function isCodegenHardGate(gateId: string): boolean {
  return gateId.endsWith('-codegen-precondition-gate');
}

// ─── functional API ───────────────────────────────────────────────────────────

export function computeStatus(opts: EngineOptions): StatusReport {
  return new Engine(opts).computeStatus();
}

export function checkGate(opts: EngineOptions & { phaseId: string }): GateReport {
  return new Engine(opts).checkGate(opts.phaseId);
}

// ─── Dispatch resolution ─────────────────────────────────────────────────────

export type PhaseExecutor =
  | 'internal:test-infra-bootstrap'
  | 'internal:skill-registry-check'
  | 'cli:aws-run'
  | 'agent:opencode';

export interface PhaseDispatchEntry {
  phase: string;
  /** How the driver should run this phase. */
  kind: 'internal' | 'cli' | 'agent';
  executor: PhaseExecutor;
  skill: string | null;
  agent: string | null;
  gate: string | null;
}

const CLI_AWS_RUN_PHASES = new Set(['execution', 'healing-rerun']);

/**
 * Map the ready-phase ids from a StatusReport into concrete dispatch entries
 * that the orchestrator/driver can execute. Pure function of schema — no LLM,
 * no filesystem. Fail-closed for unknown skill:null phases.
 */
export function resolveNextDispatch(next: string[], schema: Schema): PhaseDispatchEntry[] {
  return next.map(phase => {
    const def = schema.phasesById.get(phase);
    if (!def) throw new Error(`resolveNextDispatch: unknown phase '${phase}'`);
    const gate = def.gate ?? null;

    if (phase === 'skill-registry-check') {
      return {
        phase,
        kind: 'internal',
        executor: 'internal:skill-registry-check',
        skill: null,
        agent: null,
        gate,
      };
    }
    if (phase === 'test-infra-bootstrap') {
      return {
        phase,
        kind: 'internal',
        executor: 'internal:test-infra-bootstrap',
        skill: null,
        agent: null,
        gate,
      };
    }
    if (def.skill === null) {
      if (!CLI_AWS_RUN_PHASES.has(phase)) {
        throw new Error(
          `resolveNextDispatch: unknown skill:null phase '${phase}' (fail-closed)`,
        );
      }
      return {
        phase,
        kind: 'cli',
        executor: 'cli:aws-run',
        skill: null,
        agent: null,
        gate,
      };
    }
    return {
      phase,
      kind: 'agent',
      executor: 'agent:opencode',
      skill: def.skill,
      agent: def.agent ?? null,
      gate,
    };
  });
}
