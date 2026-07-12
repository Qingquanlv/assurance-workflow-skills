import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const WRAPPER = path.join(REPO_ROOT, 'scripts/eval-workflow-run.mjs');
const FAKE_NDJSON = path.join(
  REPO_ROOT,
  'scripts/fake-opencode-process-ndjson.mjs'
);

describe('eval-workflow-run process observability', () => {
  function runWrapper(opts: { ndjson?: boolean } = {}) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-wrap-'));
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
    // Seed a change dir so archive can succeed.
    fs.mkdirSync(path.join(projectDir, 'qa/changes/eval-sample-001'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(projectDir, 'qa/changes/eval-sample-001/proposal.md'),
      '# proposal\n'
    );
    execFileSync('git', ['add', '.'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], {
      cwd: projectDir,
      stdio: 'ignore',
    });

    const attemptDir = path.join(tmp, 'attempt-0');
    const archiveDir = path.join(attemptDir, 'raw-output');
    fs.mkdirSync(archiveDir, { recursive: true });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
    };

    const args = [
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
    ];

    if (opts.ndjson) {
      // Process observability is an OpenCode NDJSON concern — use legacy entry.
      args.push('--entry', 'orchestrator', '--opencode-bin', FAKE_NDJSON);
    } else {
      env.EVAL_USE_FAKE_OPENCODE = '1';
    }

    try {
      execFileSync(process.execPath, args, {
        cwd: REPO_ROOT,
        env,
        stdio: 'pipe',
        encoding: 'utf8',
      });
    } catch {
      // wrapper may exit non-zero on archive/infra issues; artifacts still matter
    }

    return { tmp, projectDir, attemptDir };
  }

  it('keeps plain fake text compatible (observability unavailable)', () => {
    const { attemptDir } = runWrapper();
    expect(fs.existsSync(path.join(attemptDir, 'stdout.log'))).toBe(true);
    expect(fs.existsSync(path.join(attemptDir, 'execution.json'))).toBe(true);
    expect(fs.existsSync(path.join(attemptDir, 'process-summary.json'))).toBe(
      true
    );

    const summary = JSON.parse(
      fs.readFileSync(path.join(attemptDir, 'process-summary.json'), 'utf8')
    );
    const execution = JSON.parse(
      fs.readFileSync(path.join(attemptDir, 'execution.json'), 'utf8')
    );

    expect(summary.observability_available).toBe(false);
    expect(execution.session_id).toBeNull();
    expect(execution.process_observability_available).toBe(false);
    expect(execution.process_summary_path).toBe('process-summary.json');
  });

  it('extracts session_id from NDJSON fake and writes summary before execution', () => {
    const { attemptDir } = runWrapper({ ndjson: true });
    expect(fs.existsSync(path.join(attemptDir, 'process-summary.json'))).toBe(
      true
    );
    expect(fs.existsSync(path.join(attemptDir, 'execution.json'))).toBe(true);

    const summary = JSON.parse(
      fs.readFileSync(path.join(attemptDir, 'process-summary.json'), 'utf8')
    );
    const execution = JSON.parse(
      fs.readFileSync(path.join(attemptDir, 'execution.json'), 'utf8')
    );
    const stdout = fs.readFileSync(path.join(attemptDir, 'stdout.log'), 'utf8');

    expect(stdout).toContain('ses_evalfixture001');
    expect(summary.session_id).toBe('ses_evalfixture001');
    expect(summary.observability_available).toBe(true);
    expect(execution.session_id).toBe('ses_evalfixture001');
    expect(execution.process_observability_available).toBe(true);
    expect(execution.session_resume_command).toContain(
      '--session ses_evalfixture001'
    );
    expect(execution.session_export_command).toBe(
      'opencode export ses_evalfixture001'
    );
  });
});
