import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import {
  loadTierManifest,
  resolveTierPaths,
  expandTierPaths,
  copyTierToChangeDir,
  clearChangeDir,
} from '../../../scripts/lib/eval-fixture-utils.mjs';

describe('eval-fixture-utils', () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const fixturesRoot = path.join(testDir, '../../../eval/fixtures');
  const tiersDir = path.join(fixturesRoot, 'tiers');
  const sampleRoot = path.join(fixturesRoot, 'samples/eval-sample-001');

  it('resolves L2-api paths including L1 extends chain', () => {
    const tier = loadTierManifest(
      path.join(tiersDir, 'L2-api-codegen-seed.yaml'),
      tiersDir
    );
    const paths = resolveTierPaths(tier, sampleRoot);
    expect(paths).toContain('plans/api-plan.md');
    expect(paths).toContain('cases/users/case.yaml');
  });

  it('loads L0 tier without extends', () => {
    const tier = loadTierManifest(path.join(tiersDir, 'L0-case-seed.yaml'), tiersDir);
    expect(tier.extends).toBeUndefined();
    expect(tier.paths).toEqual([
      'proposal.md',
      '.qa.yaml',
      '.aws/data-knowledge.yaml',
    ]);
    expect(tier.source_prefix).toBe('eval/fixtures/samples/eval-sample-001');
  });

  it('L3 extends chain includes tests paths', () => {
    const tier = loadTierManifest(path.join(tiersDir, 'L3-run-seed.yaml'), tiersDir);
    const paths = resolveTierPaths(tier, sampleRoot);
    expect(paths).toContain('tests/api/test_users_api.py');
    expect(paths).toContain('tests/api/helpers/auth.py');
    expect(paths).toContain('plans/api-plan.md');
    expect(paths).toContain('cases/users/case.yaml');
  });

  it('expandTierPaths expands cases/** to actual files under sample root', () => {
    const expanded = expandTierPaths(sampleRoot, ['cases/**', 'proposal.md']);
    expect(expanded).toContain('cases/users/case.yaml');
    expect(expanded).toContain('proposal.md');
    expect(expanded.some((p: string) => p.includes('*'))).toBe(false);
  });

  describe('copyTierToChangeDir', () => {
    let tmpRoot: string;
    let changeDir: string;

    beforeEach(() => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-fixture-copy-'));
      changeDir = path.join(tmpRoot, 'change');
      fs.mkdirSync(changeDir, { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('copies tier files to temp change dir and applies resets', () => {
      const tier = loadTierManifest(
        path.join(tiersDir, 'L2-api-codegen-seed.yaml'),
        tiersDir
      );

      copyTierToChangeDir({
        sampleRoot,
        changeDir,
        tier,
        tiersDir,
      });

      expect(fs.existsSync(path.join(changeDir, 'plans/api-plan.md'))).toBe(true);
      expect(fs.existsSync(path.join(changeDir, 'cases/users/case.yaml'))).toBe(true);
      expect(fs.existsSync(path.join(changeDir, 'workflow-state.yaml'))).toBe(true);

      const workflowState = yaml.load(
        fs.readFileSync(path.join(changeDir, 'workflow-state.yaml'), 'utf8')
      ) as {
        phases: { api_codegen: { status: string; attempts: number } };
      };
      expect(workflowState.phases.api_codegen.status).toBe('pending');
      expect(workflowState.phases.api_codegen.attempts).toBe(0);

      const qaYaml = yaml.load(
        fs.readFileSync(path.join(changeDir, '.qa.yaml'), 'utf8')
      ) as { test_types: string[] };
      expect(qaYaml.test_types).toEqual(['api']);
    });
  });

  describe('clearChangeDir', () => {
    it('removes contents except .gitkeep', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-fixture-clear-'));
      fs.writeFileSync(path.join(dir, 'proposal.md'), 'x');
      fs.writeFileSync(path.join(dir, '.gitkeep'), '');
      fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'nested', 'a.yaml'), 'y');

      clearChangeDir(dir);

      expect(fs.existsSync(path.join(dir, '.gitkeep'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'proposal.md'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'nested'))).toBe(false);

      fs.rmSync(dir, { recursive: true, force: true });
    });
  });
});
