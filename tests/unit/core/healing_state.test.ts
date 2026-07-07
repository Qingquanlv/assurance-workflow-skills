import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { execSync } from 'child_process';
import { readEvents } from '../../../src/core/events';
import { hashTestTree } from '../../../src/core/hash';
import {
  assertHealingRunAllowed,
  assertRerunReasonIfNeeded,
  assertTestTreeUnchangedOrHealing,
  transitionHealingStatus,
} from '../../../src/core/healing_state';

const changeId = 'REQ-HEAL-001';

function changeDir(root: string): string {
  return path.join(root, 'qa', 'changes', changeId);
}

function writeState(root: string, state: unknown): void {
  fs.mkdirSync(changeDir(root), { recursive: true });
  fs.writeFileSync(path.join(changeDir(root), 'workflow-state.yaml'), yaml.dump(state), 'utf-8');
}

function readState(root: string): any {
  return yaml.load(fs.readFileSync(path.join(changeDir(root), 'workflow-state.yaml'), 'utf-8'));
}

describe('healing state transitions', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-heal-'));
    writeState(projectRoot, { phases: { healing: { status: 'pending', attempts: [] } } });
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('rejects illegal pending → resolved transition', () => {
    expect(() => transitionHealingStatus(projectRoot, changeId, 'resolved')).toThrow(
      'HEAL-TRANSITION-ILLEGAL: pending → resolved',
    );
  });

  it('requires fix-proposal.json for pending → proposal_created', () => {
    expect(() => transitionHealingStatus(projectRoot, changeId, 'proposal_created')).toThrow(
      'healing/fix-proposal.json missing or invalid',
    );
  });

  it('creates attempts[0] on pending → proposal_created', () => {
    fs.mkdirSync(path.join(changeDir(projectRoot), 'healing'), { recursive: true });
    fs.writeFileSync(
      path.join(changeDir(projectRoot), 'healing', 'fix-proposal.json'),
      JSON.stringify({ summary: { eligible_count: 1 }, proposals: [] }),
      'utf-8',
    );

    const result = transitionHealingStatus(projectRoot, changeId, 'proposal_created');
    expect(result).toEqual({ from: 'pending', to: 'proposal_created' });
    expect(readState(projectRoot).phases.healing.attempts).toHaveLength(1);
    expect(readEvents(projectRoot, changeId).some(e => e.type === 'heal_transition')).toBe(true);
  });

  it('requires apply-summary for proposal_created → applied', () => {
    writeState(projectRoot, {
      phases: { healing: { status: 'proposal_created', attempts: [{ attempt: 1 }] } },
    });
    expect(() => transitionHealingStatus(projectRoot, changeId, 'applied')).toThrow(
      'applied requires at least one apply-summary',
    );
  });

  it('blocks healing rerun when status is pending', () => {
    expect(() => assertHealingRunAllowed(projectRoot, changeId)).not.toThrow();

    fs.mkdirSync(path.join(changeDir(projectRoot), 'healing'), { recursive: true });
    fs.writeFileSync(
      path.join(changeDir(projectRoot), 'healing', 'api-apply-summary.json'),
      JSON.stringify({ files_modified: ['tests/api/test.py'] }),
      'utf-8',
    );

    expect(() => assertHealingRunAllowed(projectRoot, changeId)).toThrow('HEAL-STATE-REQUIRED');
  });

  it('requires rerun reason when execution already completed outside healing', () => {
    writeState(projectRoot, {
      phases: {
        healing: { status: 'pending' },
        execution: { status: 'PASS', batch_id: 'batch-001' },
      },
    });
    expect(() => assertRerunReasonIfNeeded(projectRoot, changeId, undefined)).toThrow(
      'RERUN-REASON-REQUIRED',
    );
    expect(() => assertRerunReasonIfNeeded(projectRoot, changeId, 'manual verification')).not.toThrow();
  });
});

function writeProposal(root: string, extra: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.join(changeDir(root), 'healing'), { recursive: true });
  fs.writeFileSync(
    path.join(changeDir(root), 'healing', 'fix-proposal.json'),
    JSON.stringify({ summary: { eligible_count: 1 }, proposals: [], ...extra }),
    'utf-8',
  );
}

function writeManifest(root: string, manifest: Record<string, unknown>): void {
  fs.mkdirSync(path.join(changeDir(root), 'execution'), { recursive: true });
  fs.writeFileSync(
    path.join(changeDir(root), 'execution', 'execution-manifest.yaml'),
    yaml.dump(manifest),
    'utf-8',
  );
}

function writeAnalysis(root: string, analysis: Record<string, unknown>): void {
  fs.mkdirSync(path.join(changeDir(root), 'inspect'), { recursive: true });
  fs.writeFileSync(
    path.join(changeDir(root), 'inspect', 'failure-analysis.json'),
    JSON.stringify(analysis),
    'utf-8',
  );
}

describe('healing loop-back (applied → proposal_created)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-heal-loop-'));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('rejects loop-back before healing-rerun ran', () => {
    writeState(projectRoot, {
      phases: { healing: { status: 'applied', attempts: [{ attempt: 1 }] } },
    });
    writeProposal(projectRoot);
    expect(() => transitionHealingStatus(projectRoot, changeId, 'proposal_created')).toThrow(
      'healing-rerun must be done before healing.status=proposal_created',
    );
  });

  it('rejects loop-back when attempts budget is exhausted (default max 3)', () => {
    writeState(projectRoot, {
      phases: {
        healing: { status: 'applied', attempts: [{ attempt: 1 }, { attempt: 2 }, { attempt: 3 }] },
        healing_rerun: { status: 'FAIL', batch_id: 'b2' },
      },
    });
    writeProposal(projectRoot);
    expect(() => transitionHealingStatus(projectRoot, changeId, 'proposal_created')).toThrow(
      'HEAL-ATTEMPTS-EXHAUSTED',
    );
  });

  it('rejects a stale proposal whose analysis targets an older batch', () => {
    writeState(projectRoot, {
      phases: {
        healing: { status: 'applied', attempts: [{ attempt: 1 }] },
        healing_rerun: { status: 'FAIL', batch_id: 'b2' },
      },
    });
    writeProposal(projectRoot);
    writeManifest(projectRoot, { batch_id: 'b2' });
    writeAnalysis(projectRoot, { source_batch_id: 'b1', failures: [] });
    expect(() => transitionHealingStatus(projectRoot, changeId, 'proposal_created')).toThrow(
      'PROPOSAL-STALE',
    );
  });

  it('allocates attempt N+1 and closes the previous attempt on loop-back', () => {
    writeState(projectRoot, {
      phases: {
        healing: {
          status: 'applied',
          attempts: [{ attempt: 1, resolved: null }],
          applied_tests_tree_sha256: 'deadbeef',
        },
        healing_rerun: { status: 'FAIL', batch_id: 'b2' },
      },
    });
    writeProposal(projectRoot);
    writeManifest(projectRoot, { batch_id: 'b2' });
    writeAnalysis(projectRoot, { source_batch_id: 'b2', failures: [] });

    const result = transitionHealingStatus(projectRoot, changeId, 'proposal_created');
    expect(result).toEqual({ from: 'applied', to: 'proposal_created' });
    const healing = readState(projectRoot).phases.healing;
    expect(healing.attempts).toHaveLength(2);
    expect(healing.attempts[0].resolved).toBe('unresolved');
    expect(healing.attempts[1].attempt).toBe(2);
    expect(healing.applied_tests_tree_sha256).toBeUndefined();
  });
});

describe('applied authorization pinning', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-heal-pin-'));
    execSync('git init -q', { cwd: projectRoot });
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('requires an apply-summary for every eligible proposal target', () => {
    writeState(projectRoot, {
      phases: { healing: { status: 'proposal_created', attempts: [{ attempt: 1 }] } },
    });
    writeProposal(projectRoot, {
      proposals: [
        { proposal_id: 'FIX-API-001', target: 'api', eligible: true, files_to_modify: [] },
        { proposal_id: 'FIX-E2E-001', target: 'e2e', eligible: true, files_to_modify: [] },
      ],
    });
    fs.writeFileSync(
      path.join(changeDir(projectRoot), 'healing', 'api-apply-summary.json'),
      JSON.stringify({ files_modified: ['tests/api/test.py'] }),
      'utf-8',
    );
    expect(() => transitionHealingStatus(projectRoot, changeId, 'applied')).toThrow(
      'applied requires healing/e2e-apply-summary.json',
    );
  });

  it('pins the current test tree on proposal_created → applied', () => {
    writeState(projectRoot, {
      phases: { healing: { status: 'proposal_created', attempts: [{ attempt: 1 }] } },
    });
    writeProposal(projectRoot, {
      proposals: [
        { proposal_id: 'FIX-API-001', target: 'api', eligible: true, files_to_modify: [] },
      ],
    });
    fs.writeFileSync(
      path.join(changeDir(projectRoot), 'healing', 'api-apply-summary.json'),
      JSON.stringify({ files_modified: ['tests/api/test.py'] }),
      'utf-8',
    );

    const result = transitionHealingStatus(projectRoot, changeId, 'applied');
    expect(result).toEqual({ from: 'proposal_created', to: 'applied' });
    const healing = readState(projectRoot).phases.healing;
    expect(healing.applied_tests_tree_sha256).toBe(hashTestTree(projectRoot).aggregate);
  });

  it('rejects a run when tests were edited after heal --to applied', () => {
    writeManifest(projectRoot, {
      batch_id: 'b1',
      tests_tree_sha256: 'old-tree',
      test_files_sha256: {},
    });
    writeState(projectRoot, {
      phases: {
        healing: { status: 'applied', applied_tests_tree_sha256: 'pinned-other-tree' },
      },
    });
    expect(() => assertTestTreeUnchangedOrHealing(projectRoot, changeId, false)).toThrow(
      'HEAL-TREE-MISMATCH',
    );
  });

  it('accepts a run when the current tree matches the pinned tree', () => {
    const currentTree = hashTestTree(projectRoot).aggregate;
    writeManifest(projectRoot, {
      batch_id: 'b1',
      tests_tree_sha256: 'old-tree',
      test_files_sha256: {},
    });
    writeState(projectRoot, {
      phases: {
        healing: { status: 'applied', applied_tests_tree_sha256: currentTree },
      },
    });
    const result = assertTestTreeUnchangedOrHealing(projectRoot, changeId, false);
    expect(result.testsChanged).toBe(true);
  });
});
