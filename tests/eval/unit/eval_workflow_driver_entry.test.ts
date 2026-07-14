import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { runWorkflowEval } from '../../../src/eval/executors/workflow_run';

const REPO_ROOT = path.resolve(__dirname, '../../..');
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

    const previousArgvOut = process.env.FAKE_AWS_ARGV_OUT;
    process.env.FAKE_AWS_ARGV_OUT = argvOut;
    try {
      expect(runWorkflowEval({
        repoRoot: REPO_ROOT,
        projectDir,
        changeId: 'eval-sample-001',
        fixtureTier: 'L0',
        runMode: 'case-only',
        archiveDir,
        attemptDir,
        skipSeed: true,
        awsBin: FAKE_AWS,
      })).toBe(0);
    } finally {
      if (previousArgvOut === undefined) delete process.env.FAKE_AWS_ARGV_OUT;
      else process.env.FAKE_AWS_ARGV_OUT = previousArgvOut;
    }

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
