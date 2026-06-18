import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runSuite } from '../../../src/eval/runner';
import type { EvalSuite } from '../../../src/eval/types';

describe('case-generation integration (PR-5a)', () => {
  let tmpBase: string;
  let evalRoot: string;
  let originalEvalJudgeMock: string | undefined;
  let originalEvalTargetModel: string | undefined;
  const projectRoot = process.cwd();

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'case-gen-eval-'));
    evalRoot = path.join(tmpBase, 'eval');

    // Set up directory structure
    const suitesDir = path.join(evalRoot, 'suites');
    const datasetsDir = path.join(evalRoot, 'datasets', 'case-generation');
    const judgePromptDir = path.join(evalRoot, 'judge');

    fs.mkdirSync(suitesDir, { recursive: true });
    fs.mkdirSync(datasetsDir, { recursive: true });
    fs.mkdirSync(judgePromptDir, { recursive: true });

    // Create judge prompt file (just needs to exist for hash calculation)
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

    // Set EVAL_TARGET_MODEL to something different from judge model
    originalEvalTargetModel = process.env.EVAL_TARGET_MODEL;
    process.env.EVAL_TARGET_MODEL = 'claude-sonnet-4-6';
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    if (originalEvalJudgeMock !== undefined) {
      process.env.EVAL_JUDGE_MOCK = originalEvalJudgeMock;
    } else {
      delete process.env.EVAL_JUDGE_MOCK;
    }
    if (originalEvalTargetModel !== undefined) {
      process.env.EVAL_TARGET_MODEL = originalEvalTargetModel;
    } else {
      delete process.env.EVAL_TARGET_MODEL;
    }
  });

  it('runs case-generation suite with mock judge and produces deterministic metrics', async () => {
    const result = await runSuite({
      suite: {
        name: 'case-generation',
        version: '1.0.0',
        executor: {
          type: 'in_process',
          target_module: 'src/eval/_test/fake_case_design',
          target_export: 'generateCases',
          expected_outputs: ['raw-output/cases.yaml'],
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

    // Verify P/R/F1 are 1 since human_label and judge label match
    expect(score.metrics.precision).toBe(1);
    expect(score.metrics.recall).toBe(1);
    expect(score.metrics.f1).toBe(1);

    // Verify manifest contains judge info
    const manifest = JSON.parse(
      fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf-8')
    );
    expect(manifest.judge_model).toBe('gpt-4o');
    expect(manifest.judge_prompt_hash).toBeDefined();
    expect(manifest.judge_temperature).toBe(0.0);
  });
});
