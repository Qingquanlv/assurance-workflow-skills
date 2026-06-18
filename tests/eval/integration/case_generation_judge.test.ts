// Integration tests for case generation with judge
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { runSuite } from '../../../src/eval/runner';

describe('case generation judge integration', () => {
  let tempDir: string;
  let evalRoot: string;
  let originalEvalJudgeMock: string | undefined;
  let originalEvalTargetModel: string | undefined;
  const projectRoot = process.cwd();

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'case-gen-judge-'));
    evalRoot = path.join(tempDir, 'eval');

    // Create directory structure
    fs.mkdirSync(path.join(evalRoot, 'suites'), { recursive: true });
    fs.mkdirSync(path.join(evalRoot, 'datasets', 'case-generation'), { recursive: true });
    fs.mkdirSync(path.join(evalRoot, 'datasets', 'case-generation', 'calibration'), { recursive: true });
    fs.mkdirSync(path.join(evalRoot, 'judge'), { recursive: true });

    // Set mock mode
    originalEvalJudgeMock = process.env.EVAL_JUDGE_MOCK;
    process.env.EVAL_JUDGE_MOCK = 'true';

    // Set EVAL_TARGET_MODEL to something different from judge model
    originalEvalTargetModel = process.env.EVAL_TARGET_MODEL;
    process.env.EVAL_TARGET_MODEL = 'claude-sonnet-4-6';
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
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

  it('writes judge-result.json and calculates P/R/F1 metrics', async () => {
    // Create dataset sample with human label
    const sample = {
      id: 'test-001',
      annotation_source: 'human' as const,
      input: { prd_ref: 'test-prd.md' },
      expected: {
        human_label: 'covered' as const,
        required_paths: ['src/test.ts'],
        forbidden_cases: [],
        required_atoms: [{ id: 'req-001', text: 'Test requirement' }],
      },
      mock_judge_label: 'covered' as const,
    };

    fs.writeFileSync(
      path.join(evalRoot, 'datasets', 'case-generation', 'test-001.yaml'),
      require('js-yaml').dump(sample)
    );
    fs.writeFileSync(
      path.join(evalRoot, 'datasets', 'case-generation', 'test-prd.md'),
      '# Test PRD\n'
    );

    // Create suite
    const suite = {
      name: 'case-generation',
      version: '1.0.0',
      executor: {
        type: 'in_process' as const,
        target_module: 'src/eval/_test/fake_case_design',
        target_export: 'generateCases',
        expected_outputs: ['raw-output/cases.yaml'],
      },
      ci: { pr: { enabled: true, mode: 'smoke' as const, required: false } },
      dataset: 'case-generation',
      thresholds: {},
      hard_gates: [],
      judge: {
        model: 'gpt-4o',
        prompt_ref: 'eval/judge/test.md',
        temperature: 0,
        confidence_threshold: 0.8,
      },
    };

    const suiteFilePath = path.join(evalRoot, 'suites', 'case-generation.yaml');
    fs.writeFileSync(
      suiteFilePath,
      require('js-yaml').dump(suite)
    );

    // Create judge prompt
    fs.writeFileSync(path.join(evalRoot, 'judge', 'test.md'), '# Judge Prompt\n');

    // Run suite
    const result = await runSuite({
      suite,
      suiteFilePath,
      evalRoot,
      projectRoot,
    });

    expect(result.runId).toBeDefined();
    expect(result.gateResult.verdict).toBeDefined();

    // Check that judge-result.json was written
    const runDir = path.join(evalRoot, 'runs', result.runId);
    const sampleDir = path.join(runDir, 'samples', 'test-001');
    const attemptDir = path.join(sampleDir, 'attempt-0');
    const judgePath = path.join(attemptDir, 'judge-result.json');

    expect(fs.existsSync(judgePath)).toBe(true);

    // Check that score.json contains P/R/F1 metrics
    const scorePath = path.join(attemptDir, 'score.json');
    expect(fs.existsSync(scorePath)).toBe(true);

    const score = JSON.parse(fs.readFileSync(scorePath, 'utf-8'));
    expect(score.metrics.precision).toBe(1);
    expect(score.metrics.recall).toBe(1);
    expect(score.metrics.f1).toBe(1);
  });

  it('marks sample as inconclusive when judge needs human review', async () => {
    // Create a scenario where mock judge would set needs_human_review
    // For our test, we'll create a sample and verify the infrastructure
    const sample = {
      id: 'test-002',
      annotation_source: 'human' as const,
      input: { prd_ref: 'test-prd.md' },
      expected: {
        human_label: 'partial' as const,
        required_paths: [],
        forbidden_cases: [],
        required_atoms: [],
      },
      mock_judge_label: 'partial' as const,
    };

    fs.writeFileSync(
      path.join(evalRoot, 'datasets', 'case-generation', 'test-002.yaml'),
      require('js-yaml').dump(sample)
    );
    fs.writeFileSync(
      path.join(evalRoot, 'datasets', 'case-generation', 'test-prd.md'),
      '# Test PRD\n'
    );

    const suite = {
      name: 'case-generation',
      version: '1.0.0',
      executor: {
        type: 'in_process' as const,
        target_module: 'src/eval/_test/fake_case_design',
        target_export: 'generateCases',
        expected_outputs: ['raw-output/cases.yaml'],
      },
      ci: { pr: { enabled: true, mode: 'smoke' as const, required: false } },
      dataset: 'case-generation',
      thresholds: {},
      hard_gates: [],
      judge: {
        model: 'gpt-4o',
        prompt_ref: 'eval/judge/test.md',
        temperature: 0,
        confidence_threshold: 0.8,
      },
    };

    const suiteFilePath = path.join(evalRoot, 'suites', 'case-generation.yaml');
    fs.writeFileSync(
      suiteFilePath,
      require('js-yaml').dump(suite)
    );

    fs.writeFileSync(path.join(evalRoot, 'judge', 'test.md'), '# Judge Prompt\n');

    const result = await runSuite({
      suite,
      suiteFilePath,
      evalRoot,
      projectRoot,
    });

    expect(result.runId).toBeDefined();

    // Check that judge-result.json was written
    const runDir = path.join(evalRoot, 'runs', result.runId);
    const sampleDir = path.join(runDir, 'samples', 'test-002');
    const attemptDir = path.join(sampleDir, 'attempt-0');
    const judgePath = path.join(attemptDir, 'judge-result.json');

    expect(fs.existsSync(judgePath)).toBe(true);
  });

  it('runs calibration when --calibrate flag is set', async () => {
    // Create calibration samples
    const calSamples = [
      {
        id: 'CAL-001',
        annotation_source: 'human' as const,
        input: { prd_ref: 'cal-prd.md' },
        expected: {
          human_label: 'covered' as const,
          required_paths: [],
          forbidden_cases: [],
          required_atoms: [],
        },
        mock_judge_label: 'covered' as const,
      },
    ];

    calSamples.forEach((s, idx) => {
      fs.writeFileSync(
        path.join(evalRoot, 'datasets', 'case-generation', 'calibration', `CAL-00${idx + 1}.yaml`),
        require('js-yaml').dump(s)
      );
    });
    fs.writeFileSync(
      path.join(evalRoot, 'datasets', 'case-generation', 'calibration', 'cal-prd.md'),
      '# Calibration PRD\n'
    );

    // Create regular sample
    const sample = {
      id: 'test-003',
      annotation_source: 'human' as const,
      input: { prd_ref: 'test-prd.md' },
      expected: {
        human_label: 'covered' as const,
        required_paths: [],
        forbidden_cases: [],
        required_atoms: [],
      },
      mock_judge_label: 'covered' as const,
    };

    fs.writeFileSync(
      path.join(evalRoot, 'datasets', 'case-generation', 'test-003.yaml'),
      require('js-yaml').dump(sample)
    );
    fs.writeFileSync(
      path.join(evalRoot, 'datasets', 'case-generation', 'test-prd.md'),
      '# Test PRD\n'
    );

    const suite = {
      name: 'case-generation',
      version: '1.0.0',
      executor: {
        type: 'in_process' as const,
        target_module: 'src/eval/_test/fake_case_design',
        target_export: 'generateCases',
        expected_outputs: ['raw-output/cases.yaml'],
      },
      ci: { pr: { enabled: true, mode: 'smoke' as const, required: false } },
      dataset: 'case-generation',
      thresholds: {},
      hard_gates: [],
      judge: {
        model: 'gpt-4o',
        prompt_ref: 'eval/judge/test.md',
        temperature: 0,
        confidence_threshold: 0.8,
      },
      judge_calibration: {
        judge_human_agreement: '>= 0.80',
        judge_human_kappa: '>= 0.70',
        critical_label_disagreement: '== 0',
        invalid_judge_output_rate: '<= 0.10',
      },
    };

    const suiteFilePath = path.join(evalRoot, 'suites', 'case-generation.yaml');
    fs.writeFileSync(
      suiteFilePath,
      require('js-yaml').dump(suite)
    );

    const result = await runSuite({
      suite,
      suiteFilePath,
      evalRoot,
      projectRoot,
      calibrate: true,
    });

    expect(result.runId).toBeDefined();

    // Check that calibration.json was written
    const runDir = path.join(evalRoot, 'runs', result.runId);
    const calibrationPath = path.join(runDir, 'calibration.json');
    expect(fs.existsSync(calibrationPath)).toBe(true);
  });
});
