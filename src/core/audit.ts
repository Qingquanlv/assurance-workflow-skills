import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { readEvents, GateVerdictEvent, HumanDecisionEvent, QaEvent } from './events';
import { sha256File } from './hash';
import { isAuditedGateRead } from './audit_scope';
import { resolveDecisionSupport } from './decision_support';
import type { Schema, PhaseDef } from '../orchestration/schema';
import type { PhaseStatus, StatusReport, Terminal } from '../orchestration/engine';

export interface AuditIssue {
  code: string;
  message: string;
  phase?: string;
}

export interface AuditResult {
  issues: AuditIssue[];
}

const SKILL_LOAD_EXEMPT_PHASES = new Set([
  'skill_registry_check',
  'layers',
  'execution',
  'healing-rerun',
  'healing_rerun',
]);

const TERMINAL_SKILL_STATUSES = new Set([
  'done',
  'pass',
  'needs_fix',
  'needs_human_review',
  'reject',
  'failed',
  'partial',
  'unavailable',
  'stopped',
  'proposal_created',
  'applied',
  'resolved',
  'exhausted',
]);

export function runStatusAudits(
  projectRoot: string,
  changeId: string,
  report: StatusReport,
  schema: Schema,
): AuditResult {
  const issues: AuditIssue[] = [];
  issues.push(...auditGateTampering(projectRoot, changeId, report, schema));
  issues.push(...auditSkillLoadGate(projectRoot, changeId));
  issues.push(...auditVerdictTransitions(projectRoot, changeId, schema));
  issues.push(...auditReclassificationEvents(projectRoot, changeId));
  return { issues };
}

export function applyAuditsToReport(report: StatusReport, audit: AuditResult): StatusReport {
  if (audit.issues.length === 0) return report;

  const phases = [...report.phases];
  let terminal: Terminal | null = report.terminal;

  for (const issue of audit.issues) {
    if (issue.code === 'ARTIFACT-TAMPERED' && issue.phase) {
      const idx = phases.findIndex(p => p.id === issue.phase);
      if (idx >= 0) {
        phases[idx] = { ...phases[idx], status: 'tampered', reason: issue.message };
      }
    }
    terminal = {
      kind: 'stopped',
      reason: issue.message,
      phase: issue.phase ?? terminal?.phase,
    };
  }

  return { ...report, phases, terminal };
}

function auditGateTampering(
  projectRoot: string,
  changeId: string,
  report: StatusReport,
  schema: Schema,
): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const events = readEvents(projectRoot, changeId);
  const lastVerdictByGate = latestGateVerdicts(events);
  issues.push(...auditHumanDecisionEvidence(projectRoot, changeId, events));

  for (const phase of report.phases) {
    if (phase.status !== 'done' && phase.status !== 'stopped') continue;
    if (!phase.gate) continue;

    const gate = schema.gates[phase.gate];
    if (!gate) continue;

    const verdictEvent = lastVerdictByGate.get(phase.gate);
    if (!verdictEvent?.reads_sha256) continue;

    for (const [relPath, recordedHash] of Object.entries(verdictEvent.reads_sha256)) {
      if (!isAuditedGateRead(relPath)) continue;
      const abs = resolveChangePath(projectRoot, changeId, relPath);
      const current = sha256File(abs);
      if (current && current !== recordedHash) {
        issues.push({
          code: 'ARTIFACT-TAMPERED',
          phase: phase.id,
          message: `ARTIFACT-TAMPERED: ${phase.id} ${relPath}`,
        });
      }
    }
  }

  return issues;
}

function auditSkillLoadGate(projectRoot: string, changeId: string): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const statePath = path.join(projectRoot, 'qa', 'changes', changeId, 'workflow-state.yaml');
  if (!fs.existsSync(statePath)) return issues;

  let state: unknown;
  try {
    state = yaml.load(fs.readFileSync(statePath, 'utf-8'));
  } catch {
    return issues;
  }
  if (!isRecord(state) || !isRecord(state.phases)) return issues;

  for (const [phase, raw] of Object.entries(state.phases)) {
    if (!isRecord(raw)) continue;
    if (!phaseRequiresSkillLoad(phase, raw)) continue;
    if (raw.skill_loaded === true) continue;
    issues.push({
      code: 'SKILL_LOAD_GATE_VIOLATION',
      phase,
      message:
        `SKILL_LOAD_GATE_VIOLATION: phase ${phase} cannot be terminal because ` +
        `skill_loaded is ${String(raw.skill_loaded)}; read the phase SKILL.md and ` +
        `record skill_loaded=true via the orchestrator/CLI before completion.`,
    });
  }

  return issues;
}

function phaseRequiresSkillLoad(phase: string, state: Record<string, unknown>): boolean {
  if (SKILL_LOAD_EXEMPT_PHASES.has(phase)) return false;
  const status = firstString(state.status);
  if (!status) return false;
  if (phase === 'healing' && (status === 'not_needed' || status === 'skipped' || status === 'pending')) {
    return false;
  }
  // The workflow's archive eligibility recommendation is evaluated by the
  // orchestrator without loading aws-archive; the real archive skill runs only
  // on an explicit archive command.
  if (phase === 'archive' && (status === 'eligible' || status === 'not_eligible' || status === 'skipped')) {
    return false;
  }
  return TERMINAL_SKILL_STATUSES.has(status);
}

function auditHumanDecisionEvidence(
  projectRoot: string,
  changeId: string,
  events: QaEvent[],
): AuditIssue[] {
  const issues: AuditIssue[] = [];
  for (const event of events) {
    if (event.type !== 'human_decision') continue;
    if (!event.evidence_file || !event.evidence_sha256) continue;
    const abs = resolveChangePath(projectRoot, changeId, event.evidence_file);
    const current = sha256File(abs);
    if (current && current !== event.evidence_sha256) {
      issues.push({
        code: 'ARTIFACT-TAMPERED',
        phase: event.checkpoint,
        message: `ARTIFACT-TAMPERED: ${event.checkpoint} ${event.evidence_file}`,
      });
    }
  }
  return issues;
}

function auditReclassificationEvents(projectRoot: string, changeId: string): AuditIssue[] {
  const analysisPath = path.join(projectRoot, 'qa', 'changes', changeId, 'inspect', 'failure-analysis.json');
  if (!fs.existsSync(analysisPath)) return [];
  let analysis: unknown;
  try {
    analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf-8')) as unknown;
  } catch {
    return [];
  }
  if (!isRecord(analysis) || !Array.isArray(analysis.failures)) return [];
  const events = readEvents(projectRoot, changeId).filter(e => e.type === 'failure_reclassified');
  const issues: AuditIssue[] = [];
  for (const failure of analysis.failures) {
    if (!isRecord(failure) || !isRecord(failure.reclassified)) continue;
    const id = firstString(failure.id, failure.case_id, failure.test);
    const hasEvent = events.some(event => {
      return event.failure === id || event.failure === failure.case_id || event.failure === failure.test;
    });
    if (!hasEvent) {
      issues.push({
        code: 'RECLASSIFY-WITHOUT-EVENT',
        phase: 'inspect',
        message: `RECLASSIFY-WITHOUT-EVENT: ${id ?? 'unknown failure'} has reclassified metadata without failure_reclassified event`,
      });
    }
  }
  return issues;
}

function auditVerdictTransitions(
  projectRoot: string,
  changeId: string,
  schema: Schema,
): AuditIssue[] {
  const events = readEvents(projectRoot, changeId);
  const issues: AuditIssue[] = [];
  const repairByReviewPhase = buildRepairMap(schema);

  const byGate = new Map<string, GateVerdictEvent[]>();
  for (const event of events) {
    if (event.type !== 'gate_verdict') continue;
    const list = byGate.get(event.gate) ?? [];
    list.push(event);
    byGate.set(event.gate, list);
  }

  for (const [gateId, verdicts] of byGate) {
    for (let i = 1; i < verdicts.length; i++) {
      const prev = verdicts[i - 1];
      const next = verdicts[i];
      // A review can re-check several times during one needs_fix episode
      // (verdict stays needs_fix across attempts). The repair evidence may land
      // during an *earlier* attempt of the same episode, so scan for it from the
      // start of the current needs_fix streak, not just the immediately prior
      // verdict. Otherwise a legit multi-attempt fix (needs_fix → fix →
      // needs_fix → pass) is flagged as an illegal needs_fix→pass.
      let streakStart = i - 1;
      while (streakStart > 0 && verdicts[streakStart - 1].verdict === prev.verdict) {
        streakStart--;
      }
      const issue = checkVerdictMigration(
        events,
        schema,
        gateId,
        prev,
        next,
        repairByReviewPhase,
        verdicts[streakStart].seq,
      );
      if (issue) issues.push(issue);
    }
  }

  return issues;
}

function checkVerdictMigration(
  events: QaEvent[],
  schema: Schema,
  gateId: string,
  prev: GateVerdictEvent,
  next: GateVerdictEvent,
  repairByReviewPhase: Map<string, string>,
  repairSinceSeq: number = prev.seq,
): AuditIssue | null {
  const from = prev.verdict;
  const to = next.verdict;

  if (from === 'reject') {
    return {
      code: 'GATE-TRANSITION-ILLEGAL',
      message: `GATE-TRANSITION-ILLEGAL: ${gateId} reject→${to}`,
    };
  }

  // Repair/override evidence is searched from the start of the needs_fix streak
  // (repairSinceSeq) so multi-attempt fixes count. Content-change checks for
  // pass→pass use the immediately adjacent window (prev.seq) to stay strict.
  const betweenRepair = events.filter(e => e.seq > repairSinceSeq && e.seq < next.seq);
  const betweenAdjacent = events.filter(e => e.seq > prev.seq && e.seq < next.seq);
  const reviewPhase = findReviewPhaseForGate(schema, gateId);
  const repairPhase = reviewPhase ? repairByReviewPhase.get(reviewPhase) : undefined;
  // A repair phase whose status is already `done` from an earlier attempt in
  // the same needs_fix streak produces no fresh `phase_transition ... to=done`
  // on a later re-dispatch (no-op transition) — so also accept a
  // `phase_dispatched` driver event for the repair phase as valid evidence.
  // This keeps legitimate multi-attempt fixer loops (attempt 2, 3, ...) from
  // being flagged GATE-TRANSITION-ILLEGAL just because the phase state didn't
  // change on repeat attempts.
  const repairDone = repairPhase
    ? betweenRepair.some(e => (
        (e.type === 'phase_transition' && e.phase === repairPhase && e.to === 'done')
        || (e.type === 'phase_dispatched' && e.phase === repairPhase)
      ))
    : false;
  const latestDecision = latestMatchingGateDecision(betweenAdjacent, schema, gateId);
  const acceptRiskDecision = isValidAcceptRiskDecision(latestDecision, schema, gateId, next);

  if (from === 'needs_fix' && to === 'pass' && !repairDone) {
    return {
      code: 'GATE-TRANSITION-ILLEGAL',
      message: `GATE-TRANSITION-ILLEGAL: ${gateId} needs_fix→pass`,
    };
  }

  if (
    from === 'needs_human_review'
    && to === 'pass'
    && !acceptRiskDecision
    && !repairDone
  ) {
    return {
      code: 'GATE-TRANSITION-ILLEGAL',
      message: `GATE-TRANSITION-ILLEGAL: ${gateId} needs_human_review→pass`,
    };
  }

  if (from === 'pass' && to === 'pass') {
    const prevHash = prev.reads_sha256 ?? {};
    const nextHash = next.reads_sha256 ?? {};
    const hashChanged = Object.keys(nextHash).some(k => prevHash[k] && nextHash[k] !== prevHash[k]);
    const repairDoneAdjacent = repairPhase
      ? betweenAdjacent.some(e => e.type === 'phase_transition' && e.phase === repairPhase && e.to === 'done')
      : false;
    const healingEvidenceRefresh = isSafetyGate(schema, gateId) && betweenAdjacent.some(e =>
      (e.type === 'phase_transition' && (e.phase === 'healing-rerun' || e.phase === 'healing-reinspect')) ||
      e.type === 'execution_start',
    );
    if (hashChanged && !repairDoneAdjacent && !healingEvidenceRefresh) {
      return {
        code: 'GATE-TRANSITION-ILLEGAL',
        message: `GATE-TRANSITION-ILLEGAL: ${gateId} pass→pass (content changed)`,
      };
    }
  }

  return null;
}

function latestMatchingGateDecision(
  events: QaEvent[],
  schema: Schema,
  gateId: string,
): HumanDecisionEvent | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.source !== 'decide' || event.type !== 'human_decision') continue;
    const phase = schema.phasesById.get(event.checkpoint);
    if (event.checkpoint === gateId || phase?.gate === gateId) return event;
  }
  return null;
}

function isValidAcceptRiskDecision(
  event: HumanDecisionEvent | null,
  schema: Schema,
  gateId: string,
  next: GateVerdictEvent,
): boolean {
  if (
    !event
    || event.action !== 'accept_risk'
    || typeof event.reason !== 'string'
    || event.reason.trim() === ''
    || typeof event.who !== 'string'
    || event.who.trim() === ''
    || !event.review_file
    || !event.review_sha256
  ) {
    return false;
  }
  try {
    const support = resolveDecisionSupport(schema, event.checkpoint, event.action);
    if (support.consumer !== 'gate-decision' || support.gateId !== gateId) return false;
  } catch {
    return false;
  }
  const nextReads = next.reads_sha256;
  return Boolean(nextReads && nextReads[event.review_file] === event.review_sha256);
}

function isSafetyGate(schema: Schema, gateId: string): boolean {
  const gate = schema.gates[gateId];
  if (!gate) return false;
  return gate.reads.some(read =>
    read.path === 'healing/fixer-safety-check.json' ||
    read.path === 'inspect/inspect-safety-check.json',
  );
}

function latestGateVerdicts(events: QaEvent[]): Map<string, GateVerdictEvent> {
  const map = new Map<string, GateVerdictEvent>();
  for (const event of events) {
    if (event.type === 'gate_verdict') {
      map.set(event.gate, event);
    }
  }
  return map;
}

function buildRepairMap(schema: Schema): Map<string, string> {
  const map = new Map<string, string>();
  for (const phase of schema.phases) {
    if (phase.repair_of) map.set(phase.repair_of, phase.id);
  }
  return map;
}

function findReviewPhaseForGate(schema: Schema, gateId: string): string | undefined {
  for (const phase of schema.phases) {
    if (phase.gate === gateId) return phase.id;
  }
  return undefined;
}

function resolveChangePath(projectRoot: string, changeId: string, p: string): string {
  const resolved = p.replace(/<change-id>/g, changeId);
  if (resolved.startsWith('repo:')) return path.join(projectRoot, resolved.slice('repo:'.length));
  if (resolved.startsWith('qa/')) return path.join(projectRoot, resolved);
  return path.join(projectRoot, 'qa', 'changes', changeId, resolved);
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
