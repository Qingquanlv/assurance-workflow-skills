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

  it('validates the typed wrapper contract fail-closed', () => {
    expect(() => ExecutorSchema.parse({
      type: 'workflow-run',
      run_mode: 'codegen-only',
      timeout_seconds: 10,
      expected_outputs: [],
    })).toThrow('exactly one test_type');

    expect(() => ExecutorSchema.parse({
      type: 'workflow-run',
      run_mode: 'codegen-only',
      test_type: 'api,e2e',
      timeout_seconds: 10,
      expected_outputs: [],
    })).toThrow();

    expect(ExecutorSchema.parse({
      type: 'workflow-run',
      run_mode: 'codegen-only',
      test_type: 'api',
      timeout_seconds: 10,
      expected_outputs: [],
      workdir: '{{sut.dir}}',
      sandbox: { copy_from: '{{sut.dir}}' },
      allowed_writes: ['qa/**'],
      opencode_bin: 'opencode',
      aws_bin: 'aws',
      agent_cmd: 'agent',
    }).type).toBe('workflow-run');
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

  it('fails closed when harness-injected fixture context is missing', async () => {
    const attemptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-missing-context-'));
    try {
      await expect(executeAttempt({
        config: {
          type: 'aws-run',
          timeout_seconds: 10,
          expected_outputs: [],
          skip_seed: true,
        },
        sample: {
          id: 'missing-fixture',
          annotation_source: 'synthetic',
          input: { change_id: 'typed-change' },
          expected: {},
        },
        sampleDir: os.tmpdir(),
        attemptDir,
        projectRoot: path.resolve(__dirname, '../../..'),
        runId: 'typed-run',
        sutDir: os.tmpdir(),
      })).rejects.toThrow('fixture_tier is required');
    } finally {
      fs.rmSync(attemptDir, { recursive: true, force: true });
    }
  });

  it('contains no filename-based wrapper dispatch', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../../src/eval/executor.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/eval-\(aws-run\|workflow-run\)|commandUsesExternalEvidenceWriter/);
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
          sandbox: { copy_from: '{{sut.dir}}' },
          workdir: '{{sandbox.path}}',
          allowed_writes: ['qa/**'],
        },
        sample: {
          id: 'typed-sample',
          annotation_source: 'synthetic',
          input: { change_id: 'typed-change', fixture_tier: 'L3-run-seed' },
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
      expect(fs.existsSync(path.join(attemptDir, 'sandbox/qa/changes/typed-change/proposal.md')))
        .toBe(true);
      expect(fs.existsSync(path.join(
        attemptDir,
        'sandbox/qa/changes/typed-change/execution/execution-manifest.yaml',
      ))).toBe(true);
      expect(fs.existsSync(path.join(
        sutDir,
        'qa/changes/typed-change/execution/execution-manifest.yaml',
      ))).toBe(false);
      const policy = JSON.parse(fs.readFileSync(
        path.join(attemptDir, 'evidence/write-policy.json'),
        'utf8',
      )) as { mode: string; patterns: string[] };
      expect(policy).toEqual({ mode: 'allowlist', patterns: ['qa/**'] });

      const missingOutputAttempt = path.join(tmp, 'attempt-missing-output');
      await expect(executeAttempt({
        config: {
          type: 'aws-run',
          timeout_seconds: 10,
          expected_outputs: ['does-not-exist.json'],
          skip_seed: true,
          env: { EVAL_USE_FAKE_AWS_RUN: '1' },
          sandbox: { copy_from: '{{sut.dir}}' },
          allowed_writes: ['qa/**'],
        },
        sample: {
          id: 'typed-missing-output',
          annotation_source: 'synthetic',
          input: { change_id: 'typed-change', fixture_tier: 'L3-run-seed' },
          expected: {},
        },
        sampleDir: tmp,
        attemptDir: missingOutputAttempt,
        projectRoot: path.resolve(__dirname, '../../..'),
        runId: 'typed-run',
        sutDir,
      })).rejects.toThrow('Expected output not found');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
