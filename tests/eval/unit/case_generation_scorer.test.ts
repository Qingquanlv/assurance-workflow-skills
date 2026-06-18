import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { score } from '../../../src/eval/scorers/case_generation';
import { judge } from '../../../src/eval/judge/judge';
import { generateCases } from '../../../src/eval/_test/fake_case_design';
import type { DatasetSample } from '../../../src/eval/types';
import * as yaml from 'js-yaml';

describe('case_generation scorer', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'case-gen-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('calculates deterministic metrics correctly', () => {
    const sample: DatasetSample = {
      id: 'CG-001',
      annotation_source: 'human',
      tags: ['case-generation'],
      input: { change_id: 'CG-001' },
      expected: {
        required_paths: ['POST /api/v1/test', 'GET /api/v1/test'],
        forbidden_cases: ['bad thing'],
        required_atoms: [
          { id: 'RA-001', text: 'Test case 1' },
          { id: 'RA-002', text: 'Test case 2' },
        ],
      },
    };

    // Run fake executor
    generateCases(sample, tmpDir);

    // Score it
    const result = score(sample, tmpDir);

    expect(result.status).toBe('ok');
    expect(result.metrics.schema_valid_rate).toBe(1);
    expect(result.metrics.hallucination_rate).toBe(0);
    expect(result.metrics.path_coverage_rate).toBe(0.5); // Only first path
    expect(result.metrics.traceability_rate).toBe(1);
    expect(result.metrics.precision).toBe(0);
    expect(result.metrics.recall).toBe(0);
    expect(result.metrics.f1).toBe(0);
  });

  it('returns 0 for schema_valid_rate when cases.yaml is missing', () => {
    const sample: DatasetSample = {
      id: 'CG-001',
      annotation_source: 'human',
      tags: ['case-generation'],
      input: { change_id: 'CG-001' },
      expected: {},
    };

    const result = score(sample, tmpDir);

    expect(result.metrics.schema_valid_rate).toBe(0);
  });

  it('returns path_coverage_rate = 1 when there are no required_paths', () => {
    const sample: DatasetSample = {
      id: 'CG-002',
      annotation_source: 'human',
      tags: ['case-generation'],
      input: { change_id: 'CG-002' },
      expected: {
        forbidden_cases: [],
        required_atoms: [],
      },
    };

    // Generate cases without required paths
    generateCases(sample, tmpDir);

    const result = score(sample, tmpDir);

    expect(result.status).toBe('ok');
    expect(result.metrics.path_coverage_rate).toBe(1);
  });

  it('returns path_coverage_rate = 1 when required_paths is empty array', () => {
    const sample: DatasetSample = {
      id: 'CG-003',
      annotation_source: 'human',
      tags: ['case-generation'],
      input: { change_id: 'CG-003' },
      expected: {
        required_paths: [],
        forbidden_cases: [],
        required_atoms: [],
      },
    };

    // Generate cases with empty required paths array
    generateCases(sample, tmpDir);

    const result = score(sample, tmpDir);

    expect(result.status).toBe('ok');
    expect(result.metrics.path_coverage_rate).toBe(1);
  });
});

describe('mock judge', () => {
  let originalEvalJudgeMock: string | undefined;

  beforeEach(() => {
    originalEvalJudgeMock = process.env.EVAL_JUDGE_MOCK;
  });

  afterEach(() => {
    if (originalEvalJudgeMock !== undefined) {
      process.env.EVAL_JUDGE_MOCK = originalEvalJudgeMock;
    } else {
      delete process.env.EVAL_JUDGE_MOCK;
    }
  });

  it('returns mock_judge_label when EVAL_JUDGE_MOCK=true', () => {
    process.env.EVAL_JUDGE_MOCK = 'true';
    const sample: DatasetSample = {
      id: 'CG-001',
      annotation_source: 'human',
      tags: [],
      input: {},
      expected: {},
      mock_judge_label: 'covered',
    };

    const result = judge(sample, '/tmp', {
      model: 'gpt-4o',
      prompt_ref: 'test.md',
      temperature: 0.0,
      confidence_threshold: 0.8,
    });

    expect(result.label).toBe('covered');
    expect(result.confidence).toBe(1.0);
    expect(result.evidence_refs).toEqual(['CG-001']);
  });

  it('throws for invalid mock_judge_label', () => {
    process.env.EVAL_JUDGE_MOCK = 'true';
    const sample: DatasetSample = {
      id: 'CG-001',
      annotation_source: 'human',
      tags: [],
      input: {},
      expected: {},
      mock_judge_label: 'invalid' as any,
    };

    expect(() =>
      judge(sample, '/tmp', {
        model: 'gpt-4o',
        prompt_ref: 'test.md',
        temperature: 0.0,
        confidence_threshold: 0.8,
      })
    ).toThrow();
  });

  it('throws when EVAL_JUDGE_MOCK is not set', () => {
    delete process.env.EVAL_JUDGE_MOCK;
    const sample: DatasetSample = {
      id: 'CG-001',
      annotation_source: 'human',
      tags: [],
      input: {},
      expected: {},
    };

    expect(() =>
      judge(sample, '/tmp', {
        model: 'gpt-4o',
        prompt_ref: 'test.md',
        temperature: 0.0,
        confidence_threshold: 0.8,
      })
    ).toThrow('Real judge not implemented yet');
  });
});
