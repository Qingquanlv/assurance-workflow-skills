import * as fs from 'fs';
import * as path from 'path';
import { appendEventsStrict, HumanDecisionAction, HumanDecisionEvent } from './events';
import { sha256File } from '../../utils/hash';
import { isAuditedGateRead } from './audit_scope';
import { resolveDecisionSupport } from './decision_support';
import { computeStatus, StatusReport } from '../orchestration/engine';
import { findSchemaFile, loadSchemaFromFile, Schema } from '../orchestration/schema';
import {
  assertTestChangesOverridePolicyAllows,
  loadTestChangesOverridePolicy,
  writeExecutionTestChangesOverrideToken,
} from './test_changes_override';
import { assertTestTreeUnchangedOrHealing } from './healing_state';

export interface RecordHumanDecisionOptions {
  projectRoot: string;
  changeId: string;
  checkpoint: string;
  action: HumanDecisionAction;
  reason: string;
  evidence?: string;
  who?: string;
}

export function recordHumanDecision(options: RecordHumanDecisionOptions): void {
  const projectRoot = path.resolve(options.projectRoot);
  const changeDir = resolveContainedChangeDir(projectRoot, options.changeId);
  if (!changeDir) {
    throw new Error(`change id must resolve within qa/changes: '${options.changeId}'`);
  }
  if (!fs.existsSync(changeDir) || !fs.statSync(changeDir).isDirectory()) {
    throw new Error(`change '${options.changeId}' not found (expected: ${changeDir})`);
  }
  if (!options.reason.trim()) {
    throw new Error('decision reason is required');
  }

  const schema = loadSchemaFromFile(findSchemaFile(projectRoot));
  const support = resolveDecisionSupport(schema, options.checkpoint, options.action);

  let evidence = options.evidence
    ? bindProjectEvidence(projectRoot, options.evidence)
    : undefined;
  let tokenRollback: (() => void) | undefined;
  if (support.consumer === 'execution-test-changes') {
    const policy = loadTestChangesOverridePolicy(projectRoot);
    const integrity = assertTestTreeUnchangedOrHealing(
      projectRoot,
      options.changeId,
      true,
    );
    assertTestChangesOverridePolicyAllows(
      projectRoot,
      options.changeId,
      integrity,
      policy,
    );
    const tokenPath = path.join(changeDir, 'execution', 'test-changes-override-token.json');
    const decisionPath = path.join(changeDir, 'execution', 'test-changes-decision.json');
    const previousToken = fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath) : null;
    const previousDecision = fs.existsSync(decisionPath) ? fs.readFileSync(decisionPath) : null;
    tokenRollback = () => {
      if (previousToken === null) {
        fs.rmSync(tokenPath, { force: true });
      } else {
        fs.writeFileSync(tokenPath, previousToken);
      }
      if (previousDecision === null) {
        fs.rmSync(decisionPath, { force: true });
      } else {
        fs.writeFileSync(decisionPath, previousDecision);
      }
    };
    try {
      const token = writeExecutionTestChangesOverrideToken(
        projectRoot,
        options.changeId,
        options.reason,
      );
      fs.writeFileSync(decisionPath, fs.readFileSync(token.absPath));
      evidence = {
        file: 'execution/test-changes-decision.json',
        sha256: sha256File(decisionPath) ?? '',
      };
      if (!evidence.sha256) throw new Error('test-change decision evidence is not readable');
    } catch (err) {
      tokenRollback();
      throw err;
    }
  }
  const review = options.checkpoint === 'healing.safety' && options.action === 'accept_risk'
    ? requireChangeArtifact(projectRoot, options.changeId, 'healing/fixer-safety-check.json')
    : support.gateId
      ? bindCurrentAuditedRead(projectRoot, options.changeId, schema, support.gateId)
      : undefined;
  if (
    support.gateId
    && options.action !== 'stop'
    && schema.gates[support.gateId]?.reads.some(read => isAuditedGateRead(read.path))
    && !review
  ) {
    const audited = schema.gates[support.gateId].reads
      .find(read => isAuditedGateRead(read.path))?.path ?? 'audited gate artifact';
    throw new Error(`Audited artifact ${audited} is required for this decision`);
  }
  const who = options.who?.trim() || process.env.USER?.trim() || 'unknown';

  let status: StatusReport | undefined;
  if (options.action === 'stop') {
    status = computeStatus({ schema, projectRoot, changeId: options.changeId });
    if (status.terminal) {
      throw new Error(`Cannot stop workflow: already terminal ${status.terminal.kind}`);
    }
  }

  const event: Omit<HumanDecisionEvent, 'seq' | 'ts' | 'change_id'> = {
    source: 'decide',
    type: 'human_decision',
    checkpoint: options.checkpoint,
    action: options.action,
    reason: options.reason,
    who,
    ...(evidence ? {
      evidence_file: evidence.file,
      evidence_sha256: evidence.sha256,
    } : {}),
    ...(review ? {
      review_file: review.file,
      review_sha256: review.sha256,
    } : {}),
    ...(status ? {
      state_at_stop: {
        next: status.next,
        healing_status: status.healing.status,
        phases: Object.fromEntries(status.phases.map(phase => [phase.id, phase.status])),
      },
    } : {}),
  };

  try {
    appendEventsStrict(projectRoot, options.changeId, [event]);
  } catch (err) {
    tokenRollback?.();
    throw err;
  }
}

function bindProjectEvidence(
  projectRoot: string,
  evidencePath: string,
): { file: string; sha256: string } {
  const absolute = path.resolve(projectRoot, evidencePath);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error(`Evidence file not found: ${evidencePath}`);
  }
  const realRoot = fs.realpathSync(projectRoot);
  const realEvidence = fs.realpathSync(absolute);
  const relative = path.relative(realRoot, realEvidence);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Evidence file must be within project root');
  }
  const sha256 = sha256File(realEvidence);
  if (!sha256) throw new Error(`Evidence file is not readable: ${evidencePath}`);
  return { file: toPosix(relative), sha256 };
}

function bindCurrentAuditedRead(
  projectRoot: string,
  changeId: string,
  schema: Schema,
  gateId: string,
): { file: string; sha256: string } | undefined {
  const gate = schema.gates[gateId];
  if (!gate) return undefined;
  for (const read of gate.reads) {
    if (!isAuditedGateRead(read.path)) continue;
    const absolute = resolveChangePath(projectRoot, changeId, read.path);
    const sha256 = sha256File(absolute);
    if (sha256) return { file: read.path, sha256 };
  }
  return undefined;
}

function bindChangeArtifact(
  projectRoot: string,
  changeId: string,
  relative: string,
): { file: string; sha256: string } | undefined {
  const absolute = resolveChangePath(projectRoot, changeId, relative);
  const sha256 = sha256File(absolute);
  return sha256 ? { file: relative, sha256 } : undefined;
}

function requireChangeArtifact(
  projectRoot: string,
  changeId: string,
  relative: string,
): { file: string; sha256: string } {
  const bound = bindChangeArtifact(projectRoot, changeId, relative);
  if (!bound) {
    throw new Error(`${relative} is required for this decision`);
  }
  return bound;
}

function resolveContainedChangeDir(projectRoot: string, changeId: string): string | null {
  const changesRoot = path.resolve(projectRoot, 'qa', 'changes');
  const candidate = path.resolve(changesRoot, changeId);
  if (!isWithin(changesRoot, candidate)) return null;
  if (!fs.existsSync(candidate)) return candidate;
  const realRoot = fs.realpathSync(changesRoot);
  const realCandidate = fs.realpathSync(candidate);
  return isWithin(realRoot, realCandidate) ? realCandidate : null;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function resolveChangePath(projectRoot: string, changeId: string, value: string): string {
  const resolved = value.replace(/<change-id>/g, changeId);
  if (resolved.startsWith('repo:')) return path.join(projectRoot, resolved.slice('repo:'.length));
  if (resolved.startsWith('qa/')) return path.join(projectRoot, resolved);
  return path.join(projectRoot, 'qa', 'changes', changeId, resolved);
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

