import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { spawnSync } from 'child_process';
import { appendEvents } from './events';
import { hashProductTree, hashTestTree, TestTreeHash } from './hash';
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
  applied: ['resolved', 'exhausted', 'failed'],
};

const APPLY_SUMMARIES = [
  'healing/api-apply-summary.json',
  'healing/e2e-apply-summary.json',
];

const FIXER_ERROR_GLOBS = [
  'healing/api-fixer-error.json',
  'healing/e2e-fixer-error.json',
];

export interface HealTransitionResult {
  from: HealingStatus;
  to: HealingStatus;
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
  if (from === 'pending' && to === 'proposal_created') {
    const attempts = Array.isArray(healing.attempts) ? [...healing.attempts] : [];
    attempts.push({
      attempt: attempts.length + 1,
      started_at: new Date().toISOString(),
      proposal_ref: 'healing/fix-proposal.json',
      resolved: null,
    });
    nextHealing.attempts = attempts;
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

  if (from === 'pending' && to === 'proposal_created') {
    const proposal = readJson(changeDir, 'healing/fix-proposal.json');
    if (!proposal) throw new Error('healing/fix-proposal.json missing or invalid');
    if (typeof proposal.summary !== 'object' || proposal.summary === null) {
      throw new Error('healing/fix-proposal.json missing summary');
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
    const params = isRecord(state.params) ? state.params as Record<string, unknown> : {};
    const healingAvailable = gates.healing_available !== false;
    const maxAttempts = typeof params.max_healing_attempts === 'number' ? params.max_healing_attempts : 2;
    if (healingAvailable && maxAttempts > 0) {
      throw new Error('skipped requires gates.healing_available == false or max_healing_attempts == 0');
    }
  }

  if (from === 'proposal_created' && to === 'applied') {
    const summaries = APPLY_SUMMARIES.map(p => readJson(changeDir, p)).filter(Boolean);
    if (summaries.length === 0) {
      throw new Error('applied requires at least one apply-summary');
    }
    for (const summary of summaries) {
      const files = Array.isArray(summary?.files_modified) ? summary.files_modified : [];
      const noOp = summary?.no_op === true;
      if (!noOp && files.length === 0) {
        throw new Error('apply-summary requires files_modified or no_op: true');
      }
    }
    const safety = readJson(changeDir, 'healing/fixer-safety-check.json');
    if (!safety || safety.passed !== true) {
      throw new Error('applied requires healing/fixer-safety-check.json with passed == true');
    }
    if (safety.needs_review === true) {
      throw new Error('applied requires healing/fixer-safety-check.json needs_review != true');
    }
  }

  if ((from === 'proposal_created' || from === 'applied') && to === 'failed') {
    const hasError = FIXER_ERROR_GLOBS.some(p => fs.existsSync(path.join(changeDir, p)));
    if (!hasError) throw new Error('failed requires a healing/*-fixer-error.json file');
  }

  if (from === 'applied' && to === 'resolved') {
    assertPhaseDone(state, 'healing_rerun', 'healing-rerun');
    assertPhaseDone(state, 'healing_reinspect', 'healing-reinspect');
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
    const params = isRecord(state.params) ? state.params as Record<string, unknown> : {};
    const maxAttempts = typeof params.max_healing_attempts === 'number' ? params.max_healing_attempts : 2;
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
  if (status === 'applied' || allowTestChanges) {
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

function assertPhaseDone(state: Record<string, unknown>, stateKey: string, label: string): void {
  const phases = isRecord(state.phases) ? state.phases as Record<string, unknown> : {};
  const phase = isRecord(phases[stateKey]) ? phases[stateKey] as Record<string, unknown> : {};
  const status = phase.status;
  if (status !== 'done' && status !== 'PASS' && status !== 'PASS_WITH_WARNINGS' && status !== 'FAIL') {
    throw new Error(`${label} must be done before healing.status=resolved`);
  }
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
