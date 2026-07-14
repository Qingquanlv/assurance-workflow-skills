import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
  deriveHealingState,
  pinHealingAppliedTestTree,
} from '../../../../src/workflow/core/healing_state';
import { hashTestTree, sha256File } from '../../../../src/utils/hash';

const changeId = 'REQ-DERIVE-HEAL';

function changeDir(root: string): string {
  return path.join(root, 'qa', 'changes', changeId);
}

function writeJson(root: string, relative: string, value: unknown): string {
  const file = path.join(changeDir(root), relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf-8');
  return file;
}

function seedBatch(root: string, batchId = 'batch-1', failures: unknown[] = []): void {
  const manifest = path.join(changeDir(root), 'execution', 'execution-manifest.yaml');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, yaml.dump({ batch_id: batchId }), 'utf-8');
  writeJson(root, 'inspect/failure-analysis.json', {
    source_batch_id: batchId,
    failures,
  });
}

function seedProposal(
  root: string,
  targets: Array<'api' | 'e2e'> = ['api'],
  sourceBatchId = 'batch-1',
  extra: Record<string, unknown> = {},
): string {
  const analysisSha = sha256File(path.join(changeDir(root), 'inspect/failure-analysis.json'));
  return writeJson(root, 'healing/fix-proposal.json', {
    source_batch_id: sourceBatchId,
    source_analysis_sha256: analysisSha,
    summary: { eligible_count: targets.length },
    proposals: targets.map(target => ({
      proposal_id: `FIX-${target.toUpperCase()}-1`,
      target,
      eligible: true,
      files_to_modify: [`tests/${target}/test_fix.py`],
    })),
    ...extra,
  });
}

function seedSummary(root: string, target: 'api' | 'e2e', noOp = false): string {
  return writeJson(root, `healing/${target}-apply-summary.json`, {
    schema_version: '1.0',
    change_id: changeId,
    target,
    applied: !noOp,
    no_op: noOp,
    applied_proposals: [{
      proposal_id: `FIX-${target.toUpperCase()}-1`,
      files_modified: [`tests/${target}/test_fix.py`],
      operations_applied: ['repair'],
      notes: '',
    }],
    files_modified: noOp ? [] : [`tests/${target}/test_fix.py`],
    skipped_proposals: [],
    forbidden_attempts: [],
    rerun_required: !noOp,
    next_action: noOp ? 'none' : 'run_aws_run',
  });
}

function appendEvent(root: string, event: Record<string, unknown>): void {
  const file = path.join(changeDir(root), 'events.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = fs.existsSync(file)
    ? fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean).length
    : 0;
  fs.appendFileSync(file, `${JSON.stringify({
    seq: existing + 1,
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, existing)).toISOString(),
    change_id: changeId,
    ...event,
  })}\n`);
}

function recordSummaryEvent(
  root: string,
  target: 'api' | 'e2e',
  proposalSha: string,
  sourceBatchId = 'batch-1',
): void {
  const summary = path.join(changeDir(root), `healing/${target}-apply-summary.json`);
  appendEvent(root, {
    source: 'heal',
    type: 'heal_record_apply',
    target,
    applied_proposals: [`FIX-${target.toUpperCase()}-1`],
    skipped_proposals: [],
    files_modified: [`tests/${target}/test_fix.py`],
    summary_file: `healing/${target}-apply-summary.json`,
    summary_sha256: sha256File(summary),
    markdown_file: `healing/${target}-apply-summary.md`,
    markdown_sha256: null,
    proposal_sha256: proposalSha,
    source_batch_id: sourceBatchId,
    attempt_key: `${proposalSha}:${sourceBatchId}`,
  });
}

function seedSafety(
  root: string,
  proposalSha: string,
  sourceBatchId = 'batch-1',
  entryBatchId = sourceBatchId,
  overrides: Record<string, unknown> = {},
): string {
  const baselineFile = path.join(changeDir(root), 'healing/entry-baseline.json');
  let pin = readBaselinePin(root);
  if (!pin) {
    writeJson(root, 'healing/entry-baseline.json', {
      schema_version: '1.0',
      source: 'cli',
      change_id: changeId,
      batch_id: entryBatchId,
      episode_id: 'episode-1',
      pinned_at: '2026-01-01T00:00:00.000Z',
      tests_tree_sha256: 'tree',
      test_files_sha256: {},
    });
    pin = {
      episode_id: 'episode-1',
      entry_batch_id: entryBatchId,
      artifact_sha256: sha256File(baselineFile)!,
    };
    appendEvent(root, {
      source: 'heal',
      type: 'healing_entry_baseline_pinned',
      artifact_file: 'healing/entry-baseline.json',
      ...pin,
    });
  }
  return writeJson(root, 'healing/fixer-safety-check.json', {
    passed: true,
    needs_review: false,
    attempt_key: `${proposalSha}:${sourceBatchId}`,
    proposal_sha256: proposalSha,
    source_batch_id: sourceBatchId,
    baseline_batch_id: pin.entry_batch_id,
    healing_episode_id: pin.episode_id,
    entry_baseline_sha256: pin.artifact_sha256,
    checked_tests_tree_sha256: hashTestTree(root).aggregate,
    ...overrides,
  });
}

function readBaselinePin(root: string): {
  episode_id: string;
  entry_batch_id: string;
  artifact_sha256: string;
} | null {
  const file = path.join(changeDir(root), 'events.jsonl');
  if (!fs.existsSync(file)) return null;
  const events = fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>);
  const pin = [...events].reverse().find(event => event.type === 'healing_entry_baseline_pinned');
  return pin
    ? {
      episode_id: String(pin.episode_id),
      entry_batch_id: String(pin.entry_batch_id),
      artifact_sha256: String(pin.artifact_sha256),
    }
    : null;
}

describe('deriveHealingState', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-heal-derived-'));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('is pending without fresh inspect evidence', () => {
    expect(deriveHealingState(projectRoot, changeId)).toMatchObject({
      status: 'pending',
      attempts_used: 0,
    });
  });

  it('derives proposal_created from a proposal for the active analysis batch', () => {
    seedBatch(projectRoot, 'batch-1', [
      { case_id: 'TC-1', target: 'api', fix_proposal_eligible: true },
    ]);
    seedProposal(projectRoot);

    expect(deriveHealingState(projectRoot, changeId).status).toBe('proposal_created');
  });

  it('ignores a proposal when inspect analysis is stale', () => {
    seedBatch(projectRoot, 'batch-2', [
      { case_id: 'TC-1', target: 'api', fix_proposal_eligible: true },
    ]);
    writeJson(projectRoot, 'inspect/failure-analysis.json', {
      source_batch_id: 'batch-1',
      failures: [{ case_id: 'TC-1', target: 'api', fix_proposal_eligible: true }],
    });
    seedProposal(projectRoot);

    expect(deriveHealingState(projectRoot, changeId).status).toBe('pending');
  });

  it('derives applied when every current target has a current recorded summary and safety passes', () => {
    seedBatch(projectRoot);
    const proposalFile = seedProposal(projectRoot, ['api', 'e2e']);
    const proposalSha = sha256File(proposalFile)!;
    seedSummary(projectRoot, 'api');
    seedSummary(projectRoot, 'e2e');
    recordSummaryEvent(projectRoot, 'api', proposalSha);
    recordSummaryEvent(projectRoot, 'e2e', proposalSha);
    seedSafety(projectRoot, proposalSha);

    expect(deriveHealingState(projectRoot, changeId)).toMatchObject({
      status: 'applied',
      attempts_used: 1,
    });
  });

  it('ignores a summary changed after its latest record-apply event', () => {
    seedBatch(projectRoot);
    const proposalFile = seedProposal(projectRoot);
    const proposalSha = sha256File(proposalFile)!;
    const summaryFile = seedSummary(projectRoot, 'api');
    recordSummaryEvent(projectRoot, 'api', proposalSha);
    fs.appendFileSync(summaryFile, '\n');
    seedSafety(projectRoot, proposalSha);

    expect(deriveHealingState(projectRoot, changeId).status).toBe('proposal_created');
  });

  it('accepts risk only when the decision is bound to the current safety check sha', () => {
    seedBatch(projectRoot);
    const proposalFile = seedProposal(projectRoot);
    const proposalSha = sha256File(proposalFile)!;
    seedSummary(projectRoot, 'api');
    recordSummaryEvent(projectRoot, 'api', proposalSha);
    const safetyFile = seedSafety(projectRoot, proposalSha, 'batch-1', 'batch-1', {
      passed: false,
      needs_review: true,
    });
    appendEvent(projectRoot, {
      source: 'decide',
      type: 'human_decision',
      checkpoint: 'healing.safety',
      action: 'accept_risk',
      reason: 'reviewed',
      who: 'qa',
      review_file: 'healing/fixer-safety-check.json',
      review_sha256: 'stale',
    });
    expect(deriveHealingState(projectRoot, changeId).status).toBe('proposal_created');

    appendEvent(projectRoot, {
      source: 'decide',
      type: 'human_decision',
      checkpoint: 'healing.safety',
      action: 'accept_risk',
      reason: 'reviewed current check',
      who: 'qa',
      review_file: 'healing/fixer-safety-check.json',
      review_sha256: sha256File(safetyFile),
    });
    expect(deriveHealingState(projectRoot, changeId).status).toBe('applied');
  });

  it('invalidates paused safety evidence when tests change before accept_risk', () => {
    fs.mkdirSync(path.join(projectRoot, 'tests', 'api'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'tests', 'api', 'test_fix.py'), 'before\n');
    seedBatch(projectRoot);
    const proposalFile = seedProposal(projectRoot);
    const proposalSha = sha256File(proposalFile)!;
    seedSummary(projectRoot, 'api');
    recordSummaryEvent(projectRoot, 'api', proposalSha);
    const safetyFile = seedSafety(projectRoot, proposalSha, 'batch-1', 'batch-1', {
      passed: false,
      needs_review: true,
    });
    const acceptedSha = sha256File(safetyFile);

    fs.writeFileSync(path.join(projectRoot, 'tests', 'api', 'test_fix.py'), 'mutated while paused\n');
    appendEvent(projectRoot, {
      source: 'decide',
      type: 'human_decision',
      checkpoint: 'healing.safety',
      action: 'accept_risk',
      reason: 'accepted stale review',
      who: 'qa',
      review_file: 'healing/fixer-safety-check.json',
      review_sha256: acceptedSha,
    });

    expect(deriveHealingState(projectRoot, changeId).status).toBe('proposal_created');
    expect(() => pinHealingAppliedTestTree(projectRoot, changeId)).toThrow(
      /CURRENT-SAFETY/,
    );
  });

  it('counts one api plus e2e application for the same proposal identity as one attempt', () => {
    seedBatch(projectRoot);
    const proposalFile = seedProposal(projectRoot, ['api', 'e2e']);
    const proposalSha = sha256File(proposalFile)!;
    seedSummary(projectRoot, 'api');
    seedSummary(projectRoot, 'e2e');
    recordSummaryEvent(projectRoot, 'api', proposalSha);
    recordSummaryEvent(projectRoot, 'e2e', proposalSha);

    expect(deriveHealingState(projectRoot, changeId).attempts_used).toBe(1);
  });

  it('derives all_fixers_no_op only from complete current no-op summaries', () => {
    seedBatch(projectRoot);
    const proposalFile = seedProposal(projectRoot, ['api', 'e2e']);
    const proposalSha = sha256File(proposalFile)!;
    seedSummary(projectRoot, 'api', true);
    recordSummaryEvent(projectRoot, 'api', proposalSha);
    expect(deriveHealingState(projectRoot, changeId).all_fixers_no_op).toBe(false);

    seedSummary(projectRoot, 'e2e', true);
    recordSummaryEvent(projectRoot, 'e2e', proposalSha);
    expect(deriveHealingState(projectRoot, changeId).all_fixers_no_op).toBe(true);
  });

  it('counts two distinct proposal identities as two attempts', () => {
    seedBatch(projectRoot);
    const firstProposal = seedProposal(projectRoot);
    const firstSha = sha256File(firstProposal)!;
    seedSummary(projectRoot, 'api');
    recordSummaryEvent(projectRoot, 'api', firstSha);

    fs.writeFileSync(firstProposal, JSON.stringify({
      source_batch_id: 'batch-1',
      source_analysis_sha256: sha256File(
        path.join(changeDir(projectRoot), 'inspect/failure-analysis.json'),
      ),
      summary: { eligible_count: 1 },
      revision: 2,
      proposals: [{
        proposal_id: 'FIX-API-1',
        target: 'api',
        eligible: true,
        files_to_modify: ['tests/api/test_fix.py'],
      }],
    }, null, 2));
    const secondSha = sha256File(firstProposal)!;
    seedSummary(projectRoot, 'api');
    recordSummaryEvent(projectRoot, 'api', secondSha);

    expect(deriveHealingState(projectRoot, changeId).attempts_used).toBe(2);
  });

  it('does not apply a new attempt using a stale passing safety file', () => {
    seedBatch(projectRoot);
    const proposalFile = seedProposal(projectRoot, ['api'], 'batch-1', { revision: 1 });
    const firstSha = sha256File(proposalFile)!;
    seedSummary(projectRoot, 'api');
    recordSummaryEvent(projectRoot, 'api', firstSha);
    seedSafety(projectRoot, firstSha);
    expect(deriveHealingState(projectRoot, changeId).status).toBe('applied');

    seedProposal(projectRoot, ['api'], 'batch-1', { revision: 2 });
    const secondSha = sha256File(proposalFile)!;
    seedSummary(projectRoot, 'api');
    recordSummaryEvent(projectRoot, 'api', secondSha);

    expect(deriveHealingState(projectRoot, changeId).status).toBe('proposal_created');
  });

  it('applies a later rerun batch using the same healing episode entry baseline', () => {
    seedBatch(projectRoot, 'batch-2');
    const proposalFile = seedProposal(projectRoot, ['api'], 'batch-2');
    const proposalSha = sha256File(proposalFile)!;
    seedSummary(projectRoot, 'api');
    recordSummaryEvent(projectRoot, 'api', proposalSha, 'batch-2');
    seedSafety(projectRoot, proposalSha, 'batch-2', 'batch-1');

    expect(deriveHealingState(projectRoot, changeId).status).toBe('applied');
  });

  it('ignores an old proposal after analysis is refreshed to a new batch', () => {
    seedBatch(projectRoot, 'batch-1', [
      { case_id: 'TC-1', target: 'api', fix_proposal_eligible: true },
    ]);
    seedProposal(projectRoot, ['api'], 'batch-1');
    seedBatch(projectRoot, 'batch-2', [
      { case_id: 'TC-1', target: 'api', fix_proposal_eligible: true },
    ]);

    expect(deriveHealingState(projectRoot, changeId).status).toBe('pending');
  });

  it('ignores a stale proposal after same-batch analysis content changes', () => {
    seedBatch(projectRoot, 'batch-1', [
      { case_id: 'TC-1', target: 'api', fix_proposal_eligible: true },
    ]);
    seedProposal(projectRoot);
    writeJson(projectRoot, 'inspect/failure-analysis.json', {
      source_batch_id: 'batch-1',
      failures: [
        { case_id: 'TC-2', target: 'api', fix_proposal_eligible: true, category: 'test_code_error' },
      ],
    });

    expect(deriveHealingState(projectRoot, changeId).status).toBe('pending');
  });

  it('ignores a judgment bound to an older proposal identity', () => {
    seedBatch(projectRoot);
    const proposalFile = seedProposal(projectRoot, ['api'], 'batch-1', { revision: 1 });
    const firstSha = sha256File(proposalFile)!;
    seedSummary(projectRoot, 'api');
    recordSummaryEvent(projectRoot, 'api', firstSha);
    appendEvent(projectRoot, {
      source: 'status',
      type: 'heal_transition',
      from: 'applied',
      to: 'failed',
      source_batch_id: 'batch-1',
      proposal_sha256: firstSha,
      attempt_key: `${firstSha}:batch-1`,
    });
    expect(deriveHealingState(projectRoot, changeId).status).toBe('failed');

    seedProposal(projectRoot, ['api'], 'batch-1', { revision: 2 });

    expect(deriveHealingState(projectRoot, changeId).status).toBe('proposal_created');
  });

  it('uses event sequence rather than a future timestamp for judgment ordering', () => {
    seedBatch(projectRoot);
    const proposalFile = seedProposal(projectRoot);
    const proposalSha = sha256File(proposalFile)!;
    seedSummary(projectRoot, 'api');
    appendEvent(projectRoot, {
      source: 'status',
      type: 'heal_transition',
      from: 'applied',
      to: 'failed',
      source_batch_id: 'batch-1',
      proposal_sha256: proposalSha,
      attempt_key: `${proposalSha}:batch-1`,
      ts: '2999-01-01T00:00:00.000Z',
    });
    recordSummaryEvent(projectRoot, 'api', proposalSha);
    seedSafety(projectRoot, proposalSha);

    expect(deriveHealingState(projectRoot, changeId).status).toBe('applied');
  });
});
