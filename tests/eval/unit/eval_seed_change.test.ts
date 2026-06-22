import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const REPO_ROOT = path.join(__dirname, '../../..');
const SEED_SCRIPT = path.join(REPO_ROOT, 'scripts/eval-seed-change.mjs');
const FIXTURES_ROOT = path.join(REPO_ROOT, 'eval/fixtures');

describe('eval-seed-change.mjs', () => {
  it('dry-run exits 0 and prints resolved paths', () => {
    const stdout = execFileSync(
      process.execPath,
      [
        SEED_SCRIPT,
        '--project-dir',
        '/tmp/bench-test',
        '--change',
        'eval-sample-001',
        '--fixture-tier',
        'L0-case-seed',
        '--fixtures-root',
        FIXTURES_ROOT,
        '--dry-run',
      ],
      { encoding: 'utf8', cwd: REPO_ROOT }
    );

    expect(stdout).toContain('changeDir:');
    expect(stdout).toContain('/tmp/bench-test/qa/changes/eval-sample-001');
    expect(stdout).toContain('change: proposal.md');
    expect(stdout).toContain('change: .qa.yaml');
    expect(stdout).toContain('change: .aws/data-knowledge.yaml');
  });

  it('L3 dry-run lists bench test paths separately from change paths', () => {
    const stdout = execFileSync(
      process.execPath,
      [
        SEED_SCRIPT,
        '--project-dir',
        '/tmp/bench-test',
        '--change',
        'eval-sample-001',
        '--fixture-tier',
        'L3-run-seed',
        '--fixtures-root',
        FIXTURES_ROOT,
        '--dry-run',
      ],
      { encoding: 'utf8', cwd: REPO_ROOT }
    );

    expect(stdout).toContain('change: proposal.md');
    expect(stdout).toContain('benchTests:');
    expect(stdout).toContain('tests: tests/api/test_users_api.py');
    expect(stdout).not.toContain('change: tests/');
  });

  describe('integration seed', () => {
    let tmpRoot: string;
    let projectDir: string;

    beforeEach(() => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-seed-change-'));
      projectDir = path.join(tmpRoot, 'bench');
      fs.mkdirSync(path.join(projectDir, 'qa/changes/eval-sample-001'), {
        recursive: true,
      });
    });

    afterEach(() => {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('seeds L0 tier into tmp project dir with proposal.md', () => {
      execFileSync(
        process.execPath,
        [
          SEED_SCRIPT,
          '--project-dir',
          projectDir,
          '--change',
          'eval-sample-001',
          '--fixture-tier',
          'L0-case-seed',
          '--fixtures-root',
          FIXTURES_ROOT,
        ],
        { encoding: 'utf8', cwd: REPO_ROOT }
      );

      const changeDir = path.join(projectDir, 'qa/changes/eval-sample-001');
      expect(fs.existsSync(path.join(changeDir, 'proposal.md'))).toBe(true);
      expect(fs.existsSync(path.join(changeDir, '.qa.yaml'))).toBe(true);
      expect(fs.existsSync(path.join(changeDir, '.aws/data-knowledge.yaml'))).toBe(
        true
      );
    });

    it('L3 seeds tests under project tests/ not change dir', () => {
      execFileSync(
        process.execPath,
        [
          SEED_SCRIPT,
          '--project-dir',
          projectDir,
          '--change',
          'eval-sample-001',
          '--fixture-tier',
          'L3-run-seed',
          '--fixtures-root',
          FIXTURES_ROOT,
        ],
        { encoding: 'utf8', cwd: REPO_ROOT }
      );

      const changeDir = path.join(projectDir, 'qa/changes/eval-sample-001');
      expect(fs.existsSync(path.join(changeDir, 'proposal.md'))).toBe(true);
      expect(fs.existsSync(path.join(changeDir, 'tests'))).toBe(false);
      expect(
        fs.existsSync(path.join(projectDir, 'tests/api/test_users_api.py'))
      ).toBe(true);
    });
  });
});
