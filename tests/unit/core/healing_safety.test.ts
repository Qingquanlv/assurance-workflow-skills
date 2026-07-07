import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { hashProductTree, hashTestTree } from '../../../src/core/hash';
import { transitionHealingStatus } from '../../../src/core/healing_state';

const changeId = 'REQ-HEAL-SAFETY-001';

function changeDir(root: string): string {
  return path.join(root, 'qa', 'changes', changeId);
}

function writeState(root: string): void {
  fs.mkdirSync(changeDir(root), { recursive: true });
  fs.writeFileSync(
    path.join(changeDir(root), 'workflow-state.yaml'),
    yaml.dump({ phases: { healing: { status: 'proposal_created', attempts: [{ attempt: 1 }] } } }),
    'utf-8',
  );
}

function writeManifest(root: string): void {
  const executionDir = path.join(changeDir(root), 'execution');
  fs.mkdirSync(executionDir, { recursive: true });
  const product = hashProductTree(root, ['app']);
  const tests = hashTestTree(root);
  fs.writeFileSync(
    path.join(executionDir, 'execution-manifest.yaml'),
    yaml.dump({
      schema_version: '1.0',
      change_id: changeId,
      batch_id: '20260706-010000',
      selected_targets: { api: true, e2e: false, fuzz: false, performance: false },
      result_files: {},
      product_tree_sha256: product.aggregate,
      tests_tree_sha256: tests.aggregate,
      test_files_sha256: tests.files,
    }),
    'utf-8',
  );
}

function writeHealingArtifacts(root: string): void {
  const healingDir = path.join(changeDir(root), 'healing');
  fs.mkdirSync(healingDir, { recursive: true });
  fs.writeFileSync(
    path.join(healingDir, 'fix-proposal.json'),
    JSON.stringify({
      summary: { eligible_count: 1 },
      proposals: [{ id: 'p1', risk_level: 'low', files_to_modify: ['tests/api/test_sample.py'] }],
    }),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(healingDir, 'api-apply-summary.json'),
    JSON.stringify({ files_modified: ['tests/api/test_sample.py'] }),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(healingDir, 'fixer-safety-check.json'),
    JSON.stringify({ passed: true, product_code_modified: false }),
    'utf-8',
  );
}

describe('CLI-computed fixer safety check', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-heal-safety-'));
    fs.mkdirSync(path.join(projectRoot, 'app'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'tests', 'api'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'app', 'service.py'), 'VALUE = 1\n', 'utf-8');
    fs.writeFileSync(path.join(projectRoot, 'tests', 'api', 'test_sample.py'), 'def test_a(): pass\n', 'utf-8');
    writeState(projectRoot);
    writeManifest(projectRoot);
    writeHealingArtifacts(projectRoot);
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('overwrites agent-authored safety check and rejects product code changes', () => {
    fs.writeFileSync(path.join(projectRoot, 'app', 'service.py'), 'VALUE = 2\n', 'utf-8');

    expect(() => transitionHealingStatus(projectRoot, changeId, 'applied')).toThrow(/fixer-safety-check/);

    const safety = JSON.parse(
      fs.readFileSync(path.join(changeDir(projectRoot), 'healing', 'fixer-safety-check.json'), 'utf-8'),
    );
    expect(safety.passed).toBe(false);
    expect(safety.product_code_modified).toBe(true);
    expect(safety.source).toBe('cli');
  });

  it('flags added bare returns in tests as needs_review (assertion-bypass early exit)', () => {
    const safety = JSON.parse(
      fs.readFileSync(path.join(changeDir(projectRoot), 'healing', 'fixer-safety-check.json'), 'utf-8'),
    );
    // Not a git repo in tmpdir — diff is unavailable, so the check must be
    // conservative: bare_return_added is 'undetermined' and needs_review true.
    expect(() => transitionHealingStatus(projectRoot, changeId, 'applied')).toThrow(/needs_review|fixer-safety-check/);
    const written = JSON.parse(
      fs.readFileSync(path.join(changeDir(projectRoot), 'healing', 'fixer-safety-check.json'), 'utf-8'),
    );
    expect(written.bare_return_added).toBe('undetermined');
    expect(written.needs_review).toBe(true);
    expect(safety).toBeDefined();
  });
});
