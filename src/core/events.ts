import * as fs from 'fs';
import * as path from 'path';
import { sha256File } from './hash';
import { isAuditedGateRead } from './audit_scope';
import type { GateReport, PhaseStatusKind, StatusReport } from '../orchestration/engine';
import type { DslValue } from '../orchestration/dsl';
import type { Schema } from '../orchestration/schema';

export type QaEventSource = 'status' | 'gate' | 'run' | 'report' | 'heal' | 'driver' | 'decide' | 'progression';
export type PhaseTransitionStatus = PhaseStatusKind | string;
export type HumanDecisionAction =
  | 'fix_and_proceed'
  | 'accept_risk'
  | 'stop'
  | 'allow_test_changes'
  | 'skip_branch';

const HUMAN_DECISION_ACTIONS = new Set<HumanDecisionAction>([
  'fix_and_proceed',
  'accept_risk',
  'stop',
  'allow_test_changes',
  'skip_branch',
]);

export function isHumanDecisionAction(value: string): value is HumanDecisionAction {
  return HUMAN_DECISION_ACTIONS.has(value as HumanDecisionAction);
}

export interface QaEventBase {
  seq: number;
  ts: string;
  source: QaEventSource;
  type: string;
  change_id: string;
}

export interface PhaseTransitionEvent extends QaEventBase {
  source: 'status';
  type: 'phase_transition';
  phase: string;
  from: PhaseTransitionStatus | null;
  to: PhaseTransitionStatus;
  outputs: string[];
  /**
   * Approximate wall-clock ms since this phase last became `ready`, measured
   * when the transition was observed (aws status / state apply call time).
   * Includes orchestration and observation lag — not a precise execution
   * duration (execution_end.duration_ms is the precise one for test runs).
   * Absent when the phase has no prior `ready` transition on record.
   */
  duration_ms?: number;
}

export interface GateVerdictEvent extends QaEventBase {
  source: 'gate';
  type: 'gate_verdict';
  phase: string | null;
  gate: string;
  verdict: string;
  blocks: number | null;
  evidence: Record<string, DslValue>;
  reads_sha256?: Record<string, string>;
}

/** Durable idempotency marker for one accepted Phase outcome. */
export interface PhaseOutcomeCommittedEvent extends QaEventBase {
  source: 'progression';
  type: 'phase_outcome_committed';
  phase: string;
  attempt_id: string;
  gate_report: GateReport | null;
}

export interface HealTransitionEvent extends QaEventBase {
  source: 'status';
  type: 'heal_transition';
  from: string;
  to: string;
  source_batch_id?: string;
  proposal_sha256?: string;
  attempt_key?: string;
}

export interface HealRecordApplyEvent extends QaEventBase {
  source: 'heal';
  type: 'heal_record_apply';
  target: 'api' | 'e2e';
  applied_proposals: string[];
  skipped_proposals: string[];
  files_modified: string[];
  summary_file: string;
  summary_sha256: string | null;
  markdown_file: string;
  markdown_sha256: string | null;
  proposal_sha256: string;
  source_batch_id: string;
  attempt_key: string;
}

export interface HealingEntryBaselinePinnedEvent extends QaEventBase {
  source: 'heal';
  type: 'healing_entry_baseline_pinned';
  artifact_file: 'healing/entry-baseline.json';
  artifact_sha256: string;
  entry_batch_id: string;
  episode_id: string;
}

export interface HumanDecisionEvent extends QaEventBase {
  source: 'decide';
  type: 'human_decision';
  checkpoint: string;
  action: HumanDecisionAction;
  reason: string;
  who: string;
  evidence_file?: string;
  evidence_sha256?: string;
  review_file?: string;
  review_sha256?: string;
  state_at_stop?: {
    next: string[];
    healing_status: string;
    phases: Record<string, PhaseStatusKind>;
  };
}

export interface ExecutionStartEvent extends QaEventBase {
  source: 'run';
  type: 'execution_start';
  targets: Record<string, boolean>;
  rerun_reason?: string;
  tests_changed?: boolean;
}

export interface ProductTreeChangedEvent extends QaEventBase {
  source: 'run';
  type: 'product_tree_changed';
  prev_sha256: string;
  new_sha256: string;
  baseline_batch_id?: string;
}

export interface FailureReclassifiedEvent extends QaEventBase {
  source: 'report';
  type: 'failure_reclassified';
  failure: string;
  from: string;
  to: string;
  evidence: string;
}

export interface ExecutionEndEvent extends QaEventBase {
  source: 'run';
  type: 'execution_end';
  duration_ms: number;
  per_target: Record<string, unknown>;
}

export type DriverEventType =
  | 'driver_started'
  | 'phase_dispatched'
  | 'phase_attempt_finished'
  | 'driver_paused'
  | 'driver_resumed'
  | 'driver_finished';

export interface DriverLifecycleEvent extends QaEventBase {
  source: 'driver';
  type: DriverEventType;
  run_id: string;
  phase?: string;
  attempt_id?: string;
  detail?: string;
  exit_code?: number;
}

export type QaEvent =
  | PhaseTransitionEvent
  | GateVerdictEvent
  | PhaseOutcomeCommittedEvent
  | HealTransitionEvent
  | HealRecordApplyEvent
  | HealingEntryBaselinePinnedEvent
  | HumanDecisionEvent
  | ExecutionStartEvent
  | ProductTreeChangedEvent
  | FailureReclassifiedEvent
  | ExecutionEndEvent
  | DriverLifecycleEvent;

export type QaEventInput =
  | Omit<PhaseTransitionEvent, 'seq' | 'ts' | 'change_id'>
  | Omit<GateVerdictEvent, 'seq' | 'ts' | 'change_id'>
  | Omit<PhaseOutcomeCommittedEvent, 'seq' | 'ts' | 'change_id'>
  | Omit<HealTransitionEvent, 'seq' | 'ts' | 'change_id'>
  | Omit<HealRecordApplyEvent, 'seq' | 'ts' | 'change_id'>
  | Omit<HealingEntryBaselinePinnedEvent, 'seq' | 'ts' | 'change_id'>
  | Omit<HumanDecisionEvent, 'seq' | 'ts' | 'change_id'>
  | Omit<ExecutionStartEvent, 'seq' | 'ts' | 'change_id'>
  | Omit<ProductTreeChangedEvent, 'seq' | 'ts' | 'change_id'>
  | Omit<FailureReclassifiedEvent, 'seq' | 'ts' | 'change_id'>
  | Omit<ExecutionEndEvent, 'seq' | 'ts' | 'change_id'>
  | Omit<DriverLifecycleEvent, 'seq' | 'ts' | 'change_id'>;

export function buildDriverEvent(
  type: DriverEventType,
  runId: string,
  extra: { phase?: string; attempt_id?: string; detail?: string; exit_code?: number } = {},
): Omit<DriverLifecycleEvent, 'seq' | 'ts' | 'change_id'> {
  return {
    source: 'driver',
    type,
    run_id: runId,
    ...extra,
  };
}

export function getEventsFile(projectRoot: string, changeId: string): string {
  return path.join(projectRoot, 'qa', 'changes', changeId, 'events.jsonl');
}

export function readEvents(projectRoot: string, changeId: string): QaEvent[] {
  const file = getEventsFile(projectRoot, changeId);
  if (!fs.existsSync(file)) return [];

  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as QaEvent];
      } catch {
        return [];
      }
    });
}

export function nextSeq(projectRoot: string, changeId: string): number {
  const max = readEvents(projectRoot, changeId).reduce((acc, event) => {
    return typeof event.seq === 'number' && Number.isFinite(event.seq)
      ? Math.max(acc, event.seq)
      : acc;
  }, 0);
  return max + 1;
}

export function appendEvents(projectRoot: string, changeId: string, events: QaEventInput[]): void {
  try {
    appendEventsImpl(projectRoot, changeId, events);
  } catch (err) {
    if (err instanceof MissingEventsDirectoryError) {
      console.error(`warning: events.jsonl skipped: ${err.message}`);
    } else {
      console.error(`warning: failed to append events.jsonl: ${(err as Error).message}`);
    }
  }
}

export function appendEventsStrict(
  projectRoot: string,
  changeId: string,
  events: QaEventInput[],
): void {
  appendEventsImpl(projectRoot, changeId, events);
}

function appendEventsImpl(projectRoot: string, changeId: string, events: QaEventInput[]): void {
  if (events.length === 0) return;

  const file = getEventsFile(projectRoot, changeId);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) {
    throw new MissingEventsDirectoryError(`change directory does not exist: ${dir}`);
  }
  let seq = nextSeq(projectRoot, changeId);
  const ts = new Date().toISOString();
  const lines = events.map((event) => JSON.stringify({
    seq: seq++,
    ts,
    change_id: changeId,
    ...event,
  }));
  fs.appendFileSync(file, `${lines.join('\n')}\n`, { encoding: 'utf-8', flag: 'a' });
}

class MissingEventsDirectoryError extends Error {}

export function readPhaseSnapshot(projectRoot: string, changeId: string): Map<string, PhaseStatusKind> {
  const snapshot = new Map<string, PhaseStatusKind>();
  for (const event of readEvents(projectRoot, changeId)) {
    if (event.type === 'phase_transition' && isPhaseStatusKind(event.to)) {
      snapshot.set(event.phase, event.to);
    }
  }
  return snapshot;
}

export function buildStatusTransitionEvents(
  projectRoot: string,
  changeId: string,
  report: StatusReport,
  schema: Schema
): QaEventInput[] {
  const snapshot = new Map<string, PhaseStatusKind>();
  const readyAt = new Map<string, string>();
  for (const event of readEvents(projectRoot, changeId)) {
    if (event.type !== 'phase_transition') continue;
    if (isPhaseStatusKind(event.to)) snapshot.set(event.phase, event.to);
    if (event.to === 'ready') readyAt.set(event.phase, event.ts);
  }

  return report.phases.flatMap((phase) => {
    if (phase.status === 'pruned') return [];
    const from = snapshot.get(phase.id) ?? null;
    if (from === phase.status) return [];
    const outputs = existingOutputs(projectRoot, changeId, schema, phase.id);
    const duration = phase.status === 'ready' || phase.status === 'blocked'
      ? null
      : approxDurationSince(readyAt.get(phase.id));
    return [{
      source: 'status',
      type: 'phase_transition',
      phase: phase.id,
      from,
      to: phase.status,
      outputs,
      ...(duration !== null ? { duration_ms: duration } : {}),
    }];
  });
}

/** Best-effort elapsed ms since `ts`; null when ts is absent, unparseable, or in the future. */
export function approxDurationSince(ts: string | undefined | null): number | null {
  if (!ts) return null;
  const started = Date.parse(ts);
  if (Number.isNaN(started)) return null;
  const elapsed = Date.now() - started;
  return elapsed >= 0 ? elapsed : null;
}

export function buildGateVerdictEvent(
  projectRoot: string,
  changeId: string,
  report: GateReport,
  schema: Schema
): QaEventInput {
  return {
    source: 'gate',
    type: 'gate_verdict',
    phase: report.phase,
    gate: report.gate,
    verdict: report.verdict,
    blocks: countGateBlocks(projectRoot, changeId, report.gate, schema),
    evidence: report.evidence,
    reads_sha256: computeReadsSha256(projectRoot, changeId, report.gate, schema),
  };
}

function computeReadsSha256(
  projectRoot: string,
  changeId: string,
  gateId: string,
  schema: Schema,
): Record<string, string> | undefined {
  const gate = schema.gates[gateId];
  if (!gate) return undefined;

  const hashes: Record<string, string> = {};
  for (const read of gate.reads) {
    if (!isAuditedGateRead(read.path)) continue;
    const abs = resolveChangePath(projectRoot, changeId, read.path);
    const hash = sha256File(abs);
    if (hash) hashes[read.path] = hash;
  }
  return Object.keys(hashes).length > 0 ? hashes : undefined;
}

function existingOutputs(projectRoot: string, changeId: string, schema: Schema, phaseId: string): string[] {
  const phase = schema.phasesById.get(phaseId);
  if (!phase) return [];
  return phase.produces.filter((producePath) => fs.existsSync(resolveChangePath(projectRoot, changeId, producePath)));
}

function countGateBlocks(projectRoot: string, changeId: string, gateId: string, schema: Schema): number | null {
  const gate = schema.gates[gateId];
  if (!gate) return null;

  let total = 0;
  let readable = false;
  for (const read of gate.reads) {
    const abs = resolveChangePath(projectRoot, changeId, read.path);
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(abs, 'utf-8')) as unknown;
      const findings = isRecord(parsed) && Array.isArray(parsed.findings) ? parsed.findings : [];
      total += findings.filter((finding) => {
        return isRecord(finding) && finding.severity === 'BLOCK';
      }).length;
      readable = true;
    } catch {
      // Ignore malformed gate files; the gate verdict itself remains authoritative.
    }
  }
  return readable ? total : null;
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

function isPhaseStatusKind(value: string): value is PhaseStatusKind {
  return ['pruned', 'out_of_scope', 'blocked', 'ready', 'awaiting_gate', 'done', 'stopped', 'tampered'].includes(value);
}
