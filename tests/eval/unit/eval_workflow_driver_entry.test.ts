import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const WRAPPER = path.join(REPO_ROOT, 'scripts/eval-workflow-run.mjs');
const FAKE_AWS = path.join(REPO_ROOT, 'scripts/fake-aws-workflow-echo.mjs');

describe('eval-workflow-run driver entry', () => {
  it('default entry invokes aws workflow run --adapter headless', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-drv-'));
    const projectDir = path.join(tmp, 'sut');
    fs.mkdirSync(path.join(projectDir, '.git'), { recursive: true });
    execFileSync('git', ['init'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'eval@test'], {
      cwd: projectDir,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.name', 'eval'], {
      cwd: projectDir,
      stdio: 'ignore',
    });
    fs.writeFileSync(path.join(projectDir, 'README.md'), 'sut\n');
    fs.mkdirSync(path.join(projectDir, 'qa/changes/eval-sample-001'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(projectDir, 'qa/changes/eval-sample-001/proposal.md'),
      '# proposal\n',
    );
    execFileSync('git', ['add', '.'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], {
      cwd: projectDir,
      stdio: 'ignore',
    });

    const attemptDir = path.join(tmp, 'attempt-0');
    const archiveDir = path.join(attemptDir, 'raw-output');
    fs.mkdirSync(archiveDir, { recursive: true });
    const argvOut = path.join(tmp, 'aws-argv.json');

    execFileSync(
      process.execPath,
      [
        WRAPPER,
        '--repo-root',
        REPO_ROOT,
        '--project-dir',
        projectDir,
        '--change',
        'eval-sample-001',
        '--fixture-tier',
        'L0',
        '--run-mode',
        'case-only',
        '--archive-dir',
        archiveDir,
        '--attempt-dir',
        attemptDir,
        '--skip-seed',
        '--aws-bin',
        FAKE_AWS,
      ],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, FAKE_AWS_ARGV_OUT: argvOut },
        stdio: 'pipe',
        encoding: 'utf8',
      },
    );

    const argv = JSON.parse(fs.readFileSync(argvOut, 'utf8')) as string[];
    expect(argv).toEqual(
      expect.arrayContaining([
        'workflow',
        'run',
        '--change',
        'eval-sample-001',
        '--scope',
        'full',
        '--adapter',
        'headless',
      ]),
    );
    expect(argv).toContain('--agent-cmd');
    expect(argv).toContain('--params');

    const execution = JSON.parse(
      fs.readFileSync(path.join(attemptDir, 'execution.json'), 'utf8'),
    );
    expect(execution.executor_mode).toBe('driver-headless');
  });
});
