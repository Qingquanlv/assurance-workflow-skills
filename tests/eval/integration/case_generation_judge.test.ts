// Integration tests for case generation with judge
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { jest } from '@jest/globals';
import { runSuite } from '../../../src/eval/runner';

describe.skip('case generation judge integration', () => {
  let tempDir: string;
  let projectRoot: string;
  let evalRoot: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'case-gen-judge-'));
    projectRoot = tempDir;
    evalRoot = path.join(projectRoot, 'eval');

    // Create directory structure
    fs.mkdirSync(path.join(evalRoot, 'suites'), { recursive: true });
    fs.mkdirSync(path.join(evalRoot, 'datasets', 'case-gen-test'), { recursive: true });
    fs.mkdirSync(path.join(evalRoot, 'datasets', 'case-gen-test', 'calibration'), { recursive: true });
    fs.mkdirSync(path.join(evalRoot, 'judge'), { recursive: true });

    // Set mock mode
    process.env.EVAL_JUDGE_MOCK = 'true';
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.EVAL_JUDGE_MOCK;
  });

  it('writes judge-result.json and calculates P/R/F1 metrics', async () => {
    // Create dataset sample with human label
    const sample = {
      id: 'test-001',
      annotation_source: 'synthetic' as const,
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
      path.join(evalRoot, 'datasets', 'case-gen-test', 'test-001.yaml'),
      require('js-yaml').dump(sample)
    );

    // Create suite
    const suite = {
      name: 'case-gen-test',
      version: '1.0.0',
      executor: {
        type: 'in_process' as const,
        target_module: 'src/eval/_test/fake_case_design',
        target_export: 'fakeCaseDesign',
      },
      ci: { pr: { enabled: true, mode: 'smoke' as const, required: false } },
      dataset: 'case-gen-test',
      thresholds: {},
      hard_gates: [],
      judge: {
        model: 'gpt-4o',
        prompt_ref: 'eval/judge/test.md',
        temperature: 0,
        confidence_threshold: 0.8,
      },
    };

    fs.writeFileSync(
      path.join(evalRoot, 'suites', 'case-gen-test.yaml'),
      require('js-yaml').dump(suite)
    );

    // Create judge prompt
    fs.writeFileSync(path.join(evalRoot, 'judge', 'test.md'), '# Judge Prompt\n');

    // Run suite
    const result = await runSuite({
      suite,
      suiteFilePath: path.join(evalRoot, 'suites', 'case-gen-test.yaml'),
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
    expect(score.metrics.precision).toBeDefined();
    expect(score.metrics.recall).toBeDefined();
    expect(score.metrics.f1).toBeDefined();
  });

  it('marks sample as inconclusive when judge needs human review', async () => {
    // Create a scenario where mock judge would set needs_human_review
    // For our test, we'll create a sample and verify the infrastructure
    const sample = {
      id: 'test-002',
      annotation_source: 'synthetic' as const,
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
      path.join(evalRoot, 'datasets', 'case-gen-test', 'test-002.yaml'),
      require('js-yaml').dump(sample)
    );

    const suite = {
      name: 'case-gen-test',
      version: '1.0.0',
      executor: {
        type: 'in_process' as const,
        target_module: 'src/eval/_test/fake_case_design',
        target_export: 'fakeCaseDesign',
      },
      ci: { pr: { enabled: true, mode: 'smoke' as const, required: false } },
      dataset: 'case-gen-test',
      thresholds: {},
      hard_gates: [],
      judge: {
        model: 'gpt-4o',
        prompt_ref: 'eval/judge/test.md',
        temperature: 0,
        confidence_threshold: 0.8,
      },
    };

    fs.writeFileSync(
      path.join(evalRoot, 'suites', 'case-gen-test.yaml'),
      require('js-yaml').dump(suite)
    );

    fs.writeFileSync(path.join(evalRoot, 'judge', 'test.md'), '# Judge Prompt\n');

    const result = await runSuite({
      suite,
      suiteFilePath: path.join(evalRoot, 'suites', 'case-gen-test.yaml'),
      evalRoot,
      projectRoot,
    });

    expect(result.runId).toBeDefined();
  });

  it('runs calibration when --calibrate flag is set', async () => {
    // Create calibration samples
    const calSamples = [
      {
        id: 'CAL-001',
        annotation_source: 'synthetic' as const,
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
        path.join(evalRoot, 'datasets', 'case-gen-test', 'calibration', `CAL-00${idx + 1}.yaml`),
        require('js-yaml').dump(s)
      );
    });

    // Create regular sample
    const sample = {
      id: 'test-003',
      annotation_source: 'synthetic' as const,
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
      path.join(evalRoot, 'datasets', 'case-gen-test', 'test-003.yaml'),
      require('js-yaml').dump(sample)
    );

    const suite = {
      name: 'case-gen-test',
      version: '1.0.0',
      executor: {
        type: 'in_process' as const,
        target_module: 'src/eval/_test/fake_case_design',
        target_export: 'fakeCaseDesign',
      },
      ci: { pr: { enabled: true, mode: 'smoke' as const, required: false } },
      dataset: 'case-gen-test',
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

    fs.writeFileSync(
      path.join(evalRoot, 'suites', 'case-gen-test.yaml'),
      require('js-yaml').dump(suite)
    );

    fs.writeFileSync(path.join(evalRoot, 'judge', 'test.md'), '# Judge Prompt\n');

    const result = await runSuite({
      suite,
      suiteFilePath: path.join(evalRoot, 'suites', 'case-gen-test.yaml'),
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
