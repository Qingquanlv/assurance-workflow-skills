import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { appendEvents } from './events';
import { sha256File } from './hash';
import { isAuditedGateRead } from './audit_scope';
import { getWorkflowStateFile } from './workflow_state';
import { writeExecutionTestChangesOverrideToken } from './test_changes_override';
import type { Schema } from '../orchestration/schema';

export type OverrideAction = 'fix_and_proceed' | 'skip_branch' | 'accept_and_stop' | 'allow_test_changes';

const CODEGEN_HARD_GATE_SUFFIX = '-codegen-precondition-gate';

export function recordExecutionTestChangesOverride(
  projectRoot: string,
  changeId: string,
  reason: string,
  createdAt = new Date().toISOString(),
): { absPath: string; relPath: string; sha256: string; testsTreeSha256: string } {
  const token = writeExecutionTestChangesOverrideToken(projectRoot, changeId, reason, createdAt);
  appendEvents(projectRoot, changeId, [{
    source: 'gate',
    type: 'human_override',
    phase: 'execution',
    action: 'allow_test_changes',
    reason,
    review_sha256: token.testsTreeSha256,
    evidence_file: token.relPath,
    evidence_sha256: token.sha256,
  }]);
  return token;
}

export function applyGateOverride(
  projectRoot: string,
  changeId: string,
  phaseId: string,
  action: OverrideAction,
  reason: string,
  schema: Schema,
): void {
  if (phaseId === 'execution' || action === 'allow_test_changes') {
    throw new Error(
      'GATE-OVERRIDE-DENIED: execution test-change overrides must use recordExecutionTestChangesOverride',
    );
  }
  const phase = schema.phasesById.get(phaseId);
  if (!phase) throw new Error(`Unknown phase '${phaseId}'`);
  if (!phase.gate) throw new Error(`Phase '${phaseId}' has no gate and cannot be overridden`);
  if (phase.gate.endsWith(CODEGEN_HARD_GATE_SUFFIX)) {
    throw new Error(`GATE-OVERRIDE-DENIED: codegen hard gate '${phase.gate}' cannot be overridden`);
  }

  const gate = schema.gates[phase.gate];
  if (!gate) throw new Error(`Unknown gate '${phase.gate}'`);

  const reviewPath = gate.reads.find(r => isAuditedGateRead(r.path))?.path;
  if (!reviewPath) throw new Error(`Phase '${phaseId}' has no audited JSON to bind override`);

  const absReview = resolveChangePath(projectRoot, changeId, reviewPath);
  const reviewSha = sha256File(absReview);
  if (!reviewSha) throw new Error(`Audited file missing: ${reviewPath}`);

  const review = readJson(absReview);
  if (!review) throw new Error(`Audited file invalid: ${reviewPath}`);

  const humanReviewRequired = review.human_review_required === true;
  const riskLevel = typeof review.risk_level === 'string' ? review.risk_level : '';
  const decision = typeof review.decision === 'string' ? review.decision : '';
  const eligible =
    humanReviewRequired ||
    decision === 'needs_human_review' ||
    riskLevel === 'high' ||
    riskLevel === 'critical';

  if (!eligible) {
    throw new Error(
      `GATE-OVERRIDE-DENIED: override requires human_review_required or high/critical risk (phase ${phaseId})`,
    );
  }

  const phaseKey = phaseId.replace(/-/g, '_');
  const file = getWorkflowStateFile(projectRoot, changeId);
  const state = readWorkflowState(file);
  const phases = isRecord(state.phases) ? { ...(state.phases as Record<string, unknown>) } : {};
  const existing = isRecord(phases[phaseKey]) ? { ...(phases[phaseKey] as Record<string, unknown>) } : {};

  existing.human_override = {
    action,
    reason,
    at: new Date().toISOString(),
    review_sha256: reviewSha,
  };
  phases[phaseKey] = existing;
  state.phases = phases;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml.dump(state, { lineWidth: 120 }), 'utf-8');

  appendEvents(projectRoot, changeId, [{
    source: 'gate',
    type: 'human_override',
    phase: phaseId,
    action,
    reason,
    review_sha256: reviewSha,
  }]);
}

function readWorkflowState(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  const parsed = yaml.load(fs.readFileSync(file, 'utf-8'));
  return isRecord(parsed) ? parsed : {};
}

function readJson(file: string): Record<string, unknown> | null {
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
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
