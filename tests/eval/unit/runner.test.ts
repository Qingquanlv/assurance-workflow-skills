import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runPlan } from '../../../src/eval/runner';

describe('runPlan error handling', () => {
  let tmpBase: string;
  let projectRoot: string;
  let evalRoot: string;
  let planPath: string;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-runner-'));
    projectRoot = tmpBase;
    evalRoot = path.join(projectRoot, 'eval');
    const suitesDir = path.join(evalRoot, 'suites');
    const datasetsDir = path.join(evalRoot, 'datasets', 'thrower');
    fs.mkdirSync(suitesDir, { recursive: true });
    fs.mkdirSync(datasetsDir, { recursive: true });

    // Suite that references an empty dataset so load() fails before execution.
    fs.writeFileSync(
      path.join(suitesDir, 'thrower.yaml'),
      [
        'name: thrower',
        'version: "1.0.0"',
        'executor:',
        '  type: in_process',
        '  target_module: src/eval/_test/fake_target',
        '  target_export: fakeClassify',
        'ci:',
        '  pr:',
        '    enabled: false',
        '    mode: smoke',
        '    required: false',
        'dataset: thrower',
        'thresholds: {}',
        'hard_gates: []',
      ].join('\n')
    );

    planPath = path.join(tmpBase, 'plan.json');
    fs.writeFileSync(
      planPath,
      JSON.stringify(
        {
          event: 'manual',
          generated_at: new Date().toISOString(),
          changed_files: [],
          suites: [{ name: 'thrower', required: true }],
        },
        null,
        2
      )
    );
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('writes manifest for failed suite run and reports runner_error, not manifest integrity failure', async () => {
    const result = await runPlan({
      planPath,
      projectRoot,
      evalRoot,
    });

    expect(result.gateResult.verdict).toBe('fail');
    expect(result.gateResult.suite_results['thrower'].verdict).toBe('fail');
    expect(result.gateResult.suite_results['thrower'].required).toBe(true);
    expect(result.gateResult.hard_gate_failures.some((f) => f.startsWith('runner_error'))).toBe(true);
    expect(
      result.gateResult.hard_gate_failures.some((f) => f.startsWith('run_manifest_missing'))
    ).toBe(false);

    const runId = result.gateResult.suite_results['thrower'].run_id;
    const runDir = path.join(evalRoot, 'runs', runId);
    expect(fs.existsSync(path.join(runDir, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'gate-result.json'))).toBe(true);

    const gateResult = JSON.parse(fs.readFileSync(path.join(runDir, 'gate-result.json'), 'utf-8'));
    expect(gateResult.hard_gate_failures.some((f: string) => f.startsWith('runner_error'))).toBe(true);
    expect(gateResult.error).toBeUndefined();
  });
});
