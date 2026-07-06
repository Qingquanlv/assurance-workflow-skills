import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { hashTestTree } from '../../../src/core/hash';
import { assertTestTreeUnchangedOrHealing } from '../../../src/core/healing_state';
import { writeTestChangesOverrideEvidence } from '../../../src/core/override_evidence';

const changeId = 'REQ-RUN-INTEGRITY-001';

function changeDir(root: string): string {
  return path.join(root, 'qa', 'changes', changeId);
}

function writeState(root: string, healingStatus = 'pending'): void {
  const dir = changeDir(root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'workflow-state.yaml'),
    yaml.dump({ phases: { healing: { status: healingStatus, attempts: [] } } }),
    'utf-8',
  );
}

function writeLatestManifest(root: string, fields: Record<string, unknown>): void {
  const dir = path.join(changeDir(root), 'execution');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'execution-manifest.yaml'),
    yaml.dump({
      schema_version: '1.0',
      change_id: changeId,
      batch_id: '20260704-190000',
      selected_targets: { api: true, e2e: false, fuzz: false, performance: false },
      result_files: {},
      ...fields,
    }),
    'utf-8',
  );
}

describe('run integrity test tree guard', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-run-integrity-'));
    fs.mkdirSync(path.join(projectRoot, 'tests', 'api'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'tests', 'api', 'test_sample.py'), 'def test_a(): pass\n', 'utf-8');
    writeState(projectRoot);
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('hashes the tests tree and excludes pycache artifacts', () => {
    const initial = hashTestTree(projectRoot);
    fs.mkdirSync(path.join(projectRoot, 'tests', 'api', '__pycache__'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'tests', 'api', '__pycache__', 'test_sample.cpython-311.pyc'), 'binary', 'utf-8');
    fs.writeFileSync(path.join(projectRoot, 'tests', 'api', 'ignored.pyc'), 'binary', 'utf-8');
    expect(hashTestTree(projectRoot)).toEqual(initial);
  });

  it('allows a rerun when tests are unchanged', () => {
    const hash = hashTestTree(projectRoot);
    writeLatestManifest(projectRoot, {
      tests_tree_sha256: hash.aggregate,
      test_files_sha256: hash.files,
    });

    const result = assertTestTreeUnchangedOrHealing(projectRoot, changeId, false);
    expect(result.testsChanged).toBe(false);
  });

  it('rejects changed tests when healing has not been applied', () => {
    const hash = hashTestTree(projectRoot);
    writeLatestManifest(projectRoot, {
      tests_tree_sha256: hash.aggregate,
      test_files_sha256: hash.files,
    });
    fs.writeFileSync(path.join(projectRoot, 'tests', 'api', 'test_sample.py'), 'def test_a(): assert True\n', 'utf-8');

    expect(() => assertTestTreeUnchangedOrHealing(projectRoot, changeId, false)).toThrow(
      /TESTS-CHANGED-WITHOUT-HEALING/,
    );
  });

  it('allows changed tests when healing status is applied', () => {
    const hash = hashTestTree(projectRoot);
    writeLatestManifest(projectRoot, {
      tests_tree_sha256: hash.aggregate,
      test_files_sha256: hash.files,
    });
    writeState(projectRoot, 'applied');
    fs.writeFileSync(path.join(projectRoot, 'tests', 'api', 'test_sample.py'), 'def test_a(): assert True\n', 'utf-8');

    const result = assertTestTreeUnchangedOrHealing(projectRoot, changeId, false);
    expect(result.testsChanged).toBe(true);
    expect(result.changedFiles.map(f => f.path)).toContain('tests/api/test_sample.py');
    expect(result.changedFiles).toEqual([
      expect.objectContaining({
        path: 'tests/api/test_sample.py',
        change_type: 'modified',
        old_sha256: hash.files['tests/api/test_sample.py'],
        new_sha256: expect.any(String),
      }),
    ]);
  });

  it('allows changed tests with an explicit human override flag', () => {
    const hash = hashTestTree(projectRoot);
    writeLatestManifest(projectRoot, {
      tests_tree_sha256: hash.aggregate,
      test_files_sha256: hash.files,
    });
    fs.writeFileSync(path.join(projectRoot, 'tests', 'api', 'test_new.py'), 'def test_b(): pass\n', 'utf-8');

    const result = assertTestTreeUnchangedOrHealing(projectRoot, changeId, true);
    expect(result.testsChanged).toBe(true);
    expect(result.changedFiles).toEqual([
      expect.objectContaining({
        path: 'tests/api/test_new.py',
        change_type: 'added',
        old_sha256: null,
        new_sha256: expect.any(String),
      }),
    ]);
  });

  it('reports deleted files in structured test tree diffs', () => {
    const hash = hashTestTree(projectRoot);
    writeLatestManifest(projectRoot, {
      tests_tree_sha256: hash.aggregate,
      test_files_sha256: hash.files,
    });
    fs.rmSync(path.join(projectRoot, 'tests', 'api', 'test_sample.py'));

    const result = assertTestTreeUnchangedOrHealing(projectRoot, changeId, true);
    expect(result.changedFiles).toEqual([
      {
        path: 'tests/api/test_sample.py',
        change_type: 'deleted',
        old_sha256: hash.files['tests/api/test_sample.py'],
        new_sha256: null,
      },
    ]);
  });

  it('writes test changes override evidence with a stable sha256', () => {
    const hash = hashTestTree(projectRoot);
    writeLatestManifest(projectRoot, {
      tests_tree_sha256: hash.aggregate,
      test_files_sha256: hash.files,
    });
    fs.writeFileSync(path.join(projectRoot, 'tests', 'api', 'test_new.py'), 'def test_b(): pass\n', 'utf-8');
    const integrity = assertTestTreeUnchangedOrHealing(projectRoot, changeId, true);
    const batchDir = path.join(changeDir(projectRoot), 'execution', 'runs', '20260706-010203');
    fs.mkdirSync(batchDir, { recursive: true });

    const evidence = writeTestChangesOverrideEvidence({
      projectRoot,
      changeId,
      batchId: '20260706-010203',
      batchDir,
      reason: 'human approved test update',
      integrity,
      createdAt: '2026-07-06T00:00:00.000Z',
    });

    expect(evidence.changedFilesCount).toBe(1);
    expect(evidence.relPath).toBe('execution/runs/20260706-010203/test-changes-override.json');
    expect(fs.existsSync(evidence.absPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(evidence.absPath, 'utf-8'));
    expect(parsed.changed_files).toEqual([
      expect.objectContaining({ path: 'tests/api/test_new.py', change_type: 'added' }),
    ]);
    expect(evidence.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('fails open once for old manifests without test tree hashes', () => {
    writeLatestManifest(projectRoot, {});
    fs.writeFileSync(path.join(projectRoot, 'tests', 'api', 'test_sample.py'), 'def test_a(): assert True\n', 'utf-8');

    const result = assertTestTreeUnchangedOrHealing(projectRoot, changeId, false);
    expect(result.testsChanged).toBe(false);
  });
});
