import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { spawnSync } from 'child_process';
import { appendEvents } from './events';
import { hashProductTree, hashTestTree, sha256File, TestTreeHash } from './hash';
import { getWorkflowStateFile } from './workflow_state';
import type { ExecutionManifest } from './types';

export type HealingStatus =
  | 'pending'
  | 'proposal_created'
  | 'applied'
  | 'resolved'
  | 'exhausted'
  | 'not_needed'
  | 'failed'
  | 'skipped';

const LEGAL_TRANSITIONS: Record<string, HealingStatus[]> = {
  pending: ['proposal_created', 'not_needed', 'skipped'],
  proposal_created: ['applied', 'failed'],
  // applied → proposal_created is the loop-back edge for attempt N+1
  // (rerun FAILed, re-inspect found eligible failures, attempts < max).
  applied: ['proposal_created', 'resolved', 'exhausted', 'failed'],
};

export const DEFAULT_MAX_HEALING_ATTEMPTS = 3;

const APPLY_SUMMARIES = [
  'healing/api-apply-summary.json',
  'healing/e2e-apply-summary.json',
];

const APPLY_SUMMARY_TARGETS = ['api', 'e2e'] as const;
type ApplySummaryTarget = typeof APPLY_SUMMARY_TARGETS[number];

const FIXER_ERROR_GLOBS = [
  'healing/api-fixer-error.json',
  'healing/e2e-fixer-error.json',
];

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

export function readHealingStatus(projectRoot: string, changeId: string): HealingStatus {
  const state = readWorkflowState(projectRoot, changeId);
  const healing = getHealingPhase(state);
  const status = healing.status;
  return typeof status === 'string' ? (status as HealingStatus) : 'pending';
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
  const unauthorized = changedPaths.filter(file => {
    if (target === 'api' && !file.startsWith('tests/api/') && !file.startsWith('tests/fixtures/')) return false;
    if (target === 'e2e' && !file.startsWith('tests/e2e/') && !file.startsWith('tests/fixtures/')) return false;
    return !selectedFiles.has(file);
  });
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
  appendEvents(projectRoot, changeId, [{
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
  const state = readWorkflowState(projectRoot, changeId);
  const healing = getHealingPhase(state);
  const from = (typeof healing.status === 'string' ? healing.status : 'pending') as HealingStatus;

  if (!LEGAL_TRANSITIONS[from]?.includes(to)) {
    throw new Error(`HEAL-TRANSITION-ILLEGAL: ${from} → ${to}`);
  }

  if (from === 'proposal_created' && to === 'applied') {
    writeCliFixerSafetyCheck(projectRoot, changeId);
  }
  validatePreconditions(projectRoot, changeId, state, from, to);

  const nextHealing: Record<string, unknown> = { ...healing, status: to };
  if (to === 'proposal_created') {
    const attempts = Array.isArray(healing.attempts) ? [...healing.attempts] : [];
    if (from === 'applied' && attempts.length > 0) {
      // Loop-back: close out the previous attempt as unresolved before
      // allocating the next one.
      const last = { ...(attempts[attempts.length - 1] as Record<string, unknown>) };
      if (last.resolved == null) last.resolved = 'unresolved';
      attempts[attempts.length - 1] = last;
    }
    attempts.push({
      attempt: attempts.length + 1,
      started_at: new Date().toISOString(),
      proposal_ref: 'healing/fix-proposal.json',
      resolved: null,
    });
    nextHealing.attempts = attempts;
    // A new proposal invalidates the previous apply authorization.
    delete nextHealing.applied_tests_tree_sha256;
  }

  if (from === 'proposal_created' && to === 'applied') {
    // Pin the exact test tree the fixers produced. `aws run` only accepts
    // this tree while healing.status == applied — one authorization covers
    // one fixed tree, so post-apply manual edits are rejected.
    nextHealing.applied_tests_tree_sha256 = hashTestTree(projectRoot).aggregate;
  }

  if (to === 'resolved' || to === 'exhausted') {
    const attempts = Array.isArray(nextHealing.attempts) ? [...nextHealing.attempts] : [];
    if (attempts.length > 0) {
      const last = { ...(attempts[attempts.length - 1] as Record<string, unknown>) };
      last.resolved = to;
      attempts[attempts.length - 1] = last;
      nextHealing.attempts = attempts;
    }
  }

  writeHealingPhase(projectRoot, changeId, nextHealing);
  appendEvents(projectRoot, changeId, [{
    source: 'status',
    type: 'heal_transition',
    from,
    to,
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

  if (to === 'proposal_created') {
    const proposal = readJson(changeDir, 'healing/fix-proposal.json');
    if (!proposal) throw new Error('healing/fix-proposal.json missing or invalid');
    if (typeof proposal.summary !== 'object' || proposal.summary === null) {
      throw new Error('healing/fix-proposal.json missing summary');
    }
    // Freshness: the proposal must be based on an inspect of the latest
    // formal batch, not a stale analysis from an earlier one.
    const analysis = readJson(changeDir, 'inspect/failure-analysis.json');
    const manifest = readLatestExecutionManifest(projectRoot, changeId);
    const latestBatch = typeof manifest?.batch_id === 'string' ? manifest.batch_id : null;
    const sourceBatch = typeof analysis?.source_batch_id === 'string' ? analysis.source_batch_id : null;
    if (latestBatch && sourceBatch && latestBatch !== sourceBatch) {
      throw new Error(
        `PROPOSAL-STALE: inspect/failure-analysis.json source_batch_id=${sourceBatch} does not match ` +
        `the latest execution batch ${latestBatch}. Re-run aws report inspect before creating a fix proposal.`,
      );
    }
  }

  if (from === 'applied' && to === 'proposal_created') {
    // Loop-back for attempt N+1 requires: the previous fix was actually
    // verified by a rerun, and the attempt budget is not exhausted.
    assertPhaseDone(state, 'healing_rerun', 'healing-rerun', 'proposal_created (loop-back)');
    const healing = getHealingPhase(state);
    const attempts = Array.isArray(healing.attempts) ? healing.attempts : [];
    const maxAttempts = getMaxHealingAttempts(state);
    if (attempts.length >= maxAttempts) {
      throw new Error(
        `HEAL-ATTEMPTS-EXHAUSTED: ${attempts.length}/${maxAttempts} healing attempts used. ` +
        'Run aws state heal --to exhausted and surface the decision to the user.',
      );
    }
  }

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

  if (from === 'proposal_created' && to === 'applied') {
    const proposal = readJson(changeDir, 'healing/fix-proposal.json');
    const summaries = APPLY_SUMMARIES.map(p => readJson(changeDir, p)).filter(Boolean);
    if (summaries.length === 0) {
      throw new Error('applied requires at least one apply-summary');
    }
    for (const target of APPLY_SUMMARY_TARGETS) {
      const summaryRel = applySummaryRel(target);
      const summary = readJson(changeDir, summaryRel);
      if (summary) {
        const markdownRel = `healing/${target}-apply-summary.md`;
        if (!fs.existsSync(path.join(changeDir, markdownRel))) {
          throw new Error(`applied requires ${markdownRel}`);
        }
        validateApplySummary(projectRoot, changeId, target, summary, proposal);
      }
    }
    // Every target with an eligible proposal must have its own apply-summary
    // (no_op: true is acceptable) — one summary must not silently cover both.
    for (const target of eligibleProposalTargets(proposal)) {
      const summaryRel = applySummaryRel(target);
      if (!readJson(changeDir, summaryRel)) {
        throw new Error(
          `applied requires ${summaryRel}: fix-proposal has an eligible ${target} proposal ` +
          `but the ${target} fixer wrote no apply-summary`,
        );
      }
    }
    const safety = readJson(changeDir, 'healing/fixer-safety-check.json');
    if (!safety || safety.passed !== true) {
      throw new Error('applied requires healing/fixer-safety-check.json with passed == true');
    }
    if (safety.needs_review === true) {
      throw new Error('applied requires healing/fixer-safety-check.json needs_review != true');
    }
    validateApplySummaryAgainstTestDiff(projectRoot, changeId, proposal);
  }

  if ((from === 'proposal_created' || from === 'applied') && to === 'failed') {
    const hasError = FIXER_ERROR_GLOBS.some(p => fs.existsSync(path.join(changeDir, p)));
    if (!hasError) throw new Error('failed requires a healing/*-fixer-error.json file');
  }

  if (from === 'applied' && to === 'resolved') {
    assertPhaseDone(state, 'healing_rerun', 'healing-rerun', 'resolved');
    assertPhaseDone(state, 'healing_reinspect', 'healing-reinspect', 'resolved');
    const analysis = readJson(changeDir, 'inspect/failure-analysis.json');
    if (hasEligibleFailures(analysis)) {
      throw new Error('resolved requires no fix_proposal_eligible failures in failure-analysis');
    }
    const execution = isRecord(state.phases) && isRecord((state.phases as Record<string, unknown>).execution)
      ? (state.phases as Record<string, unknown>).execution as Record<string, unknown>
      : {};
    const batchId = typeof execution.batch_id === 'string' ? execution.batch_id : null;
    const sourceBatch = typeof analysis?.source_batch_id === 'string' ? analysis.source_batch_id : null;
    if (batchId && sourceBatch && batchId !== sourceBatch) {
      throw new Error(`resolved requires source_batch_id == latest execution batch (${batchId})`);
    }
  }

  if (from === 'applied' && to === 'exhausted') {
    const healing = getHealingPhase(state);
    const attempts = Array.isArray(healing.attempts) ? healing.attempts : [];
    const maxAttempts = getMaxHealingAttempts(state);
    const allNoOp = APPLY_SUMMARIES.every(p => {
      const summary = readJson(changeDir, p);
      return summary?.no_op === true;
    });
    if (attempts.length < maxAttempts && !allNoOp) {
      throw new Error('exhausted requires max healing attempts reached or all fixers no_op');
    }
  }
}

export function isHealingRunContext(projectRoot: string, changeId: string): boolean {
  const changeDir = path.join(projectRoot, 'qa', 'changes', changeId);
  const status = readHealingStatus(projectRoot, changeId);
  if (['proposal_created', 'applied', 'exhausted', 'failed'].includes(status)) return true;
  return APPLY_SUMMARIES.some(p => fs.existsSync(path.join(changeDir, p)));
}

export function assertHealingRunAllowed(projectRoot: string, changeId: string): void {
  if (!isHealingRunContext(projectRoot, changeId)) return;
  const status = readHealingStatus(projectRoot, changeId);
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
  const status = readHealingStatus(projectRoot, changeId);
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
    // `applied` only authorizes the exact tree pinned at `heal --to applied`.
    // Manual edits after apply must go through a new proposal cycle.
    const healing = getHealingPhase(readWorkflowState(projectRoot, changeId));
    const pinned = healing.applied_tests_tree_sha256;
    if (typeof pinned === 'string' && pinned !== current.aggregate) {
      throw new Error(
        `HEAL-TREE-MISMATCH: test tree differs from the tree authorized at 'aws state heal --to applied' ` +
        `(pinned ${pinned.slice(0, 12)}…, current ${current.aggregate.slice(0, 12)}…). ` +
        'Tests were modified after the fixers ran. Start a new healing cycle: ' +
        'aws report inspect → aws-fix-proposal → aws state heal --to proposal_created → fixers → --to applied.',
      );
    }
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
    'Test modifications after a formal run MUST go through the healing loop: ' +
    'aws-fix-proposal → fixer skill → aws state heal --to applied → aws run. ' +
    'If a human explicitly decided to modify tests outside healing, record that decision with ' +
    'aws run --change <id> --allow-test-changes --reason "<user decision>".',
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

  const currentTests = hashTestTree(projectRoot);
  const changedTests = previous?.test_files_sha256
    ? diffTestFiles(previous.test_files_sha256, currentTests.files)
    : [];
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
    baseline_batch_id: previous?.batch_id ?? null,
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

function validateApplySummaryAgainstTestDiff(
  projectRoot: string,
  changeId: string,
  proposal: Record<string, unknown> | null,
): void {
  const previous = readLatestExecutionManifest(projectRoot, changeId);
  if (!previous?.test_files_sha256) return;

  const changed = diffTestFiles(previous.test_files_sha256, hashTestTree(projectRoot).files).map(f => f.path);
  if (changed.length === 0) return;

  const changeDir = path.join(projectRoot, 'qa', 'changes', changeId);
  const claimed = new Set<string>();
  for (const target of APPLY_SUMMARY_TARGETS) {
    const summary = readJson(changeDir, applySummaryRel(target));
    if (!summary) continue;
    for (const file of stringArray(summary.files_modified ?? [], `${target}-apply-summary.json files_modified`)) {
      claimed.add(file);
    }
  }

  const authorized = new Set([
    ...collectEligibleProposalFiles(proposal, 'api'),
    ...collectEligibleProposalFiles(proposal, 'e2e'),
  ]);
  const unclaimed = changed.filter(file => !claimed.has(file));
  if (unclaimed.length > 0) {
    throw new Error(`APPLY-SUMMARY-MISMATCH: changed test files not listed in apply-summary: ${unclaimed.join(', ')}`);
  }
  const unauthorized = changed.filter(file => !authorized.has(file));
  if (unauthorized.length > 0) {
    throw new Error(`APPLY-SUMMARY-UNAUTHORIZED-FILE: changed test files not authorized by fix-proposal: ${unauthorized.join(', ')}`);
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
  const manifestPath = path.join(projectRoot, 'qa', 'changes', changeId, 'execution', 'execution-manifest.yaml');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const parsed = yaml.load(fs.readFileSync(manifestPath, 'utf-8')) as unknown;
    return isRecord(parsed) ? parsed as unknown as ExecutionManifest : null;
  } catch {
    return null;
  }
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

function writeHealingPhase(projectRoot: string, changeId: string, healing: Record<string, unknown>): void {
  const file = getWorkflowStateFile(projectRoot, changeId);
  const state = readWorkflowState(projectRoot, changeId);
  const phases = isRecord(state.phases) ? { ...(state.phases as Record<string, unknown>) } : {};
  phases.healing = healing;
  state.phases = phases;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml.dump(state, { lineWidth: 120 }), 'utf-8');
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
