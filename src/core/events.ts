import * as fs from 'fs';
import * as path from 'path';
import type { GateReport, PhaseStatusKind, StatusReport } from '../orchestration/engine';
import type { DslValue } from '../orchestration/dsl';
import type { Schema } from '../orchestration/schema';

export type QaEventSource = 'status' | 'gate' | 'run';

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
  from: PhaseStatusKind | null;
  to: PhaseStatusKind;
  outputs: string[];
}

export interface GateVerdictEvent extends QaEventBase {
  source: 'gate';
  type: 'gate_verdict';
  phase: string | null;
  gate: string;
  verdict: string;
  blocks: number | null;
  evidence: Record<string, DslValue>;
}

export interface ExecutionStartEvent extends QaEventBase {
  source: 'run';
  type: 'execution_start';
  targets: Record<string, boolean>;
}

export interface ExecutionEndEvent extends QaEventBase {
  source: 'run';
  type: 'execution_end';
  duration_ms: number;
  per_target: Record<string, unknown>;
}

export type QaEvent =
  | PhaseTransitionEvent
  | GateVerdictEvent
  | ExecutionStartEvent
  | ExecutionEndEvent;

export type QaEventInput =
  | Omit<PhaseTransitionEvent, 'seq' | 'ts' | 'change_id'>
  | Omit<GateVerdictEvent, 'seq' | 'ts' | 'change_id'>
  | Omit<ExecutionStartEvent, 'seq' | 'ts' | 'change_id'>
  | Omit<ExecutionEndEvent, 'seq' | 'ts' | 'change_id'>;

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
  if (events.length === 0) return;

  try {
    const file = getEventsFile(projectRoot, changeId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let seq = nextSeq(projectRoot, changeId);
    const ts = new Date().toISOString();
    const lines = events.map((event) => JSON.stringify({
      seq: seq++,
      ts,
      change_id: changeId,
      ...event,
    }));
    fs.appendFileSync(file, `${lines.join('\n')}\n`, { encoding: 'utf-8', flag: 'a' });
  } catch (err) {
    console.error(`warning: failed to append events.jsonl: ${(err as Error).message}`);
  }
}

export function readPhaseSnapshot(projectRoot: string, changeId: string): Map<string, PhaseStatusKind> {
  const snapshot = new Map<string, PhaseStatusKind>();
  for (const event of readEvents(projectRoot, changeId)) {
    if (event.type === 'phase_transition') {
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
  const snapshot = readPhaseSnapshot(projectRoot, changeId);

  return report.phases.flatMap((phase) => {
    if (phase.status === 'pruned') return [];
    const from = snapshot.get(phase.id) ?? null;
    if (from === phase.status) return [];
    const outputs = existingOutputs(projectRoot, changeId, schema, phase.id);
    return [{
      source: 'status',
      type: 'phase_transition',
      phase: phase.id,
      from,
      to: phase.status,
      outputs,
    }];
  });
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
  };
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
