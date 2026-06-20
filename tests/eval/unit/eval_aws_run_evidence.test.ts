import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const REPO_ROOT = path.join(__dirname, '../../..');
const EVAL_AWS_RUN = path.join(REPO_ROOT, 'scripts/eval-aws-run.mjs');
const EVIDENCE = 'evidence';

describe('eval-aws-run evidence', () => {
  let tmpRoot: string;
  let projectDir: string;
  let fakeAws: string;
  let archiveDir: string;
  let attemptDir: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-aws-run-'));
    projectDir = path.join(tmpRoot, 'bench');
    fs.mkdirSync(path.join(projectDir, 'qa/changes/eval-sample-001'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'qa/changes/eval-sample-001/.qa.yaml'), 'test_types: [api]\n');

    execFileSync('git', ['init'], { cwd: projectDir });
    execFileSync('git', ['add', '.'], { cwd: projectDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: projectDir });

    attemptDir = path.join(tmpRoot, 'attempt-0');
    archiveDir = path.join(attemptDir, 'raw-output');
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeFakeAws(exitCode: number) {
    fakeAws = path.join(tmpRoot, 'fake-aws.mjs');
    fs.writeFileSync(
      fakeAws,
      `#!/usr/bin/env node
console.log('fake aws run');
process.exit(${exitCode});
`
    );
    fs.chmodSync(fakeAws, 0o755);
  }

  function runWrapper(changeId = 'eval-sample-001') {
    execFileSync(
      process.execPath,
      [
        EVAL_AWS_RUN,
        '--repo-root',
        REPO_ROOT,
        '--project-dir',
        projectDir,
        '--change',
        changeId,
        '--archive-dir',
        archiveDir,
        '--attempt-dir',
        attemptDir,
        '--skip-seed',
        '--aws-bin',
        fakeAws,
      ],
      { encoding: 'utf8' }
    );
  }

  it('writes unified evidence/ write-diff artifacts', () => {
    writeFakeAws(0);
    runWrapper();

    const evidenceDir = path.join(attemptDir, EVIDENCE);
    expect(fs.existsSync(path.join(attemptDir, 'stdout.log'))).toBe(true);
    expect(fs.existsSync(path.join(attemptDir, 'stderr.log'))).toBe(true);
    expect(fs.existsSync(path.join(attemptDir, 'execution.json'))).toBe(true);
    expect(fs.existsSync(path.join(evidenceDir, 'write-diff.json'))).toBe(true);
    expect(fs.existsSync(path.join(evidenceDir, 'git-status-before.bin'))).toBe(true);
    expect(fs.existsSync(path.join(evidenceDir, 'git-status-after.bin'))).toBe(true);
    expect(fs.existsSync(path.join(evidenceDir, 'write-policy.json'))).toBe(true);
    expect(fs.existsSync(path.join(archiveDir, 'archive-manifest.json'))).toBe(true);

    const execution = JSON.parse(
      fs.readFileSync(path.join(attemptDir, 'execution.json'), 'utf8')
    );
    expect(execution.executor).toBe('eval-aws-run');
    expect(execution.wrapper_exit_code).toBe(0);
    expect(execution.aws_run_exit_code).toBe(0);
    expect(execution.archive_completed).toBe(true);
    expect(execution.evidence_completed).toBe(true);
  });

  it('exits 0 when aws run fails but archive and evidence succeed (P0-2)', () => {
    writeFakeAws(1);
    expect(() => runWrapper()).not.toThrow();

    const execution = JSON.parse(
      fs.readFileSync(path.join(attemptDir, 'execution.json'), 'utf8')
    );
    expect(execution.wrapper_exit_code).toBe(0);
    expect(execution.aws_run_exit_code).toBe(1);
    expect(execution.archive_completed).toBe(true);
    expect(fs.existsSync(path.join(attemptDir, EVIDENCE, 'write-diff.json'))).toBe(true);
  });

  it('writes execution.json after archive with accurate flags when archive fails', () => {
    writeFakeAws(0);
    expect(() => runWrapper('missing-change-id')).toThrow();

    expect(fs.existsSync(path.join(attemptDir, 'stdout.log'))).toBe(true);
    const execution = JSON.parse(
      fs.readFileSync(path.join(attemptDir, 'execution.json'), 'utf8')
    );
    expect(execution.evidence_completed).toBe(true);
    expect(execution.archive_completed).toBe(false);
    expect(execution.wrapper_exit_code).toBe(1);
  });
});
