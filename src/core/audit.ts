import * as fs from 'fs';
import * as path from 'path';
import { readEvents, GateVerdictEvent, QaEvent } from './events';
import { sha256File } from './hash';
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

const DOWNSTREAM_HEALING_ARTIFACTS = [
  'healing/api-apply-summary.json',
  'healing/e2e-apply-summary.json',
  'healing/fixer-safety-check.json',
];

// Statuses that are acceptable once healing downstream artifacts already exist
// (i.e. the loop has started and produced apply-summaries / a rerun).
const HEALING_OK_STATUSES = new Set(['applied', 'resolved', 'exhausted', 'failed']);

// Terminal healing statuses that are acceptable once the run has reached report
// or completion. `pending` (never started), `applied` and `proposal_created`
// (mid-loop) are NOT acceptable resting states: the healing decision must be
// recorded via `aws state heal` before report, never left dangling.
const HEALING_RESTING_OK = new Set(['not_needed', 'skipped', 'resolved', 'exhausted', 'failed']);

export function runStatusAudits(
  projectRoot: string,
  changeId: string,
  report: StatusReport,
  schema: Schema,
): AuditResult {
  const issues: AuditIssue[] = [];
  issues.push(...auditGateTampering(projectRoot, changeId, report, schema));
  issues.push(...auditHealingConsistency(projectRoot, changeId, report));
  issues.push(...auditVerdictTransitions(projectRoot, changeId, schema));
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

  for (const phase of report.phases) {
    if (phase.status !== 'done' && phase.status !== 'stopped') continue;
    if (!phase.gate) continue;

    const gate = schema.gates[phase.gate];
    if (!gate) continue;

    const verdictEvent = lastVerdictByGate.get(phase.gate);
    if (!verdictEvent?.reads_sha256) continue;

    for (const [relPath, recordedHash] of Object.entries(verdictEvent.reads_sha256)) {
      if (!relPath.startsWith('review/') || !relPath.endsWith('.json')) continue;
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

function auditHealingConsistency(
  projectRoot: string,
  changeId: string,
  report: StatusReport,
): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const changeDir = path.join(projectRoot, 'qa', 'changes', changeId);
  const hasArtifact = DOWNSTREAM_HEALING_ARTIFACTS.some(p => fs.existsSync(path.join(changeDir, p)));
  const hasRerunEvent = readEvents(projectRoot, changeId).some(
    e => e.type === 'phase_transition' && e.phase === 'healing-rerun',
  );
  const healingStatus = report.healing.status;

  // (1) Healing loop has produced downstream artifacts / a rerun, but the
  // CLI-authoritative status was never advanced past its starting point.
  if ((hasArtifact || hasRerunEvent) && !HEALING_OK_STATUSES.has(healingStatus)) {
    issues.push({
      code: 'HEAL-STATE-INCONSISTENT',
      phase: 'healing',
      message: `HEAL-STATE-INCONSISTENT: healing downstream artifacts exist but healing.status=${healingStatus}`,
    });
  }

  // (2) The run reached report / completion after a real inspect, but the
  // healing decision was never recorded. `pending` means "should heal but never
  // started"; leaving it at rest (report done or terminal completed) is illegal.
  // If healing is genuinely not required, the orchestrator MUST record it via
  // `aws state heal --to not_needed|skipped` — not leave it pending.
  const inspectDone = report.phases.some(p => p.id === 'inspect' && p.status === 'done');
  const reportDone = report.phases.some(p => p.id === 'report' && p.status === 'done');
  const completed = report.terminal?.kind === 'completed';
  if (inspectDone && (reportDone || completed) && !HEALING_RESTING_OK.has(healingStatus)) {
    issues.push({
      code: 'HEAL-STATE-INCONSISTENT',
      phase: 'healing',
      message:
        `HEAL-STATE-INCONSISTENT: inspect completed and the run reached report/terminal, but ` +
        `healing.status=${healingStatus}. The healing decision must be recorded via 'aws state heal' ` +
        `(not left pending): run the healing loop, or set 'not_needed'/'skipped' if healing is not required.`,
    });
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
      const issue = checkVerdictMigration(
        events,
        schema,
        gateId,
        prev,
        next,
        repairByReviewPhase,
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
): AuditIssue | null {
  const from = prev.verdict;
  const to = next.verdict;

  if (from === 'reject') {
    return {
      code: 'GATE-TRANSITION-ILLEGAL',
      message: `GATE-TRANSITION-ILLEGAL: ${gateId} reject→${to}`,
    };
  }

  const between = events.filter(e => e.seq > prev.seq && e.seq < next.seq);
  const reviewPhase = findReviewPhaseForGate(schema, gateId);
  const repairPhase = reviewPhase ? repairByReviewPhase.get(reviewPhase) : undefined;
  const repairDone = repairPhase
    ? between.some(e => e.type === 'phase_transition' && e.phase === repairPhase && e.to === 'done')
    : false;
  const overrideDone = between.some(e => e.type === 'human_override');

  if (from === 'needs_fix' && to === 'pass' && !repairDone) {
    return {
      code: 'GATE-TRANSITION-ILLEGAL',
      message: `GATE-TRANSITION-ILLEGAL: ${gateId} needs_fix→pass`,
    };
  }

  if (from === 'needs_human_review' && to === 'pass' && (!overrideDone || !repairDone)) {
    return {
      code: 'GATE-TRANSITION-ILLEGAL',
      message: `GATE-TRANSITION-ILLEGAL: ${gateId} needs_human_review→pass`,
    };
  }

  if (from === 'pass' && to === 'pass') {
    const prevHash = prev.reads_sha256 ?? {};
    const nextHash = next.reads_sha256 ?? {};
    const hashChanged = Object.keys(nextHash).some(k => prevHash[k] && nextHash[k] !== prevHash[k]);
    if (hashChanged && !repairDone) {
      return {
        code: 'GATE-TRANSITION-ILLEGAL',
        message: `GATE-TRANSITION-ILLEGAL: ${gateId} pass→pass (content changed)`,
      };
    }
  }

  return null;
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
