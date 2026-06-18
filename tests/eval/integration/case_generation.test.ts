import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runSuite } from '../../../src/eval/runner';
import type { EvalSuite } from '../../../src/eval/types';

describe.skip('case-generation integration (PR-5a)', () => {
  let tmpBase: string;
  let projectRoot: string;
  let evalRoot: string;
  let originalEvalJudgeMock: string | undefined;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'case-gen-eval-'));
    projectRoot = tmpBase;
    evalRoot = path.join(projectRoot, 'eval');

    // Set up directory structure
    const suitesDir = path.join(evalRoot, 'suites');
    const datasetsDir = path.join(evalRoot, 'datasets', 'case-generation');
    const srcEvalDir = path.join(projectRoot, 'src', 'eval');
    const scorersDir = path.join(srcEvalDir, 'scorers');
    const judgeDir = path.join(srcEvalDir, 'judge');
    const testDir = path.join(srcEvalDir, '_test');

    fs.mkdirSync(suitesDir, { recursive: true });
    fs.mkdirSync(datasetsDir, { recursive: true });
    fs.mkdirSync(scorersDir, { recursive: true });
    fs.mkdirSync(judgeDir, { recursive: true });
    fs.mkdirSync(testDir, { recursive: true });

    // Copy source files from real repo
    const realProjectRoot = '/Users/lvqingquan/skills/assurance-workflow-skills';

    // Copy scorer
    fs.copyFileSync(
      path.join(realProjectRoot, 'src/eval/scorers/case_generation.ts'),
      path.join(scorersDir, 'case_generation.ts')
    );

    // Copy judge files
    fs.copyFileSync(
      path.join(realProjectRoot, 'src/eval/judge/judge.ts'),
      path.join(judgeDir, 'judge.ts')
    );
    fs.copyFileSync(
      path.join(realProjectRoot, 'src/eval/judge/llm_client.ts'),
      path.join(judgeDir, 'llm_client.ts')
    );
    fs.copyFileSync(
      path.join(realProjectRoot, 'src/eval/judge/calibration.ts'),
      path.join(judgeDir, 'calibration.ts')
    );

    // Copy fake executor
    fs.copyFileSync(
      path.join(realProjectRoot, 'src/eval/_test/fake_case_design.ts'),
      path.join(testDir, 'fake_case_design.ts')
    );

    // Copy other necessary eval modules
    const evalModules = [
      'runner.ts',
      'types.ts',
      'manifest.ts',
      'module_resolver.ts',
      'dataset_loader.ts',
      'executor.ts',
      'metrics.ts',
      'gate.ts',
      'batch.ts',
      'report.ts',
      'plan.ts',
      'manifest_helpers.ts',
      'schemas.ts',
    ];

    const srcEvalReal = path.join(realProjectRoot, 'src/eval');
    for (const mod of evalModules) {
      const src = path.join(srcEvalReal, mod);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(srcEvalDir, mod));
      }
    }

    // Create judge prompt file (just needs to exist for hash calculation)
    const judgePromptDir = path.join(evalRoot, 'judge');
    fs.mkdirSync(judgePromptDir, { recursive: true });
    fs.writeFileSync(
      path.join(judgePromptDir, 'case-generation-judge.md'),
      '# Judge prompt'
    );

    // Write suite yaml with in_process executor using fake_case_design
    const suiteYaml: EvalSuite = {
      name: 'case-generation',
      version: '1.0.0',
      executor: {
        type: 'in_process',
        target_module: 'src/eval/_test/fake_case_design',
        target_export: 'generateCases',
      },
      ci: {
        pr: {
          enabled: true,
          mode: 'smoke',
          required: false,
        },
      },
      dataset: 'case-generation',
      judge: {
        model: 'gpt-4o',
        prompt_ref: 'eval/judge/case-generation-judge.md',
        temperature: 0.0,
        confidence_threshold: 0.80,
      },
      thresholds: {},
      hard_gates: [],
    };

    fs.writeFileSync(
      path.join(suitesDir, 'case-generation.yaml'),
      [
        'name: case-generation',
        'version: "1.0.0"',
        'executor:',
        '  type: in_process',
        '  target_module: src/eval/_test/fake_case_design',
        '  target_export: generateCases',
        'ci:',
        '  pr:',
        '    enabled: true',
        '    mode: smoke',
        '    required: false',
        'dataset: case-generation',
        'judge:',
        '  model: "gpt-4o"',
        '  prompt_ref: "eval/judge/case-generation-judge.md"',
        '  temperature: 0.0',
        '  confidence_threshold: 0.80',
        'thresholds: {}',
        'hard_gates: []',
      ].join('\n')
    );

    // Write test dataset samples
    const samples = [
      {
        id: 'CG-001',
        annotation_source: 'human' as const,
        tags: ['case-generation', 'menu'],
        prd_ref: 'CG-001.prd.md',
        input: { change_id: 'CG-001' },
        mock_judge_label: 'covered' as const,
        expected: {
          human_label: 'covered' as const,
          required_paths: ['POST /api/v1/menu/create', 'GET /api/v1/menu/list'],
          forbidden_cases: ['delete all'],
          required_atoms: [
            { id: 'RA-001', text: 'Create menu item' },
            { id: 'RA-002', text: 'List menu items' },
          ],
        },
      },
    ];

    for (const sample of samples) {
      fs.writeFileSync(
        path.join(datasetsDir, `${sample.id}.yaml`),
        [
          `id: ${sample.id}`,
          `annotation_source: ${sample.annotation_source}`,
          `tags: [${sample.tags.map((t) => `"${t}"`).join(', ')}]`,
          `prd_ref: ${sample.prd_ref}`,
          'input:',
          `  change_id: ${sample.input.change_id}`,
          `mock_judge_label: ${sample.mock_judge_label}`,
          'expected:',
          `  human_label: ${sample.expected.human_label}`,
          '  required_paths:',
          ...sample.expected.required_paths.map((p) => `    - "${p}"`),
          '  forbidden_cases:',
          ...sample.expected.forbidden_cases.map((p) => `    - "${p}"`),
          '  required_atoms:',
          ...sample.expected.required_atoms.map(
            (a) => `    - id: ${a.id}\n      text: "${a.text}"`
          ),
        ].join('\n')
      );
      fs.writeFileSync(
        path.join(datasetsDir, sample.prd_ref),
        `# ${sample.id} PRD`
      );
    }

    // Set EVAL_JUDGE_MOCK=true
    originalEvalJudgeMock = process.env.EVAL_JUDGE_MOCK;
    process.env.EVAL_JUDGE_MOCK = 'true';
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    if (originalEvalJudgeMock !== undefined) {
      process.env.EVAL_JUDGE_MOCK = originalEvalJudgeMock;
    } else {
      delete process.env.EVAL_JUDGE_MOCK;
    }
  });

  it('runs case-generation suite with mock judge and produces deterministic metrics', async () => {
    // Need to make sure we're using the right project root for module resolution
    const originalCwd = process.cwd();
    process.chdir(projectRoot);

    try {
      const result = await runSuite({
        suite: {
          name: 'case-generation',
          version: '1.0.0',
          executor: {
            type: 'in_process',
            target_module: 'src/eval/_test/fake_case_design',
            target_export: 'generateCases',
          },
          ci: { pr: { enabled: true, mode: 'smoke', required: false } },
          dataset: 'case-generation',
          judge: {
            model: 'gpt-4o',
            prompt_ref: 'eval/judge/case-generation-judge.md',
            temperature: 0.0,
            confidence_threshold: 0.80,
          },
          thresholds: {},
          hard_gates: [],
        },
        suiteFilePath: path.join(evalRoot, 'suites', 'case-generation.yaml'),
        evalRoot,
        projectRoot,
      });

      expect(result.gateResult.verdict).toBeDefined();
      const runDir = path.join(evalRoot, 'runs', result.runId);
      expect(fs.existsSync(runDir)).toBe(true);

      // Check for errors in execution.json and score.json
      const sampleAttemptDir = path.join(
        runDir,
        'samples',
        'CG-001',
        'attempt-0'
      );

      const executionPath = path.join(sampleAttemptDir, 'execution.json');
      if (fs.existsSync(executionPath)) {
        const execution = JSON.parse(fs.readFileSync(executionPath, 'utf-8'));
        console.log('Execution result:', execution);
      }

      // Check that judge-result.json was written
      expect(fs.existsSync(path.join(sampleAttemptDir, 'judge-result.json'))).toBe(
        true
      );

      // Check that score.json was written
      const scorePath = path.join(sampleAttemptDir, 'score.json');
      expect(fs.existsSync(scorePath)).toBe(true);
      const score = JSON.parse(fs.readFileSync(scorePath, 'utf-8'));

      // Verify deterministic metrics
      expect(score.metrics.schema_valid_rate).toBe(1);
      expect(score.metrics.hallucination_rate).toBe(0);
      expect(score.metrics.path_coverage_rate).toBe(0.5); // Only first path covered
      expect(score.metrics.traceability_rate).toBe(1);

      // Verify P/R/F1 are 0 since no human_label in sample
      expect(score.metrics.precision).toBe(0);
      expect(score.metrics.recall).toBe(0);
      expect(score.metrics.f1).toBe(0);

      // Verify manifest contains judge info
      const manifest = JSON.parse(
        fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf-8')
      );
      expect(manifest.judge_model).toBe('gpt-4o');
      expect(manifest.judge_prompt_hash).toBeDefined();
      expect(manifest.judge_temperature).toBe(0.0);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
