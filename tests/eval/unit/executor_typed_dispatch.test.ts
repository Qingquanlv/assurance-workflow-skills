import { ExecutorSchema } from '../../../src/eval/schemas';
import { executeAttempt } from '../../../src/eval/executor';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('typed eval executor dispatch', () => {
  it('accepts workflow-run and aws-run leaf executors', () => {
    expect(ExecutorSchema.parse({
      type: 'workflow-run',
      run_mode: 'full',
      timeout_seconds: 10,
      expected_outputs: [],
    }).type).toBe('workflow-run');

    expect(ExecutorSchema.parse({
      type: 'aws-run',
      timeout_seconds: 10,
      expected_outputs: [],
    }).type).toBe('aws-run');
  });

  it('allows typed leaves but rejects nested mixed executors', () => {
    expect(ExecutorSchema.parse({
      type: 'mixed',
      per_check_type: {
        workflow: {
          type: 'workflow-run',
          run_mode: 'case-only',
          timeout_seconds: 10,
          expected_outputs: [],
        },
      },
    }).type).toBe('mixed');

    expect(() => ExecutorSchema.parse({
      type: 'mixed',
      per_check_type: {
        invalid: { type: 'mixed', per_check_type: {} },
      },
    })).toThrow();
  });

  it('dispatches aws-run directly and preserves wrapper-owned evidence', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-typed-exec-'));
    const sutDir = path.join(tmp, 'sut');
    const attemptDir = path.join(tmp, 'attempt-0');
    fs.mkdirSync(path.join(sutDir, 'qa/changes/typed-change'), { recursive: true });
    fs.writeFileSync(path.join(sutDir, 'qa/changes/typed-change/proposal.md'), '# proposal\n');
    execFileSync('git', ['init'], { cwd: sutDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'eval@test'], { cwd: sutDir });
    execFileSync('git', ['config', 'user.name', 'eval'], { cwd: sutDir });
    execFileSync('git', ['add', '.'], { cwd: sutDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: sutDir, stdio: 'ignore' });

    try {
      const result = await executeAttempt({
        config: {
          type: 'aws-run',
          timeout_seconds: 10,
          expected_outputs: [],
          skip_seed: true,
          env: { EVAL_USE_FAKE_AWS_RUN: '1' },
        },
        sample: {
          id: 'typed-sample',
          annotation_source: 'synthetic',
          input: { change_id: 'typed-change' },
          expected: {},
        },
        sampleDir: path.dirname(attemptDir),
        attemptDir,
        projectRoot: path.resolve(__dirname, '../../..'),
        runId: 'typed-run',
        sutDir,
      });
      expect(result.status).toBe('ok');
      const execution = JSON.parse(
        fs.readFileSync(path.join(attemptDir, 'execution.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(execution.executor).toBe('eval-aws-run');
      expect(execution.archive_completed).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
