import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { hashProductTree } from '../../../../src/utils/hash';
import {
  assertProductTreeUnchangedInHealing,
  pinHealingEntryBaseline,
} from '../../../../src/workflow/core/healing_state';

const changeId = 'REQ-PRODUCT-GUARD-001';

function changeDir(root: string): string {
  return path.join(root, 'qa', 'changes', changeId);
}

function writeState(root: string, healingStatus = 'pending'): void {
  fs.mkdirSync(changeDir(root), { recursive: true });
  fs.writeFileSync(
    path.join(changeDir(root), 'workflow-state.yaml'),
    yaml.dump({ phases: { healing: { status: healingStatus, attempts: [] } } }),
    'utf-8',
  );
}

function writeLatestManifest(root: string, productTreeSha256?: string): void {
  const dir = path.join(changeDir(root), 'execution');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'execution-manifest.yaml'),
    yaml.dump({
      schema_version: '1.0',
      change_id: changeId,
      batch_id: '20260706-010000',
      selected_targets: { api: true, e2e: false, fuzz: false, performance: false },
      result_files: {},
      ...(productTreeSha256 ? { product_tree_sha256: productTreeSha256 } : {}),
    }),
    'utf-8',
  );
}

describe('product tree guard', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-product-guard-'));
    fs.mkdirSync(path.join(projectRoot, 'app'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'app', 'service.py'), 'VALUE = 1\n', 'utf-8');
    writeState(projectRoot);
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('hashes configured product roots and excludes build artifacts', () => {
    const initial = hashProductTree(projectRoot, ['app']);
    fs.mkdirSync(path.join(projectRoot, 'app', '__pycache__'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'app', '__pycache__', 'service.pyc'), 'binary', 'utf-8');
    fs.writeFileSync(path.join(projectRoot, 'app', 'bundle.js.map'), 'map', 'utf-8');

    expect(hashProductTree(projectRoot, ['app'])).toEqual(initial);
  });

  it('fails open when the latest manifest has no product tree baseline', () => {
    writeLatestManifest(projectRoot);
    fs.writeFileSync(path.join(projectRoot, 'app', 'service.py'), 'VALUE = 2\n', 'utf-8');

    const result = assertProductTreeUnchangedInHealing(projectRoot, changeId, ['app']);
    expect(result.productChanged).toBe(false);
  });

  it('throws when product code changes during healing', () => {
    const baseline = hashProductTree(projectRoot, ['app']);
    writeLatestManifest(projectRoot, baseline.aggregate);
    pinHealingEntryBaseline(projectRoot, changeId);
    fs.writeFileSync(path.join(projectRoot, 'app', 'service.py'), 'VALUE = 2\n', 'utf-8');

    expect(() => assertProductTreeUnchangedInHealing(projectRoot, changeId, ['app'])).toThrow(
      /PRODUCT-CHANGED-DURING-HEALING/,
    );
  });

  it('returns product_tree_changed details for ordinary reruns', () => {
    const baseline = hashProductTree(projectRoot, ['app']);
    writeLatestManifest(projectRoot, baseline.aggregate);
    fs.writeFileSync(path.join(projectRoot, 'app', 'service.py'), 'VALUE = 2\n', 'utf-8');

    const result = assertProductTreeUnchangedInHealing(projectRoot, changeId, ['app']);
    expect(result.productChanged).toBe(true);
    expect(result.previousBatchId).toBe('20260706-010000');
    expect(result.previousSha256).toBe(baseline.aggregate);
    expect(result.current.aggregate).toMatch(/^[a-f0-9]{64}$/);
  });
});
