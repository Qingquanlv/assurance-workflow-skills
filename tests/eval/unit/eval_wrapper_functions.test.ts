import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runAwsEval } from '../../../src/eval/executors/aws_run';
import { runWorkflowEval } from '../../../src/eval/executors/workflow_run';

const repoRoot = path.resolve(__dirname, '../../..');

function makeProject(): { tmp: string; projectDir: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-eval-fn-'));
  const projectDir = path.join(tmp, 'sut');
  fs.mkdirSync(path.join(projectDir, 'qa/changes/eval-sample-001'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'README.md'), 'sut\n');
  fs.writeFileSync(
    path.join(projectDir, 'qa/changes/eval-sample-001/proposal.md'),
    '# proposal\n',
  );
  execFileSync('git', ['init'], { cwd: projectDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'eval@test'], { cwd: projectDir });
  execFileSync('git', ['config', 'user.name', 'eval'], { cwd: projectDir });
  execFileSync('git', ['add', '.'], { cwd: projectDir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: projectDir, stdio: 'ignore' });
  return { tmp, projectDir };
}

describe('compiled eval wrapper functions', () => {
  it('exposes the workflow and aws wrappers as callable functions', () => {
    expect(typeof runWorkflowEval).toBe('function');
    expect(typeof runAwsEval).toBe('function');
  });

  it('preserves aws-run evidence and archive behavior in fake mode', () => {
    const { tmp, projectDir } = makeProject();
    const attemptDir = path.join(tmp, 'attempt-0');
    const archiveDir = path.join(attemptDir, 'raw-output');
    const previousFake = process.env.EVAL_USE_FAKE_AWS_RUN;
    process.env.EVAL_USE_FAKE_AWS_RUN = '1';
    try {
      expect(runAwsEval({
        repoRoot,
        projectDir,
        changeId: 'eval-sample-001',
        archiveDir,
        attemptDir,
        skipSeed: true,
      })).toBe(0);

      const execution = JSON.parse(
        fs.readFileSync(path.join(attemptDir, 'execution.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(execution.executor).toBe('eval-aws-run');
      expect(execution.archive_completed).toBe(true);
      expect(execution.evidence_completed).toBe(true);
      expect(fs.existsSync(path.join(archiveDir, 'archive-manifest.json'))).toBe(true);
    } finally {
      if (previousFake === undefined) delete process.env.EVAL_USE_FAKE_AWS_RUN;
      else process.env.EVAL_USE_FAKE_AWS_RUN = previousFake;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('records inner nonzero exits without losing wrapper evidence', () => {
    const { tmp, projectDir } = makeProject();
    const attemptDir = path.join(tmp, 'attempt-nonzero');
    try {
      expect(runWorkflowEval({
        repoRoot,
        projectDir,
        changeId: 'eval-sample-001',
        fixtureTier: 'L2-api-codegen-seed',
        runMode: 'full',
        entry: 'orchestrator',
        opencodeBin: process.execPath,
        archiveDir: path.join(attemptDir, 'raw-output'),
        attemptDir,
        skipSeed: true,
        timeoutSeconds: 5,
      })).toBe(0);
      const execution = JSON.parse(
        fs.readFileSync(path.join(attemptDir, 'execution.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(execution.opencode_exit_code).not.toBe(0);
      expect(execution.wrapper_exit_code).toBe(0);
      expect(execution.archive_completed).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('records timeout evidence and still completes archive handling', () => {
    const { tmp, projectDir } = makeProject();
    const attemptDir = path.join(tmp, 'attempt-timeout');
    const slowBin = path.join(tmp, 'slow-opencode');
    fs.writeFileSync(slowBin, '#!/bin/sh\nsleep 2\n');
    fs.chmodSync(slowBin, 0o755);
    try {
      expect(runWorkflowEval({
        repoRoot,
        projectDir,
        changeId: 'eval-sample-001',
        fixtureTier: 'L2-api-codegen-seed',
        runMode: 'full',
        entry: 'orchestrator',
        opencodeBin: slowBin,
        archiveDir: path.join(attemptDir, 'raw-output'),
        attemptDir,
        skipSeed: true,
        timeoutSeconds: 0.01,
      })).toBe(0);
      const execution = JSON.parse(
        fs.readFileSync(path.join(attemptDir, 'execution.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(execution.timed_out).toBe(true);
      expect(execution.archive_completed).toBe(true);
      expect(fs.existsSync(path.join(attemptDir, 'stdout.log'))).toBe(true);
      expect(fs.existsSync(path.join(attemptDir, 'stderr.log'))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
