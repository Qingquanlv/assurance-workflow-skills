import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
  pinHealingAppliedTestTree,
  pinHealingEntryBaseline,
  writeCliFixerSafetyCheck,
} from '../../../src/core/healing_state';
import { appendEventsStrict, readEvents } from '../../../src/core/events';
import { hashTestTree, sha256File } from '../../../src/core/hash';

const changeId = 'REQ-HEAL-BASELINE';

function changeDir(root: string): string {
  return path.join(root, 'qa', 'changes', changeId);
}

function writeManifest(root: string, batchId: string): void {
  const file = path.join(changeDir(root), 'execution', 'execution-manifest.yaml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tests = hashTestTree(root);
  fs.writeFileSync(file, yaml.dump({
    batch_id: batchId,
    tests_tree_sha256: tests.aggregate,
    test_files_sha256: tests.files,
  }));
}

function writeProposal(root: string, batchId = 'batch-1'): void {
  const file = path.join(changeDir(root), 'healing', 'fix-proposal.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const analysis = path.join(changeDir(root), 'inspect', 'failure-analysis.json');
  fs.mkdirSync(path.dirname(analysis), { recursive: true });
  fs.writeFileSync(analysis, JSON.stringify({
    source_batch_id: batchId,
    failures: [{ case_id: 'TC-1', target: 'api', fix_proposal_eligible: true }],
  }));
  fs.writeFileSync(file, JSON.stringify({
    source_batch_id: batchId,
    source_analysis_sha256: sha256File(analysis),
    summary: { eligible_count: 1 },
    proposals: [{
      proposal_id: 'FIX-API-1',
      target: 'api',
      eligible: true,
      risk_level: 'low',
      files_to_modify: ['tests/api/test_fix.py'],
    }],
  }));
}

describe('healing entry baseline', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-heal-baseline-'));
    fs.mkdirSync(path.join(projectRoot, 'tests', 'api'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'tests', 'e2e'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'tests', 'api', 'test_fix.py'), 'before\n');
    writeManifest(projectRoot, 'batch-1');
    // Legal post-execution codegen output exists before healing enters.
    fs.writeFileSync(path.join(projectRoot, 'tests', 'e2e', 'test_codegen.py'), 'generated\n');
    writeProposal(projectRoot);
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('does not flag pre-entry e2e codegen when only the proposal api file changes', () => {
    pinHealingEntryBaseline(projectRoot, changeId);
    fs.writeFileSync(path.join(projectRoot, 'tests', 'api', 'test_fix.py'), 'fixed\n');

    const safety = writeCliFixerSafetyCheck(projectRoot, changeId);

    expect(safety.unrelated_tests_modified).toBe(false);
    expect(safety.unrelated_test_files).toEqual([]);
  });

  it('flags a non-proposal test changed after entry', () => {
    pinHealingEntryBaseline(projectRoot, changeId);
    fs.writeFileSync(path.join(projectRoot, 'tests', 'e2e', 'test_codegen.py'), 'tampered\n');

    const safety = writeCliFixerSafetyCheck(projectRoot, changeId);

    expect(safety.unrelated_tests_modified).toBe(true);
    expect(safety.unrelated_test_files).toEqual(['tests/e2e/test_codegen.py']);
  });

  it('pins once and never overwrites the entry baseline', () => {
    const first = pinHealingEntryBaseline(projectRoot, changeId);
    fs.writeFileSync(path.join(projectRoot, 'tests', 'e2e', 'test_codegen.py'), 'later\n');

    const second = pinHealingEntryBaseline(projectRoot, changeId);

    expect(second).toEqual(first);
    expect(second.test_files_sha256).toEqual(first.test_files_sha256);
  });

  it('keeps one entry baseline across rerun batches in the same healing episode', () => {
    const first = pinHealingEntryBaseline(projectRoot, changeId);
    fs.writeFileSync(path.join(projectRoot, 'tests', 'api', 'test_fix.py'), 'attempt 1\n');
    writeManifest(projectRoot, 'batch-2');
    writeProposal(projectRoot, 'batch-2');

    const second = pinHealingEntryBaseline(projectRoot, changeId);
    const safety = writeCliFixerSafetyCheck(projectRoot, changeId);

    expect(second).toEqual(first);
    expect(safety.baseline_batch_id).toBe('batch-1');
    expect(safety.healing_episode_id).toBe(first.episode_id);
  });

  it('strictly records the pinned baseline identity and refreshes after a terminal judgment', () => {
    const first = pinHealingEntryBaseline(projectRoot, changeId);
    const baselinePath = path.join(changeDir(projectRoot), 'healing', 'entry-baseline.json');
    expect(readEvents(projectRoot, changeId)).toContainEqual(expect.objectContaining({
      type: 'healing_entry_baseline_pinned',
      artifact_sha256: sha256File(baselinePath),
      entry_batch_id: 'batch-1',
      episode_id: first.episode_id,
    }));

    appendEventsStrict(projectRoot, changeId, [{
      source: 'status',
      type: 'heal_transition',
      from: 'applied',
      to: 'failed',
      source_batch_id: 'batch-1',
    }]);
    fs.writeFileSync(path.join(projectRoot, 'tests', 'e2e', 'test_codegen.py'), 'new episode\n');
    writeManifest(projectRoot, 'batch-2');
    writeProposal(projectRoot, 'batch-2');

    const second = pinHealingEntryBaseline(projectRoot, changeId);

    expect(second.episode_id).not.toBe(first.episode_id);
    expect(second.batch_id).toBe('batch-2');
    expect(second.tests_tree_sha256).not.toBe(first.tests_tree_sha256);
  });

  it('fails pinning when the baseline event cannot be persisted', () => {
    const eventsFile = path.join(changeDir(projectRoot), 'events.jsonl');
    fs.writeFileSync(eventsFile, '');
    fs.chmodSync(eventsFile, 0o444);
    try {
      expect(() => pinHealingEntryBaseline(projectRoot, changeId)).toThrow();
    } finally {
      fs.chmodSync(eventsFile, 0o644);
    }
  });

  it('rejects safety when the pinned baseline artifact is tampered', () => {
    pinHealingEntryBaseline(projectRoot, changeId);
    fs.appendFileSync(
      path.join(changeDir(projectRoot), 'healing', 'entry-baseline.json'),
      '\n',
    );

    expect(() => writeCliFixerSafetyCheck(projectRoot, changeId)).toThrow(
      /BASELINE-EVIDENCE-MISMATCH/,
    );
  });

  it('fails closed when healing safety runs without an entry baseline', () => {
    expect(() => writeCliFixerSafetyCheck(projectRoot, changeId)).toThrow(
      'HEALING-ENTRY-BASELINE-MISSING',
    );
  });

  it('rejects an applied rerun tree pin before current safety evidence applies', () => {
    pinHealingEntryBaseline(projectRoot, changeId);
    fs.writeFileSync(path.join(projectRoot, 'tests', 'api', 'test_fix.py'), 'fixed\n');

    expect(() => pinHealingAppliedTestTree(projectRoot, changeId)).toThrow(
      /CURRENT-SAFETY/,
    );
    expect(fs.existsSync(
      path.join(changeDir(projectRoot), 'healing', 'applied-test-tree.json'),
    )).toBe(false);
  });
});
