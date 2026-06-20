import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const REPO_ROOT = path.join(__dirname, '../../..');
const EVAL_WORKFLOW_RUN = path.join(REPO_ROOT, 'scripts/eval-workflow-run.mjs');

describe('eval-workflow-run write-scan evidence', () => {
  let tmpRoot: string;
  let projectDir: string;
  let archiveDir: string;
  let attemptDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-workflow-run-'));
    projectDir = path.join(tmpRoot, 'bench');
    fs.mkdirSync(path.join(projectDir, 'qa/changes/eval-sample-001'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'qa/changes/eval-sample-001/.qa.yaml'), 'test_types: [api]\n');

    execFileSync('git', ['init'], { cwd: projectDir });
    execFileSync('git', ['add', '.'], { cwd: projectDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: projectDir });

    attemptDir = path.join(tmpRoot, 'attempt-0');
    archiveDir = path.join(attemptDir, 'raw-output');
    env = { ...process.env, EVAL_USE_FAKE_OPENCODE: '1' };
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('captures allowlist write-diff for codegen-only (E2a)', () => {
    execFileSync(
      process.execPath,
      [
        EVAL_WORKFLOW_RUN,
        '--repo-root',
        REPO_ROOT,
        '--project-dir',
        projectDir,
        '--change',
        'eval-sample-001',
        '--fixture-tier',
        'L2-api-codegen-seed',
        '--run-mode',
        'codegen-only',
        '--archive-dir',
        archiveDir,
        '--attempt-dir',
        attemptDir,
        '--skip-seed',
      ],
      { encoding: 'utf8', env }
    );

    const evidenceDir = path.join(attemptDir, 'evidence');
    expect(fs.existsSync(path.join(evidenceDir, 'write-diff.json'))).toBe(true);
    expect(fs.existsSync(path.join(evidenceDir, 'git-status-before.bin'))).toBe(true);
    expect(fs.existsSync(path.join(evidenceDir, 'git-status-after.bin'))).toBe(true);

    const diff = JSON.parse(
      fs.readFileSync(path.join(evidenceDir, 'write-diff.json'), 'utf8')
    );
    expect(diff.policy_mode).toBe('allowlist');
    expect(diff.forbidden_write_executed_count).toBe(0);

    const execution = JSON.parse(
      fs.readFileSync(path.join(attemptDir, 'execution.json'), 'utf8')
    );
    expect(execution.executor).toBe('eval-workflow-run');
    expect(execution.safety_mode).toBe('disabled');
    expect(execution.wrapper_exit_code).toBe(0);
  });
});
