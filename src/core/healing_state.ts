import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import {
  appendEventsStrict,
  HealingEntryBaselinePinnedEvent,
  HealRecordApplyEvent,
  HealTransitionEvent,
  readEvents,
} from './events';
import { hashProductTree, hashTestTree, sha256File, TestTreeHash } from './hash';
import { getWorkflowStateFile } from './workflow_state';
import type { ExecutionManifest } from './types';
import { loadExecutionEvidence } from '../execution/evidence';

export type HealingStatus =
  | 'pending'
  | 'proposal_created'
  | 'applied'
  | 'resolved'
  | 'exhausted'
  | 'not_needed'
  | 'failed'
  | 'skipped';

const HEALING_JUDGMENTS = new Set<HealingStatus>([
  'resolved',
  'not_needed',
  'skipped',
  'exhausted',
  'failed',
]);

export const DEFAULT_MAX_HEALING_ATTEMPTS = 3;

const APPLY_SUMMARIES = [
  'healing/api-apply-summary.json',
  'healing/e2e-apply-summary.json',
];

const APPLY_SUMMARY_TARGETS = ['api', 'e2e'] as const;
type ApplySummaryTarget = typeof APPLY_SUMMARY_TARGETS[number];

export interface HealTransitionResult {
  from: HealingStatus;
  to: HealingStatus;
}

export interface RecordApplySummaryResult {
  target: ApplySummaryTarget;
  summaryPath: string;
  markdownPath: string;
  modifiedFiles: string[];
  appliedProposalIds: string[];
  skippedProposalIds: string[];
}

export interface TestTreeIntegrityResult {
  testsChanged: boolean;
  current: TestTreeHash;
  previousBatchId?: string;
  changedFiles: ChangedTestFile[];
}

export interface ProductTreeIntegrityResult {
  productChanged: boolean;
  current: TestTreeHash;
  previousBatchId?: string;
  previousSha256?: string;
}

export interface ChangedTestFile {
  path: string;
  old_sha256: string | null;
  new_sha256: string | null;
  change_type: 'modified' | 'added' | 'deleted';
}

export interface HealingEntryBaseline {
  schema_version: '1.0';
  source: 'cli';
  change_id: string;
  batch_id: string | null;
  episode_id: string;
  pinned_at: string;
  tests_tree_sha256: string;
  test_files_sha256: Record<string, string>;
}

export interface HealingAppliedTestTree {
  schema_version: '1.0';
  source: 'cli';
  change_id: string;
  pinned_at: string;
  tests_tree_sha256: string;
  attempt_key: string | null;
}

export interface DerivedHealingState {
  status: HealingStatus;
  attempts_used: number;
  all_fixers_no_op: boolean;
  active_batch_id: string | null;
  source_batch_id: string | null;
  proposal_sha256: string | null;
  attempt_key: string | null;
}

export function deriveHealingState(projectRoot: string, changeId: string): DerivedHealingState {
  const changeDir = path.join(projectRoot, 'qa', 'changes', changeId);
  const manifest = readLatestExecutionManifest(projectRoot, changeId);
  const activeBatchId = typeof manifest?.batch_id === 'string' ? manifest.batch_id : null;
  const analysisPath = path.join(changeDir, 'inspect/failure-analysis.json');
  const analysis = readJson(changeDir, 'inspect/failure-analysis.json');
  const analysisSha = sha256File(analysisPath);
  const sourceBatchId = typeof analysis?.source_batch_id === 'string' ? analysis.source_batch_id : null;
  const inspectFresh = activeBatchId !== null && sourceBatchId === activeBatchId;
  const proposalPath = path.join(changeDir, 'healing/fix-proposal.json');
  const proposal = readJson(changeDir, 'healing/fix-proposal.json');
  const proposalSha = sha256File(proposalPath);
  const proposalSourceBatchId = typeof proposal?.source_batch_id === 'string'
    ? proposal.source_batch_id
    : null;
  const proposalAnalysisSha = typeof proposal?.source_analysis_sha256 === 'string'
    ? proposal.source_analysis_sha256
    : null;
  const targets = eligibleProposalTargets(proposal);
  const proposalValid = Boolean(
    inspectFresh
    && proposalSourceBatchId === activeBatchId
    && analysisSha !== null
    && proposalAnalysisSha === analysisSha
    && proposal
    && isRecord(proposal.summary)
    && Array.isArray(proposal.proposals)
    && proposalSha
    && targets.length > 0,
  );
  const attemptKey = proposalValid ? `${proposalSha}:${sourceBatchId}` : null;
  const events = readEvents(projectRoot, changeId);
  const attemptKeys = new Set<string>();
  for (const event of events) {
    if (event.type !== 'heal_record_apply') continue;
    const candidate = event as typeof event & {
      attempt_key?: unknown;
      proposal_sha256?: unknown;
      source_batch_id?: unknown;
    };
    if (typeof candidate.attempt_key === 'string' && candidate.attempt_key) {
      attemptKeys.add(candidate.attempt_key);
    } else if (
      typeof candidate.proposal_sha256 === 'string'
      && typeof candidate.source_batch_id === 'string'
    ) {
      attemptKeys.add(`${candidate.proposal_sha256}:${candidate.source_batch_id}`);
    }
  }

  const activeApplyEvents = attemptKey
    ? events.filter(event => {
      if (event.type !== 'heal_record_apply') return false;
      const candidate = event as typeof event & {
        attempt_key?: unknown;
        proposal_sha256?: unknown;
        source_batch_id?: unknown;
      };
      return candidate.attempt_key === attemptKey || (
        candidate.proposal_sha256 === proposalSha
        && candidate.source_batch_id === sourceBatchId
      );
    })
    : [];
  let allSummariesValid = proposalValid;
  let allFixersNoOp = proposalValid;
  if (proposalValid && attemptKey) {
    for (const target of targets) {
      const summaryPath = path.join(changeDir, applySummaryRel(target));
      const summary = readJson(changeDir, applySummaryRel(target));
      const latestTargetEvent = [...events].reverse().find((event): event is HealRecordApplyEvent =>
        event.type === 'heal_record_apply' && event.target === target,
      );
      try {
        if (!summary || !latestTargetEvent) throw new Error('missing summary evidence');
        validateApplySummary(projectRoot, changeId, target, summary, proposal);
        const event = latestTargetEvent as typeof latestTargetEvent & {
          attempt_key?: unknown;
          proposal_sha256?: unknown;
          source_batch_id?: unknown;
        };
        const currentIdentity = event.attempt_key === attemptKey || (
          event.proposal_sha256 === proposalSha
          && event.source_batch_id === sourceBatchId
        );
        if (!currentIdentity || event.summary_sha256 !== sha256File(summaryPath)) {
          throw new Error('stale summary evidence');
        }
        if (summary.no_op !== true) allFixersNoOp = false;
      } catch {
        allSummariesValid = false;
        allFixersNoOp = false;
        break;
      }
    }
  }
  allFixersNoOp = Boolean(allSummariesValid && allFixersNoOp);

  const latestActiveSeq = activeApplyEvents.reduce((latest, event) => Math.max(latest, event.seq), 0);
  const latestJudgment = [...events].reverse().find((event): event is HealTransitionEvent => {
    if (
      event.type !== 'heal_transition'
      || !['resolved', 'not_needed', 'skipped', 'exhausted', 'failed'].includes(event.to)
    ) return false;
    const judgment = event as HealTransitionEvent & {
      attempt_key?: string;
      proposal_sha256?: string;
      source_batch_id?: string;
    };
    if (!activeBatchId || judgment.source_batch_id !== activeBatchId) return false;
    if (proposalValid && attemptKey) {
      if (event.to === 'not_needed' || event.to === 'skipped') return false;
      if (
        judgment.attempt_key !== attemptKey
        || judgment.proposal_sha256 !== proposalSha
        || event.seq <= latestActiveSeq
      ) return false;
    }
    return true;
  });
  if (latestJudgment) {
    return {
      status: latestJudgment.to as HealingStatus,
      attempts_used: attemptKeys.size,
      all_fixers_no_op: allFixersNoOp,
      active_batch_id: activeBatchId,
      source_batch_id: sourceBatchId,
      proposal_sha256: proposalValid ? proposalSha : null,
      attempt_key: attemptKey,
    };
  }

  if (proposalValid && allSummariesValid) {
    const safetyPath = path.join(changeDir, 'healing/fixer-safety-check.json');
    const safety = readJson(changeDir, 'healing/fixer-safety-check.json');
    const safetySha = sha256File(safetyPath);
    const acceptedRisk = [...events].reverse().find(event =>
      event.type === 'human_decision' && event.checkpoint === 'healing.safety',
    );
    const episode = readCurrentHealingEpisode(projectRoot, changeId);
    const baselineArtifactSha = sha256File(
      path.join(changeDir, 'healing/entry-baseline.json'),
    );
    const currentTestsTreeSha = hashTestTree(projectRoot).aggregate;
    const safetyMatchesActiveAttempt = Boolean(
      safety
      && safety.attempt_key === attemptKey
      && safety.proposal_sha256 === proposalSha
      && safety.source_batch_id === sourceBatchId
      && episode
      && baselineArtifactSha === episode.artifact_sha256
      && safety.baseline_batch_id === episode.entry_batch_id
      && safety.healing_episode_id === episode.episode_id
      && safety.entry_baseline_sha256 === episode.artifact_sha256
      && safety.checked_tests_tree_sha256 === currentTestsTreeSha,
    );
    const riskAcceptedForCurrentSafety = Boolean(
      safetyMatchesActiveAttempt
      && acceptedRisk
      && acceptedRisk.type === 'human_decision'
      && acceptedRisk.action === 'accept_risk'
      && acceptedRisk.review_file === 'healing/fixer-safety-check.json'
      && acceptedRisk.review_sha256 === safetySha,
    );
    if (
      safetyMatchesActiveAttempt
      && ((safety?.passed === true && safety.needs_review !== true) || riskAcceptedForCurrentSafety)
    ) {
      return {
        status: 'applied',
        attempts_used: attemptKeys.size,
        all_fixers_no_op: allFixersNoOp,
        active_batch_id: activeBatchId,
        source_batch_id: sourceBatchId,
        proposal_sha256: proposalSha,
        attempt_key: attemptKey,
      };
    }
  }

  const status: HealingStatus = proposalValid
    ? 'proposal_created'
    : inspectFresh && !hasEligibleFailures(analysis)
      ? 'not_needed'
      : 'pending';
  return {
    status,
    attempts_used: attemptKeys.size,
    all_fixers_no_op: allFixersNoOp,
    active_batch_id: activeBatchId,
    source_batch_id: sourceBatchId,
    proposal_sha256: proposalValid ? proposalSha : null,
    attempt_key: attemptKey,
  };
}

export function readHealingStatus(projectRoot: string, changeId: string): HealingStatus {
  return deriveHealingState(projectRoot, changeId).status;
}

/**
 * Number of healing attempts derived from `heal_record_apply` events (batch-bound
 * attempt keys). The driver's healing subroutine seeds its loop counter from this
 * so a resumed run (re-entering healing after a mid-loop crash) counts prior
 * attempts against max_healing_attempts instead of starting from zero.
 */
export function readHealingAttemptsUsed(projectRoot: string, changeId: string): number {
  return deriveHealingState(projectRoot, changeId).attempts_used;
}

export function recordApplySummary(
  projectRoot: string,
  changeId: string,
  target: ApplySummaryTarget,
  proposalIds: string[],
): RecordApplySummaryResult {
  const changeDir = path.join(projectRoot, 'qa', 'changes', changeId);
  const proposal = readJson(changeDir, 'healing/fix-proposal.json');
  if (!proposal) throw new Error('healing/fix-proposal.json missing or invalid');
  const manifest = readLatestExecutionManifest(projectRoot, changeId);
  if (!manifest?.test_files_sha256) {
    throw new Error('record-apply requires execution-manifest.yaml with test_files_sha256');
  }
  const activeBatchId = typeof manifest.batch_id === 'string' ? manifest.batch_id : null;
  const analysis = readJson(changeDir, 'inspect/failure-analysis.json');
  const analysisSha = sha256File(path.join(changeDir, 'inspect/failure-analysis.json'));
  const analysisBatchId = typeof analysis?.source_batch_id === 'string'
    ? analysis.source_batch_id
    : null;
  if (
    !activeBatchId
    || analysisBatchId !== activeBatchId
    || proposal.source_batch_id !== activeBatchId
    || !analysisSha
    || proposal.source_analysis_sha256 !== analysisSha
  ) {
    throw new Error(
      'record-apply proposal source_batch_id and source_analysis_sha256 must match the current analysis and active execution batch',
    );
  }

  const selected = new Set(proposalIds.map(id => id.trim()).filter(Boolean));
  if (selected.size === 0) throw new Error('record-apply requires at least one --proposal id');

  const eligibleIds = eligibleProposalIds(proposal, target);
  for (const id of selected) {
    if (!eligibleIds.includes(id)) {
      throw new Error(`record-apply proposal ${id} is not an eligible ${target} proposal`);
    }
  }

  const selectedFiles = collectEligibleProposalFilesByIds(proposal, target, selected);
  const changed = diffTestFiles(manifest.test_files_sha256, hashTestTree(projectRoot).files);
  const changedPaths = changed.map(file => file.path);
  const modifiedFiles = changedPaths.filter(file => selectedFiles.has(file));
  const ownedRoots = target === 'api'
    ? ['tests/api/', 'tests/testdata/domain/']
    : ['tests/e2e/', 'tests/testdata/domain/'];
  const unauthorized = changedPaths.filter(file => (
    ownedRoots.some(root => file.startsWith(root)) && !selectedFiles.has(file)
  ));
  if (unauthorized.length > 0) {
    throw new Error(`record-apply found changed ${target} test files not authorized by selected proposals: ${unauthorized.join(', ')}`);
  }

  const appliedProposalIds = [...selected];
  const skippedProposalIds = eligibleIds.filter(id => !selected.has(id));
  const noOp = modifiedFiles.length === 0;
  const now = new Date().toISOString();
  const summary = {
    schema_version: '1.0',
    change_id: changeId,
    target,
    applied: !noOp,
    no_op: noOp,
    applied_proposals: appliedProposalIds.map(id => ({
      proposal_id: id,
      files_modified: modifiedFiles,
      operations_applied: proposalOperations(proposal, id),
      notes: 'Recorded by aws heal record-apply from current test tree diff.',
    })),
    files_modified: modifiedFiles,
    skipped_proposals: skippedProposalIds.map(id => ({
      proposal_id: id,
      reason: 'not selected in aws heal record-apply --proposal',
    })),
    forbidden_attempts: [],
    rerun_required: !noOp,
    next_action: noOp ? 'none' : 'run_aws_run',
    created_at: now,
    source: 'cli-record-apply',
  };

  fs.mkdirSync(path.join(changeDir, 'healing'), { recursive: true });
  const summaryPath = path.join(changeDir, applySummaryRel(target));
  const markdownPath = path.join(changeDir, `healing/${target}-apply-summary.md`);
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');
  fs.writeFileSync(markdownPath, buildApplySummaryMarkdown(changeId, target, now, summary), 'utf-8');

  validateApplySummary(projectRoot, changeId, target, summary, proposal);
  const proposalSha256 = sha256File(path.join(changeDir, 'healing/fix-proposal.json'));
  const sourceBatchId = typeof manifest.batch_id === 'string' ? manifest.batch_id : null;
  if (!proposalSha256 || !sourceBatchId) {
    throw new Error('record-apply requires a hashable fix-proposal and execution batch_id');
  }
  appendEventsStrict(projectRoot, changeId, [{
    source: 'heal',
    type: 'heal_record_apply',
    target,
    applied_proposals: appliedProposalIds,
    skipped_proposals: skippedProposalIds,
    files_modified: modifiedFiles,
    summary_file: applySummaryRel(target),
    summary_sha256: sha256File(summaryPath),
    markdown_file: `healing/${target}-apply-summary.md`,
    markdown_sha256: sha256File(markdownPath),
    proposal_sha256: proposalSha256,
    source_batch_id: sourceBatchId,
    attempt_key: `${proposalSha256}:${sourceBatchId}`,
  }]);
  return {
    target,
    summaryPath,
    markdownPath,
    modifiedFiles,
    appliedProposalIds,
    skippedProposalIds,
  };
}

export function transitionHealingStatus(
  projectRoot: string,
  changeId: string,
  to: HealingStatus,
): HealTransitionResult {
  if (!HEALING_JUDGMENTS.has(to)) {
    throw new Error(`Unsupported healing judgment "${to}"`);
  }
  const state = readWorkflowState(projectRoot, changeId);
  const derived = deriveHealingState(projectRoot, changeId);
  const from = derived.status;
  validatePreconditions(projectRoot, changeId, state, from, to);
  if (!derived.active_batch_id) {
    throw new Error('healing judgment requires an active execution batch');
  }
  appendEventsStrict(projectRoot, changeId, [{
    source: 'status',
    type: 'heal_transition',
    from,
    to,
    source_batch_id: derived.active_batch_id,
    ...(derived.proposal_sha256 ? { proposal_sha256: derived.proposal_sha256 } : {}),
    ...(derived.attempt_key ? { attempt_key: derived.attempt_key } : {}),
  }]);

  return { from, to };
}

function validatePreconditions(
  projectRoot: string,
  changeId: string,
  state: Record<string, unknown>,
  from: HealingStatus,
  to: HealingStatus,
): void {
  const changeDir = path.join(projectRoot, 'qa', 'changes', changeId);

  if (from === 'pending' && to === 'not_needed') {
    const analysis = readJson(changeDir, 'inspect/failure-analysis.json');
    const proposal = readJson(changeDir, 'healing/fix-proposal.json');
    const hasEligible = hasEligibleFailures(analysis);
    const eligibleCount = getEligibleCount(proposal);
    if (hasEligible && eligibleCount !== 0) {
      throw new Error('not_needed requires no fix_proposal_eligible failures and eligible_count == 0');
    }
  }

  if (from === 'pending' && to === 'skipped') {
    const gates = isRecord(state.gates) ? state.gates as Record<string, unknown> : {};
    const healingAvailable = gates.healing_available !== false;
    const maxAttempts = getMaxHealingAttempts(state);
    if (healingAvailable && maxAttempts > 0) {
      throw new Error('skipped requires gates.healing_available == false or max_healing_attempts == 0');
    }
  }

  if (to === 'resolved') {
    assertPhaseDone(state, 'healing_rerun', 'healing-rerun', 'resolved');
    assertPhaseDone(state, 'healing_reinspect', 'healing-reinspect', 'resolved');
    const analysis = readJson(changeDir, 'inspect/failure-analysis.json');
    if (hasEligibleFailures(analysis)) {
      throw new Error('resolved requires no fix_proposal_eligible failures in failure-analysis');
    }
    const manifest = readLatestExecutionManifest(projectRoot, changeId);
    const batchId = typeof manifest?.batch_id === 'string' ? manifest.batch_id : null;
    const sourceBatch = typeof analysis?.source_batch_id === 'string' ? analysis.source_batch_id : null;
    if (batchId && sourceBatch && batchId !== sourceBatch) {
      throw new Error(`resolved requires source_batch_id == latest execution batch (${batchId})`);
    }
  }

  if (to === 'exhausted') {
    const attempts = readHealingAttemptsUsed(projectRoot, changeId);
    const maxAttempts = getMaxHealingAttempts(state);
    const allNoOp = APPLY_SUMMARIES.every(p => {
      const summary = readJson(changeDir, p);
      return summary?.no_op === true;
    });
    if (attempts < maxAttempts && !allNoOp) {
      throw new Error('exhausted requires max healing attempts reached or all fixers no_op');
    }
  }
}

export function isHealingRunContext(projectRoot: string, changeId: string): boolean {
  const changeDir = path.join(projectRoot, 'qa', 'changes', changeId);
  const status = readHealingStatus(projectRoot, changeId);
  if (['proposal_created', 'applied', 'exhausted', 'failed'].includes(status)) return true;
  if (
    status === 'pending'
    && fs.existsSync(path.join(changeDir, 'healing/entry-baseline.json'))
  ) return true;
  return APPLY_SUMMARIES.some(p => fs.existsSync(path.join(changeDir, p)));
}

export function assertHealingRunAllowed(projectRoot: string, changeId: string): void {
  if (!isHealingRunContext(projectRoot, changeId)) return;
  const derived = deriveHealingState(projectRoot, changeId);
  const status = derived.status;
  if (status !== 'applied') {
    throw new Error(
      `HEAL-STATE-REQUIRED: healing-rerun requires healing.status=applied (current: ${status}). Run the healing loop (fix-proposal → fixers → aws state heal).`,
    );
  }
}

export function assertRerunReasonIfNeeded(
  projectRoot: string,
  changeId: string,
  rerunReason: string | undefined,
): void {
  if (isHealingRunContext(projectRoot, changeId)) return;
  const state = readWorkflowState(projectRoot, changeId);
  const phases = isRecord(state.phases) ? state.phases as Record<string, unknown> : {};
  const execution = isRecord(phases.execution) ? phases.execution as Record<string, unknown> : {};
  const executionDone = typeof execution.status === 'string' && execution.status.length > 0;
  const manifestExists = fs.existsSync(path.join(projectRoot, 'qa', 'changes', changeId, 'execution', 'execution-manifest.yaml'));
  if ((executionDone || manifestExists) && !rerunReason?.trim()) {
    throw new Error('RERUN-REASON-REQUIRED: execution already completed; pass --rerun-reason <text>');
  }
}

export function loadProductCodeRoots(projectRoot: string): string[] {
  const configPath = path.join(projectRoot, '.aws', 'config.yaml');
  if (!fs.existsSync(configPath)) return ['app', 'web/src', 'src'];
  try {
    const parsed = yaml.load(fs.readFileSync(configPath, 'utf-8')) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.execution)) return ['app', 'web/src', 'src'];
    const roots = (parsed.execution as Record<string, unknown>).product_code_roots;
    if (!Array.isArray(roots)) return ['app', 'web/src', 'src'];
    const filtered = roots.filter((root): root is string => typeof root === 'string' && root.trim().length > 0);
    return filtered.length > 0 ? filtered : ['app', 'web/src', 'src'];
  } catch {
    return ['app', 'web/src', 'src'];
  }
}

export function assertProductTreeUnchangedInHealing(
  projectRoot: string,
  changeId: string,
  roots = loadProductCodeRoots(projectRoot),
): ProductTreeIntegrityResult {
  const current = hashProductTree(projectRoot, roots);
  const previous = readLatestExecutionManifest(projectRoot, changeId);
  if (!previous?.product_tree_sha256) {
    return { productChanged: false, current };
  }
  if (previous.product_tree_sha256 === current.aggregate) {
    return {
      productChanged: false,
      current,
      previousBatchId: previous.batch_id,
      previousSha256: previous.product_tree_sha256,
    };
  }
  if (isHealingRunContext(projectRoot, changeId)) {
    throw new Error(
      `PRODUCT-CHANGED-DURING-HEALING: product code (roots: ${roots.join(', ')}) changed during the healing ` +
      `loop (baseline batch ${previous.batch_id}). Healing MUST NOT touch product code. Revert product changes, ` +
      'or abandon healing (aws state heal --to failed) and start a new formal run.',
    );
  }
  return {
    productChanged: true,
    current,
    previousBatchId: previous.batch_id,
    previousSha256: previous.product_tree_sha256,
  };
}

export function pinHealingEntryBaseline(projectRoot: string, changeId: string): HealingEntryBaseline {
  const changeDir = path.join(projectRoot, 'qa', 'changes', changeId);
  const baselinePath = path.join(changeDir, 'healing', 'entry-baseline.json');
  const existing = readJson(changeDir, 'healing/entry-baseline.json');
  const manifest = readLatestExecutionManifest(projectRoot, changeId);
  const activeBatchId = typeof manifest?.batch_id === 'string' ? manifest.batch_id : null;
  if (!activeBatchId) {
    throw new Error('HEALING-ENTRY-BASELINE-BATCH-MISSING: active execution batch_id is required');
  }
  const episode = readCurrentHealingEpisode(projectRoot, changeId);
  if (episode) {
    if (!existing) {
      throw new Error('HEALING-ENTRY-BASELINE-MISSING: pinned baseline artifact is missing');
    }
    if (
      existing.episode_id !== episode.episode_id
      || existing.batch_id !== episode.entry_batch_id
      || sha256File(baselinePath) !== episode.artifact_sha256
    ) {
      throw new Error('HEALING-ENTRY-BASELINE-EVIDENCE-MISMATCH: baseline does not match its pin event');
    }
    return existing as unknown as HealingEntryBaseline;
  }

  const tests = hashTestTree(projectRoot);
  const baseline: HealingEntryBaseline = {
    schema_version: '1.0',
    source: 'cli',
    change_id: changeId,
    batch_id: activeBatchId,
    episode_id: randomUUID(),
    pinned_at: new Date().toISOString(),
    tests_tree_sha256: tests.aggregate,
    test_files_sha256: tests.files,
  };
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2), 'utf-8');
  const artifactSha256 = sha256File(baselinePath);
  if (!artifactSha256) {
    throw new Error('HEALING-ENTRY-BASELINE-WRITE-FAILED: baseline artifact is not hashable');
  }
  appendEventsStrict(projectRoot, changeId, [{
    source: 'heal',
    type: 'healing_entry_baseline_pinned',
    artifact_file: 'healing/entry-baseline.json',
    artifact_sha256: artifactSha256,
    entry_batch_id: activeBatchId,
    episode_id: baseline.episode_id,
  }]);
  return baseline;
}

function readCurrentHealingEpisode(
  projectRoot: string,
  changeId: string,
): HealingEntryBaselinePinnedEvent | null {
  const events = readEvents(projectRoot, changeId);
  const pin = [...events].reverse().find(
    (event): event is HealingEntryBaselinePinnedEvent =>
      event.type === 'healing_entry_baseline_pinned',
  );
  if (!pin) return null;
  const ended = events.some(event =>
    event.seq > pin.seq
    && (
      (
        event.type === 'heal_transition'
        && ['resolved', 'not_needed', 'skipped', 'exhausted', 'failed'].includes(event.to)
      )
      || (event.type === 'human_decision' && event.action === 'stop')
    ),
  );
  return ended ? null : pin;
}

export function pinHealingAppliedTestTree(projectRoot: string, changeId: string): HealingAppliedTestTree {
  const changeDir = path.join(projectRoot, 'qa', 'changes', changeId);
  const file = path.join(changeDir, 'healing', 'applied-test-tree.json');
  const tree = hashTestTree(projectRoot);
  const derived = deriveHealingState(projectRoot, changeId);
  const attemptKey = derived.attempt_key;
  if (derived.status !== 'applied' || !attemptKey) {
    throw new Error(
      'HEAL-APPLIED-TREE-CURRENT-SAFETY-REQUIRED: current safety evidence must cover the test tree',
    );
  }
  const existing = readJson(changeDir, 'healing/applied-test-tree.json');
  if (existing?.attempt_key === attemptKey) {
    if (existing.tests_tree_sha256 !== tree.aggregate) {
      throw new Error(
        `HEAL-TREE-MISMATCH: test tree differs from the CLI-pinned applied test tree ` +
        `(pinned ${String(existing.tests_tree_sha256).slice(0, 12)}…, ` +
        `current ${tree.aggregate.slice(0, 12)}…).`,
      );
    }
    return existing as unknown as HealingAppliedTestTree;
  }
  const payload: HealingAppliedTestTree = {
    schema_version: '1.0',
    source: 'cli',
    change_id: changeId,
    pinned_at: new Date().toISOString(),
    tests_tree_sha256: tree.aggregate,
    attempt_key: attemptKey,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf-8');
  return payload;
}

export function assertTestTreeUnchangedOrHealing(
  projectRoot: string,
  changeId: string,
  allowTestChanges: boolean,
): TestTreeIntegrityResult {
  const current = hashTestTree(projectRoot);
  const previous = readLatestExecutionManifest(projectRoot, changeId);
  if (!previous?.tests_tree_sha256) {
    return { testsChanged: false, current, changedFiles: [] };
  }

  const derived = deriveHealingState(projectRoot, changeId);
  if (derived.status === 'applied') {
    const appliedTree = readJson(
      path.join(projectRoot, 'qa', 'changes', changeId),
      'healing/applied-test-tree.json',
    );
    if (!appliedTree) {
      throw new Error(
        'HEAL-APPLIED-TREE-PIN-MISSING: healing/applied-test-tree.json is required before a healing rerun',
      );
    }
    if (appliedTree.attempt_key !== derived.attempt_key) {
      throw new Error(
        'HEAL-APPLIED-TREE-PIN-MISMATCH: applied test tree pin does not match the active healing attempt',
      );
    }
    if (appliedTree.tests_tree_sha256 !== current.aggregate) {
      const pinned = typeof appliedTree.tests_tree_sha256 === 'string'
        ? appliedTree.tests_tree_sha256
        : 'missing';
      throw new Error(
        `HEAL-TREE-MISMATCH: test tree differs from the CLI-pinned applied test tree ` +
        `(pinned ${pinned.slice(0, 12)}…, current ${current.aggregate.slice(0, 12)}…). ` +
        'Tests were modified after the fixers ran. Start a new healing proposal and fixer cycle.',
      );
    }
  }

  const testsChanged = previous.tests_tree_sha256 !== current.aggregate;
  if (!testsChanged) {
    return {
      testsChanged: false,
      current,
      previousBatchId: previous.batch_id,
      changedFiles: [],
    };
  }

  const changedFiles = diffTestFiles(previous.test_files_sha256 ?? {}, current.files);
  const status = derived.status;
  if (allowTestChanges) {
    // Explicit human override (policy-gated, evidence-logged) wins.
    return {
      testsChanged: true,
      current,
      previousBatchId: previous.batch_id,
      changedFiles,
    };
  }
  if (status === 'applied') {
    return {
      testsChanged: true,
      current,
      previousBatchId: previous.batch_id,
      changedFiles,
    };
  }

  const examples = changedFiles.slice(0, 3).map(f => f.path).join(', ') || 'unknown test files';
  throw new Error(
    `TESTS-CHANGED-WITHOUT-HEALING: test files changed since batch ${previous.batch_id} ` +
    `(${changedFiles.length} files, e.g. ${examples}) but healing.status=${status}. ` +
    'Test modifications after a formal run MUST go through the healing proposal and fixer loop.',
  );
}

export function writeCliFixerSafetyCheck(projectRoot: string, changeId: string): Record<string, unknown> {
  const changeDir = path.join(projectRoot, 'qa', 'changes', changeId);
  const healingDir = path.join(changeDir, 'healing');
  fs.mkdirSync(healingDir, { recursive: true });

  const previous = readLatestExecutionManifest(projectRoot, changeId);
  const productRoots = loadProductCodeRoots(projectRoot);
  const product = hashProductTree(projectRoot, productRoots);
  const productCodeModified = !!previous?.product_tree_sha256 && previous.product_tree_sha256 !== product.aggregate;

  const entryBaseline = readJson(changeDir, 'healing/entry-baseline.json');
  if (!entryBaseline || !isRecord(entryBaseline.test_files_sha256)) {
    throw new Error(
      'HEALING-ENTRY-BASELINE-MISSING: pin healing/entry-baseline.json before running fixers',
    );
  }
  const derived = deriveHealingState(projectRoot, changeId);
  if (!derived.attempt_key || !derived.proposal_sha256 || !derived.source_batch_id) {
    throw new Error('FIXER-SAFETY-UNBOUND: active proposal identity is missing or stale');
  }
  const episode = readCurrentHealingEpisode(projectRoot, changeId);
  const baselinePath = path.join(changeDir, 'healing/entry-baseline.json');
  if (
    !episode
    || entryBaseline.episode_id !== episode.episode_id
    || entryBaseline.batch_id !== episode.entry_batch_id
    || sha256File(baselinePath) !== episode.artifact_sha256
  ) {
    throw new Error(
      'HEALING-ENTRY-BASELINE-EVIDENCE-MISMATCH: safety requires the current episode pin event',
    );
  }
  const currentTests = hashTestTree(projectRoot);
  const changedTests = diffTestFiles(
    entryBaseline.test_files_sha256 as Record<string, string>,
    currentTests.files,
  );
  const proposal = readJson(changeDir, 'healing/fix-proposal.json');
  const applySummaries = APPLY_SUMMARIES.map(p => readJson(changeDir, p)).filter(Boolean);
  const proposalFiles = collectProposalFiles(proposal);
  const modifiedByApply = new Set(applySummaries.flatMap(summary => {
    return Array.isArray(summary?.files_modified)
      ? summary.files_modified.filter((file): file is string => typeof file === 'string')
      : [];
  }));
  const changedTestPaths = changedTests.map(f => f.path);
  const unrelatedTests = changedTestPaths.filter(file => !proposalFiles.has(file));
  const highRiskProposalApplied = hasHighRiskProposalApplied(proposal, modifiedByApply);
  const diff = readTestsGitDiff(projectRoot);
  const skipOrXfailAdded = diff.available ? hasAddedSkipOrXfail(diff.text) : 'undetermined';
  const bareReturnAdded = diff.available ? hasAddedBareReturn(diff.text) : 'undetermined';
  const assertionChanges = diff.available ? findAssertionExpectedValueChanges(diff.text) : [];
  const needsReview =
    skipOrXfailAdded === 'undetermined' ||
    bareReturnAdded === 'undetermined' ||
    bareReturnAdded === true ||
    assertionChanges.length > 0;
  const passed =
    productCodeModified === false &&
    skipOrXfailAdded === false &&
    bareReturnAdded === false &&
    unrelatedTests.length === 0 &&
    assertionChanges.length === 0 &&
    highRiskProposalApplied === false &&
    needsReview === false;

  const payload: Record<string, unknown> = {
    schema_version: '1.0',
    source: 'cli',
    change_id: changeId,
    created_at: new Date().toISOString(),
    attempt_key: derived.attempt_key,
    proposal_sha256: derived.proposal_sha256,
    source_batch_id: derived.source_batch_id,
    baseline_batch_id: entryBaseline.batch_id ?? null,
    healing_episode_id: episode.episode_id,
    entry_baseline_sha256: episode.artifact_sha256,
    checked_tests_tree_sha256: currentTests.aggregate,
    product_code_roots: productRoots,
    product_code_modified: productCodeModified,
    skip_or_xfail_added: skipOrXfailAdded,
    bare_return_added: bareReturnAdded,
    unrelated_tests_modified: unrelatedTests.length > 0,
    unrelated_test_files: unrelatedTests,
    assertion_expected_value_changes_detected: assertionChanges.length > 0,
    assertion_expected_value_changes: assertionChanges,
    high_risk_proposal_applied: highRiskProposalApplied,
    needs_review: needsReview,
    passed,
  };
  fs.writeFileSync(path.join(healingDir, 'fixer-safety-check.json'), JSON.stringify(payload, null, 2), 'utf-8');
  return payload;
}

function collectProposalFiles(proposal: Record<string, unknown> | null): Set<string> {
  const files = new Set<string>();
  const proposals = Array.isArray(proposal?.proposals) ? proposal.proposals : [];
  for (const proposalItem of proposals) {
    if (!isRecord(proposalItem)) continue;
    const toModify = Array.isArray(proposalItem.files_to_modify) ? proposalItem.files_to_modify : [];
    for (const file of toModify) {
      if (typeof file === 'string') files.add(file);
    }
  }
  return files;
}

function hasHighRiskProposalApplied(proposal: Record<string, unknown> | null, modifiedByApply: Set<string>): boolean {
  const proposals = Array.isArray(proposal?.proposals) ? proposal.proposals : [];
  for (const proposalItem of proposals) {
    if (!isRecord(proposalItem)) continue;
    if (proposalItem.risk_level !== 'high') continue;
    const files = Array.isArray(proposalItem.files_to_modify) ? proposalItem.files_to_modify : [];
    if (files.some(file => typeof file === 'string' && modifiedByApply.has(file))) return true;
  }
  return false;
}

function readTestsGitDiff(projectRoot: string): { available: true; text: string } | { available: false } {
  const result = spawnSync('git', ['diff', '--', 'tests/'], { cwd: projectRoot, encoding: 'utf-8' });
  if (result.status !== 0) return { available: false };
  return { available: true, text: result.stdout ?? '' };
}

function hasAddedSkipOrXfail(diff: string): boolean {
  return diff.split('\n').some(line =>
    line.startsWith('+') &&
    !line.startsWith('+++') &&
    /pytest\.mark\.(skip|xfail)|unittest\.skip/.test(line),
  );
}

/**
 * Added bare `return` statements in test code are the classic "make it green"
 * early exit (e.g. `if "/404" in page.url: return`) — they silently skip the
 * assertions below. Value-returning helpers (`return foo`) are not flagged.
 */
function hasAddedBareReturn(diff: string): boolean {
  return diff.split('\n').some(line =>
    line.startsWith('+') &&
    !line.startsWith('+++') &&
    /^\+\s*return\s*(#.*)?$/.test(line),
  );
}

function findAssertionExpectedValueChanges(diff: string): string[] {
  return diff
    .split('\n')
    .filter(line =>
      (line.startsWith('+') || line.startsWith('-')) &&
      !line.startsWith('+++') &&
      !line.startsWith('---') &&
      /\bassert\b/.test(line) &&
      /(['"][^'"]+['"]|\b\d{3}\b|\bTrue\b|\bFalse\b)/.test(line),
    );
}

function assertPhaseDone(state: Record<string, unknown>, stateKey: string, label: string, target: string): void {
  const phases = isRecord(state.phases) ? state.phases as Record<string, unknown> : {};
  const phase = isRecord(phases[stateKey]) ? phases[stateKey] as Record<string, unknown> : {};
  const status = phase.status;
  if (status !== 'done' && status !== 'PASS' && status !== 'PASS_WITH_WARNINGS' && status !== 'FAIL') {
    throw new Error(`${label} must be done before healing.status=${target}`);
  }
}

function getMaxHealingAttempts(state: Record<string, unknown>): number {
  const params = isRecord(state.params) ? state.params as Record<string, unknown> : {};
  return typeof params.max_healing_attempts === 'number'
    ? params.max_healing_attempts
    : DEFAULT_MAX_HEALING_ATTEMPTS;
}

function applySummaryRel(target: ApplySummaryTarget): string {
  return `healing/${target}-apply-summary.json`;
}

function validateApplySummary(
  projectRoot: string,
  changeId: string,
  target: ApplySummaryTarget,
  summary: Record<string, unknown>,
  proposal: Record<string, unknown> | null,
): void {
  const label = `${target}-apply-summary.json`;
  requireField(summary, 'schema_version', 'string', label);
  requireField(summary, 'change_id', 'string', label);
  requireField(summary, 'target', 'string', label);
  requireField(summary, 'applied', 'boolean', label);
  requireField(summary, 'applied_proposals', 'array', label);
  requireField(summary, 'files_modified', 'array', label);
  requireField(summary, 'skipped_proposals', 'array', label);
  requireField(summary, 'forbidden_attempts', 'array', label);
  requireField(summary, 'rerun_required', 'boolean', label);
  requireField(summary, 'next_action', 'string', label);

  if (summary.change_id !== changeId) throw new Error(`${label} change_id mismatch: expected ${changeId}`);
  if (summary.target !== target) throw new Error(`${label} target mismatch: expected ${target}`);

  const files = stringArray(summary.files_modified, `${label} files_modified`);
  const noOp = summary.no_op === true;
  if (!noOp && summary.applied === true && files.length === 0) {
    throw new Error(`${label} requires files_modified or no_op: true`);
  }

  const authorizedFiles = collectEligibleProposalFiles(proposal, target);
  const accountedProposalIds = new Set<string>();
  for (const item of recordArray(summary.applied_proposals, `${label} applied_proposals`)) {
    accountedProposalIds.add(requireString(item, 'proposal_id', `${label} applied_proposals[]`));
    for (const file of stringArray(item.files_modified, `${label} applied_proposals[].files_modified`)) {
      validateSummaryFileAuthorized(label, file, authorizedFiles);
    }
  }
  for (const item of recordArray(summary.skipped_proposals, `${label} skipped_proposals`)) {
    accountedProposalIds.add(requireString(item, 'proposal_id', `${label} skipped_proposals[]`));
    requireString(item, 'reason', `${label} skipped_proposals[]`);
  }
  for (const file of files) validateSummaryFileAuthorized(label, file, authorizedFiles);

  for (const proposalId of eligibleProposalIds(proposal, target)) {
    if (!accountedProposalIds.has(proposalId)) {
      throw new Error(`${label} does not account for eligible proposal ${proposalId}`);
    }
  }
}

function requireField(
  summary: Record<string, unknown>,
  field: string,
  type: 'string' | 'boolean' | 'array',
  label: string,
): void {
  const value = summary[field];
  const ok = type === 'array' ? Array.isArray(value) : typeof value === type;
  if (!ok) throw new Error(`${label} missing required field ${field}`);
}

function requireString(record: Record<string, unknown>, field: string, label: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} missing required field ${field}`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value;
}

function recordArray(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some(item => !isRecord(item))) {
    throw new Error(`${label} must be an array of objects`);
  }
  return value as Record<string, unknown>[];
}

function validateSummaryFileAuthorized(label: string, file: string, authorizedFiles: Set<string>): void {
  if (authorizedFiles.size > 0 && !authorizedFiles.has(file)) {
    throw new Error(`${label} lists file not authorized by fix-proposal: ${file}`);
  }
}

/**
 * Read the eligible fixer proposal ids for a target from healing/fix-proposal.json.
 * The driver passes these to `aws heal record-apply --proposal <ids>` (the CLI
 * rejects placeholders like "all" and validates ids against this eligible set).
 * Returns [] when the proposal file is missing or has no eligible proposals for
 * the target.
 */
export function readEligibleProposalIds(
  projectRoot: string,
  changeId: string,
  target: ApplySummaryTarget,
): string[] {
  const changeDir = path.join(projectRoot, 'qa', 'changes', changeId);
  const proposal = readJson(changeDir, 'healing/fix-proposal.json');
  return eligibleProposalIds(proposal, target);
}

function eligibleProposalIds(proposal: Record<string, unknown> | null, target: ApplySummaryTarget): string[] {
  const proposals = Array.isArray(proposal?.proposals) ? proposal.proposals : [];
  return proposals
    .filter(item => isRecord(item) && item.eligible === true && item.target === target)
    .map(item => (item as Record<string, unknown>).proposal_id)
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
}

function collectEligibleProposalFiles(proposal: Record<string, unknown> | null, target: ApplySummaryTarget): Set<string> {
  const files = new Set<string>();
  const proposals = Array.isArray(proposal?.proposals) ? proposal.proposals : [];
  for (const proposalItem of proposals) {
    if (!isRecord(proposalItem) || proposalItem.eligible !== true || proposalItem.target !== target) continue;
    const toModify = Array.isArray(proposalItem.files_to_modify) ? proposalItem.files_to_modify : [];
    for (const file of toModify) {
      if (typeof file === 'string') files.add(file);
    }
    const patchPlan = Array.isArray(proposalItem.patch_plan) ? proposalItem.patch_plan : [];
    for (const step of patchPlan) {
      if (isRecord(step) && typeof step.file === 'string') files.add(step.file);
    }
  }
  return files;
}

function collectEligibleProposalFilesByIds(
  proposal: Record<string, unknown> | null,
  target: ApplySummaryTarget,
  proposalIds: Set<string>,
): Set<string> {
  const files = new Set<string>();
  const proposals = Array.isArray(proposal?.proposals) ? proposal.proposals : [];
  for (const proposalItem of proposals) {
    if (!isRecord(proposalItem) || proposalItem.eligible !== true || proposalItem.target !== target) continue;
    if (typeof proposalItem.proposal_id !== 'string' || !proposalIds.has(proposalItem.proposal_id)) continue;
    const toModify = Array.isArray(proposalItem.files_to_modify) ? proposalItem.files_to_modify : [];
    for (const file of toModify) {
      if (typeof file === 'string') files.add(file);
    }
    const patchPlan = Array.isArray(proposalItem.patch_plan) ? proposalItem.patch_plan : [];
    for (const step of patchPlan) {
      if (isRecord(step) && typeof step.file === 'string') files.add(step.file);
    }
  }
  return files;
}

function proposalOperations(proposal: Record<string, unknown> | null, proposalId: string): string[] {
  const proposals = Array.isArray(proposal?.proposals) ? proposal.proposals : [];
  const item = proposals.find(candidate => isRecord(candidate) && candidate.proposal_id === proposalId);
  if (!isRecord(item)) return [];
  const patchPlan = Array.isArray(item.patch_plan) ? item.patch_plan : [];
  const operations = patchPlan
    .map(step => (isRecord(step) && typeof step.operation === 'string' ? step.operation : null))
    .filter((operation): operation is string => operation !== null);
  return [...new Set(operations)];
}

function buildApplySummaryMarkdown(
  changeId: string,
  target: ApplySummaryTarget,
  createdAt: string,
  summary: Record<string, unknown>,
): string {
  const applied = recordArray(summary.applied_proposals, `${target}-apply-summary.md applied_proposals`);
  const skipped = recordArray(summary.skipped_proposals, `${target}-apply-summary.md skipped_proposals`);
  const files = stringArray(summary.files_modified, `${target}-apply-summary.md files_modified`);
  const lines = [
    `# ${target.toUpperCase()} Codegen Fixer — Apply Summary`,
    '',
    `**Change**: ${changeId}`,
    `**Recorded at**: ${createdAt}`,
    `**Source**: aws heal record-apply`,
    `**Applied proposals**: ${applied.length}`,
    `**Files modified**: ${files.length}`,
    '',
    '## Applied Fixes',
    '',
  ];
  if (applied.length === 0) {
    lines.push('_None_', '');
  } else {
    for (const item of applied) {
      lines.push(`- ${requireString(item, 'proposal_id', 'applied_proposals[]')}`);
    }
    lines.push('');
  }
  lines.push('## Modified Files', '');
  if (files.length === 0) {
    lines.push('_None_', '');
  } else {
    for (const file of files) lines.push(`- \`${file}\``);
    lines.push('');
  }
  lines.push('## Skipped Proposals', '');
  if (skipped.length === 0) {
    lines.push('_None_', '');
  } else {
    for (const item of skipped) {
      lines.push(`- ${requireString(item, 'proposal_id', 'skipped_proposals[]')}: ${requireString(item, 'reason', 'skipped_proposals[]')}`);
    }
    lines.push('');
  }
  lines.push('## Next Action', '', String(summary.next_action ?? 'unknown'), '');
  return `${lines.join('\n')}\n`;
}

function eligibleProposalTargets(proposal: Record<string, unknown> | null): ApplySummaryTarget[] {
  const proposals = Array.isArray(proposal?.proposals) ? proposal.proposals : [];
  const targets = new Set<ApplySummaryTarget>();
  for (const item of proposals) {
    if (!isRecord(item) || item.eligible !== true) continue;
    const target = item.target;
    if (target === 'api' || target === 'e2e') targets.add(target);
  }
  return [...targets];
}

function readLatestExecutionManifest(projectRoot: string, changeId: string): ExecutionManifest | null {
  const executionDir = path.join(
    projectRoot,
    'qa',
    'changes',
    changeId,
    'execution',
  );
  return loadExecutionEvidence(executionDir).manifest;
}

function diffTestFiles(previous: Record<string, string>, current: Record<string, string>): ChangedTestFile[] {
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
  return [...keys]
    .filter(key => previous[key] !== current[key])
    .sort()
    .map((key): ChangedTestFile => {
      const oldHash = previous[key] ?? null;
      const newHash = current[key] ?? null;
      const changeType: ChangedTestFile['change_type'] =
        oldHash === null ? 'added' : newHash === null ? 'deleted' : 'modified';
      return { path: key, old_sha256: oldHash, new_sha256: newHash, change_type: changeType };
    });
}

function hasEligibleFailures(analysis: Record<string, unknown> | null): boolean {
  if (!analysis) return false;
  const failures = Array.isArray(analysis.failures) ? analysis.failures : [];
  return failures.some(f => isRecord(f) && f.fix_proposal_eligible === true);
}

function getEligibleCount(proposal: Record<string, unknown> | null): number | null {
  if (!proposal) return null;
  const summary = isRecord(proposal.summary) ? proposal.summary as Record<string, unknown> : null;
  if (!summary) return null;
  return typeof summary.eligible_count === 'number' ? summary.eligible_count : null;
}

function getHealingPhase(state: Record<string, unknown>): Record<string, unknown> {
  const phases = isRecord(state.phases) ? state.phases as Record<string, unknown> : {};
  return isRecord(phases.healing) ? { ...(phases.healing as Record<string, unknown>) } : {};
}

function readWorkflowState(projectRoot: string, changeId: string): Record<string, unknown> {
  const file = getWorkflowStateFile(projectRoot, changeId);
  if (!fs.existsSync(file)) return {};
  const parsed = yaml.load(fs.readFileSync(file, 'utf-8'));
  return isRecord(parsed) ? parsed : {};
}

function readJson(changeDir: string, rel: string): Record<string, unknown> | null {
  const file = path.join(changeDir, rel);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
