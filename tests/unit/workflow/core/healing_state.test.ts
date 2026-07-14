import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { execSync } from 'child_process';
import { readEvents } from '../../../../src/workflow/core/events';
import { hashTestTree, sha256File } from '../../../../src/utils/hash';
import {
  assertRerunReasonIfNeeded,
  recordApplySummary,
  transitionHealingStatus,
} from '../../../../src/workflow/core/healing_state';

const changeId = 'REQ-HEAL-001';

function changeDir(root: string): string {
  return path.join(root, 'qa', 'changes', changeId);
}

function writeManifest(root: string, manifest: Record<string, unknown>): void {
  const file = path.join(changeDir(root), 'execution', 'execution-manifest.yaml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml.dump(manifest), 'utf-8');
}

function writeProposal(root: string, files = ['tests/api/test.py'], sourceBatchId = 'b1'): void {
  const file = path.join(changeDir(root), 'healing', 'fix-proposal.json');
  const analysisFile = path.join(changeDir(root), 'inspect', 'failure-analysis.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    source_batch_id: sourceBatchId,
    source_analysis_sha256: sha256File(analysisFile),
    summary: { eligible_count: 1 },
    proposals: [{
      proposal_id: 'FIX-API-001',
      target: 'api',
      eligible: true,
      files_to_modify: files,
      patch_plan: [{ file: files[0], operation: 'fix_request_payload' }],
    }],
  }), 'utf-8');
}

function writeAnalysis(root: string, sourceBatchId = 'b1'): void {
  const file = path.join(changeDir(root), 'inspect', 'failure-analysis.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    source_batch_id: sourceBatchId,
    failures: [{ case_id: 'TC-1', target: 'api', fix_proposal_eligible: true }],
  }));
}

describe('healing core regressions', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-heal-core-'));
    execSync('git init -q', { cwd: projectRoot });
    fs.mkdirSync(changeDir(projectRoot), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('requires a rerun reason after execution outside healing', () => {
    writeManifest(projectRoot, { batch_id: 'b1' });
    expect(() => assertRerunReasonIfNeeded(projectRoot, changeId, undefined)).toThrow(
      'RERUN-REASON-REQUIRED',
    );
    expect(() => assertRerunReasonIfNeeded(projectRoot, changeId, 'manual verification')).not.toThrow();
  });

  it('records standard apply evidence with proposal identity', () => {
    fs.mkdirSync(path.join(projectRoot, 'tests', 'api'), { recursive: true });
    const testFile = path.join(projectRoot, 'tests', 'api', 'test.py');
    fs.writeFileSync(testFile, 'old\n', 'utf-8');
    const baseline = hashTestTree(projectRoot);
    writeManifest(projectRoot, {
      batch_id: 'b1',
      test_files_sha256: baseline.files,
      tests_tree_sha256: baseline.aggregate,
    });
    writeAnalysis(projectRoot);
    writeProposal(projectRoot);
    fs.writeFileSync(testFile, 'new\n', 'utf-8');

    const result = recordApplySummary(projectRoot, changeId, 'api', ['FIX-API-001']);

    expect(result.modifiedFiles).toEqual(['tests/api/test.py']);
    const event = readEvents(projectRoot, changeId).find(item => item.type === 'heal_record_apply');
    expect(event).toMatchObject({
      type: 'heal_record_apply',
      target: 'api',
      source_batch_id: 'b1',
      applied_proposals: ['FIX-API-001'],
      attempt_key: expect.stringMatching(/^[a-f0-9]{64}:b1$/),
      proposal_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      summary_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it('rejects changed target files not authorized by the selected proposal', () => {
    fs.mkdirSync(path.join(projectRoot, 'tests', 'api'), { recursive: true });
    const selected = path.join(projectRoot, 'tests', 'api', 'test.py');
    const other = path.join(projectRoot, 'tests', 'api', 'other.py');
    fs.writeFileSync(selected, 'old\n', 'utf-8');
    fs.writeFileSync(other, 'old\n', 'utf-8');
    const baseline = hashTestTree(projectRoot);
    writeManifest(projectRoot, {
      batch_id: 'b1',
      test_files_sha256: baseline.files,
      tests_tree_sha256: baseline.aggregate,
    });
    writeAnalysis(projectRoot);
    writeProposal(projectRoot);
    fs.writeFileSync(other, 'new\n', 'utf-8');

    expect(() => recordApplySummary(projectRoot, changeId, 'api', ['FIX-API-001'])).toThrow(
      'not authorized by selected proposals',
    );
  });

  it('ignores another layer adapter during API record-apply', () => {
    const apiAdapter = path.join(projectRoot, 'tests', 'api', 'adapters', 'role.py');
    const e2eAdapter = path.join(projectRoot, 'tests', 'e2e', 'adapters', 'role.py');
    fs.mkdirSync(path.dirname(apiAdapter), { recursive: true });
    fs.mkdirSync(path.dirname(e2eAdapter), { recursive: true });
    fs.writeFileSync(apiAdapter, 'old\n');
    fs.writeFileSync(e2eAdapter, 'old\n');
    const baseline = hashTestTree(projectRoot);
    writeManifest(projectRoot, {
      batch_id: 'b1',
      test_files_sha256: baseline.files,
      tests_tree_sha256: baseline.aggregate,
    });
    writeAnalysis(projectRoot);
    writeProposal(projectRoot, ['tests/api/adapters/role.py']);
    fs.writeFileSync(apiAdapter, 'new\n');
    fs.writeFileSync(e2eAdapter, 'new\n');

    expect(recordApplySummary(projectRoot, changeId, 'api', ['FIX-API-001']).modifiedFiles)
      .toEqual(['tests/api/adapters/role.py']);
  });

  it('allows an explicitly selected shared domain factory during API record-apply', () => {
    const domainFactory = path.join(projectRoot, 'tests', 'testdata', 'domain', 'role.py');
    fs.mkdirSync(path.dirname(domainFactory), { recursive: true });
    fs.writeFileSync(domainFactory, 'old\n');
    const baseline = hashTestTree(projectRoot);
    writeManifest(projectRoot, {
      batch_id: 'b1',
      test_files_sha256: baseline.files,
      tests_tree_sha256: baseline.aggregate,
    });
    writeAnalysis(projectRoot);
    writeProposal(projectRoot, ['tests/testdata/domain/role.py']);
    fs.writeFileSync(domainFactory, 'new\n');

    expect(recordApplySummary(projectRoot, changeId, 'api', ['FIX-API-001']).modifiedFiles)
      .toEqual(['tests/testdata/domain/role.py']);
  });

  it('rejects record-apply when the proposal is not bound to the active analysis batch', () => {
    fs.mkdirSync(path.join(projectRoot, 'tests', 'api'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'tests', 'api', 'test.py'), 'old\n');
    const baseline = hashTestTree(projectRoot);
    writeManifest(projectRoot, {
      batch_id: 'b1',
      test_files_sha256: baseline.files,
      tests_tree_sha256: baseline.aggregate,
    });
    writeAnalysis(projectRoot, 'b1');
    writeProposal(projectRoot, ['tests/api/test.py'], 'old-batch');

    expect(() => recordApplySummary(projectRoot, changeId, 'api', ['FIX-API-001'])).toThrow(
      /proposal source_batch_id/,
    );
  });

  it('rejects record-apply after same-batch analysis changes behind the proposal', () => {
    fs.mkdirSync(path.join(projectRoot, 'tests', 'api'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'tests', 'api', 'test.py'), 'old\n');
    const baseline = hashTestTree(projectRoot);
    writeManifest(projectRoot, {
      batch_id: 'b1',
      test_files_sha256: baseline.files,
      tests_tree_sha256: baseline.aggregate,
    });
    writeAnalysis(projectRoot);
    writeProposal(projectRoot);
    writeAnalysis(projectRoot);
    fs.appendFileSync(
      path.join(changeDir(projectRoot), 'inspect', 'failure-analysis.json'),
      '\n',
    );

    expect(() => recordApplySummary(projectRoot, changeId, 'api', ['FIX-API-001'])).toThrow(
      /source_analysis_sha256/,
    );
  });

  it('fails record-apply when authoritative event persistence fails', () => {
    fs.mkdirSync(path.join(projectRoot, 'tests', 'api'), { recursive: true });
    const testFile = path.join(projectRoot, 'tests', 'api', 'test.py');
    fs.writeFileSync(testFile, 'old\n');
    const baseline = hashTestTree(projectRoot);
    writeManifest(projectRoot, {
      batch_id: 'b1',
      test_files_sha256: baseline.files,
      tests_tree_sha256: baseline.aggregate,
    });
    writeAnalysis(projectRoot);
    writeProposal(projectRoot);
    fs.writeFileSync(testFile, 'new\n');
    fs.mkdirSync(path.join(changeDir(projectRoot), 'events.jsonl'));

    expect(() => recordApplySummary(projectRoot, changeId, 'api', ['FIX-API-001'])).toThrow();
  });

  it('records judgments with the active proposal and batch identity', () => {
    writeManifest(projectRoot, { batch_id: 'b1' });
    writeAnalysis(projectRoot);
    writeProposal(projectRoot);

    transitionHealingStatus(projectRoot, changeId, 'failed');

    expect(readEvents(projectRoot, changeId)).toContainEqual(expect.objectContaining({
      type: 'heal_transition',
      to: 'failed',
      source_batch_id: 'b1',
      proposal_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      attempt_key: expect.stringMatching(/^[a-f0-9]{64}:b1$/),
    }));
  });

  it('fails a judgment when authoritative event persistence fails', () => {
    writeManifest(projectRoot, { batch_id: 'b1' });
    writeAnalysis(projectRoot);
    writeProposal(projectRoot);
    fs.mkdirSync(path.join(changeDir(projectRoot), 'events.jsonl'));

    expect(() => transitionHealingStatus(projectRoot, changeId, 'failed')).toThrow();
  });
});
