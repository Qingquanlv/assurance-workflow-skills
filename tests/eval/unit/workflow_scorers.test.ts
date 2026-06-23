import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { score as scoreWorkflowCase } from '../../../src/eval/scorers/workflow_case';
import { score as scoreWorkflowApiCodegen } from '../../../src/eval/scorers/workflow_api_codegen';
import { score as scoreWorkflowE2eCodegen } from '../../../src/eval/scorers/workflow_e2e_codegen';
import { score as scoreWorkflowFuzzCodegen } from '../../../src/eval/scorers/workflow_fuzz_codegen';
import { score as scoreWorkflowPerformanceCodegen } from '../../../src/eval/scorers/workflow_performance_codegen';
import { score as scoreWorkflowFull } from '../../../src/eval/scorers/workflow_full';
import { score as scoreWorkflowRun } from '../../../src/eval/scorers/workflow_run';
import { score as scoreSafetyLite } from '../../../src/eval/scorers/safety_lite';
import { score as scoreClassificationUnit } from '../../../src/eval/scorers/classification_unit';
import type { DatasetSample } from '../../../src/eval/types';

const FIXTURE_SAMPLE = path.join(
  __dirname,
  '../../../eval/fixtures/samples/eval-sample-001'
);
const FIXTURE_SAMPLE_002 = path.join(
  __dirname,
  '../../../eval/fixtures/samples/eval-sample-002'
);
const SAFETY_ATTEMPT = path.join(
  __dirname,
  '../../../eval/fixtures/attempts/safety-smoke'
);

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(srcPath, destPath);
    else fs.copyFileSync(srcPath, destPath);
  }
}

function writeAttemptEvidence(attemptDir: string): void {
  fs.writeFileSync(path.join(attemptDir, 'stdout.log'), 'eval stdout\n');
  fs.writeFileSync(path.join(attemptDir, 'stderr.log'), '');
  fs.writeFileSync(
    path.join(attemptDir, 'execution.json'),
    JSON.stringify({ exit_code: 0, safety_mode: 'enabled' })
  );
  const evidenceDir = path.join(attemptDir, 'evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(
    path.join(evidenceDir, 'write-diff.json'),
    JSON.stringify({ forbidden_write_executed_count: 0 })
  );
}

function seedCaseDesignRawOutput(attemptDir: string): void {
  const raw = path.join(attemptDir, 'raw-output');
  fs.mkdirSync(path.join(raw, 'cases/users'), { recursive: true });
  fs.mkdirSync(path.join(raw, 'review'), { recursive: true });
  fs.copyFileSync(
    path.join(FIXTURE_SAMPLE, 'cases/users/case.yaml'),
    path.join(raw, 'cases/users/case.yaml')
  );
  fs.copyFileSync(
    path.join(FIXTURE_SAMPLE, 'review/case-review.json'),
    path.join(raw, 'review/case-review.json')
  );
  fs.copyFileSync(
    path.join(FIXTURE_SAMPLE, 'workflow-state.yaml'),
    path.join(raw, 'workflow-state.yaml')
  );
}

function seedFullRawOutputFromFixture(attemptDir: string): void {
  copyDirSync(FIXTURE_SAMPLE, path.join(attemptDir, 'raw-output'));
}

describe('workflow scorers (fixture snapshots)', () => {
  let attemptDir: string;

  beforeEach(() => {
    attemptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-scorer-'));
    writeAttemptEvidence(attemptDir);
  });

  afterEach(() => {
    fs.rmSync(attemptDir, { recursive: true, force: true });
  });

  it('workflow_case emits hard-gate metrics from archived fixture', () => {
    seedCaseDesignRawOutput(attemptDir);
    const sample: DatasetSample = {
      id: 'WC-001',
      annotation_source: 'human',
      tags: ['workflow-case'],
      input: {
        change_id: 'eval-sample-001',
        fixture_tier: 'L0-case-seed',
        run_mode: 'case-only',
        project_dir: 'bench/fastapi-vue-admin',
      },
      expected: {},
    };

    const result = scoreWorkflowCase(sample, attemptDir);

    expect(result.status).toBe('ok');
    expect(result.metrics.evidence_integrity).toBe(1);
    expect(result.metrics.schema_valid_rate).toBe(1);
    expect(result.metrics.layer_scan_valid_rate).toBe(1);
    expect(result.metrics.case_review_gate_pass_rate).toBe(1);
    expect(result.metrics.secret_leak_count).toBe(0);
    expect(result.metrics.forbidden_write_executed_count).toBe(0);
  });

  it('workflow_run scores E3 Definition B from execution manifest fixture', () => {
    seedFullRawOutputFromFixture(attemptDir);
    const rawOutputDir = path.join(attemptDir, 'raw-output');
    const execDir = path.join(rawOutputDir, 'execution');
    fs.mkdirSync(execDir, { recursive: true });
    fs.writeFileSync(
      path.join(execDir, 'execution-manifest.yaml'),
      [
        'schema_version: "1.0"',
        'change_id: eval-sample-001',
        'batch_id: batch-smoke',
        'final_status: PASS',
        'selected_targets:',
        '  api: true',
        '  e2e: false',
        '  fuzz: false',
        '  performance: false',
        'result_files:',
        '  api: api-result.json',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(execDir, 'api-result.json'),
      JSON.stringify({ status: 'PASS', passed: 15, total: 15 })
    );

    const sample: DatasetSample = {
      id: 'WR-001',
      annotation_source: 'human',
      tags: ['workflow-run'],
      input: {
        change_id: 'eval-sample-001',
        fixture_tier: 'L3-run-seed',
        project_dir: 'bench/fastapi-vue-admin',
      },
      expected: {},
    };

    const result = scoreWorkflowRun(sample, attemptDir);

    expect(result.status).toBe('ok');
    expect(result.metrics.test_executable_rate).toBe(1);
    expect(result.metrics.execution_pass_rate).toBe(1);
    expect(result.metrics.api_pass_rate).toBe(1);
  });

  it('workflow_api_codegen emits collect + observe metrics', () => {
    seedFullRawOutputFromFixture(attemptDir);
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-api-proj-'));
    copyDirSync(path.join(FIXTURE_SAMPLE, 'tests'), path.join(projectDir, 'tests'));

    const sample: DatasetSample = {
      id: 'WAC-001',
      annotation_source: 'human',
      tags: ['workflow-api-codegen'],
      input: {
        change_id: 'eval-sample-001',
        fixture_tier: 'L2-api-codegen-seed',
        run_mode: 'codegen-only',
        project_dir: projectDir,
        test_types: ['api'],
        test_collect_paths: ['tests/api'],
      },
      expected: {},
    };

    const result = scoreWorkflowApiCodegen(sample, attemptDir);

    expect(result.status).toBe('ok');
    expect(result.metrics.evidence_integrity).toBe(1);
    expect(result.metrics.schema_valid_rate).toBe(1);
    expect(typeof result.metrics.collection_success_rate).toBe('number');
    expect(typeof result.metrics.test_executable_rate).toBe('number');
    expect(result.metrics.codegen_summary_present_rate).toBe(0);
    expect(result.metrics.plan_gate_satisfied_rate).toBe(1);

    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('workflow_e2e_codegen emits collect + observe metrics', () => {
    copyDirSync(FIXTURE_SAMPLE_002, path.join(attemptDir, 'raw-output'));
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-e2e-proj-'));
    copyDirSync(
      path.join(FIXTURE_SAMPLE_002, 'tests/e2e/eval'),
      path.join(projectDir, 'tests/e2e/eval')
    );

    const result = scoreWorkflowE2eCodegen(
      {
        id: 'WEEC-001',
        annotation_source: 'human',
        tags: ['workflow-e2e-codegen'],
        input: {
          change_id: 'eval-sample-002',
          fixture_tier: 'L2-e2e-codegen-seed-roles',
          project_dir: projectDir,
          test_collect_paths: ['tests/e2e/eval'],
          pytest_confcutdir: 'tests/e2e/eval',
        },
        expected: {},
      },
      attemptDir
    );

    expect(result.status).toBe('ok');
    expect(result.metrics.evidence_integrity).toBe(1);
    expect(result.metrics.schema_valid_rate).toBe(1);
    expect(result.metrics.framework_compliance_rate).toBe(1);
    expect(result.metrics.plan_gate_satisfied_rate).toBe(1);

    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('workflow_fuzz_codegen emits fuzz observe metrics', () => {
    copyDirSync(FIXTURE_SAMPLE_002, path.join(attemptDir, 'raw-output'));
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-fuzz-proj-'));
    copyDirSync(
      path.join(FIXTURE_SAMPLE_002, 'tests/fuzz'),
      path.join(projectDir, 'tests/fuzz')
    );

    const result = scoreWorkflowFuzzCodegen(
      {
        id: 'WFUZ-001',
        annotation_source: 'human',
        tags: ['workflow-fuzz-codegen'],
        input: {
          change_id: 'eval-sample-002',
          fixture_tier: 'L2-fuzz-codegen-seed-roles',
          project_dir: projectDir,
          test_collect_paths: ['tests/fuzz'],
        },
        expected: {},
      },
      attemptDir
    );

    expect(result.status).toBe('ok');
    expect(result.metrics.fuzz_plan_gate_pass_rate).toBe(1);
    expect(typeof result.metrics.openapi_ref_valid_rate).toBe('number');

    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('workflow_performance_codegen emits locust metrics', () => {
    copyDirSync(FIXTURE_SAMPLE_002, path.join(attemptDir, 'raw-output'));
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-perf-proj-'));
    copyDirSync(
      path.join(FIXTURE_SAMPLE_002, 'tests/perf'),
      path.join(projectDir, 'tests/perf')
    );

    const result = scoreWorkflowPerformanceCodegen(
      {
        id: 'WPER-001',
        annotation_source: 'human',
        tags: ['workflow-performance-codegen'],
        input: {
          change_id: 'eval-sample-002',
          fixture_tier: 'L2-performance-codegen-seed-roles',
          project_dir: projectDir,
        },
        expected: {},
      },
      attemptDir
    );

    expect(result.status).toBe('ok');
    expect(result.metrics.performance_plan_gate_pass_rate).toBe(1);
    expect(result.metrics.threshold_declared_rate).toBe(1);
    expect(result.metrics.schema_valid_rate).toBe(1);

    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('workflow_full emits E4 observe metrics from execution stub', () => {
    seedFullRawOutputFromFixture(attemptDir);
    const rawOutputDir = path.join(attemptDir, 'raw-output');
    const execDir = path.join(rawOutputDir, 'execution');
    fs.mkdirSync(execDir, { recursive: true });
    fs.writeFileSync(
      path.join(execDir, 'execution-manifest.yaml'),
      [
        'schema_version: "1.0"',
        'change_id: eval-sample-001',
        'batch_id: eval-fake-full',
        'final_status: PASS',
        'selected_targets:',
        '  api: true',
        '  e2e: false',
        'result_files:',
        '  api: api-result.json',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(execDir, 'api-result.json'),
      JSON.stringify({ status: 'PASS', passed: 1, total: 1 })
    );
    fs.writeFileSync(
      path.join(attemptDir, 'execution.json'),
      JSON.stringify({
        timed_out: false,
        duration_ms: 120000,
        archive_completed: true,
        evidence_completed: true,
      })
    );

    const result = scoreWorkflowFull(
      {
        id: 'WF-001',
        annotation_source: 'human',
        tags: ['workflow-full'],
        input: {
          change_id: 'eval-sample-001',
          fixture_tier: 'L3-run-seed',
          run_mode: 'full',
          project_dir: 'bench/fastapi-vue-admin',
        },
        expected: {},
      },
      attemptDir
    );

    expect(result.status).toBe('ok');
    expect(result.metrics.full_run_completed_rate).toBe(1);
    expect(result.metrics.end_to_end_pass_rate).toBe(1);
    expect(result.metrics.wall_time_seconds).toBe(120);
    expect(result.metrics.evidence_integrity_diag).toBe(1);
  });
});

describe('safety_lite scorer', () => {
  it('scores referenced attempt dir with hard gates', () => {
    const attemptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-attempt-'));
    const sample: DatasetSample = {
      id: 'SL-001',
      annotation_source: 'human',
      tags: ['safety-lite'],
      input: {
        attempt_dir_ref: SAFETY_ATTEMPT,
      },
      expected: {},
    };

    const result = scoreSafetyLite(sample, attemptDir);

    expect(result.status).toBe('ok');
    expect(result.metrics.evidence_integrity).toBe(1);
    expect(result.metrics.secret_leak_count).toBe(0);
    expect(result.metrics.forbidden_write_executed_count).toBe(0);

    fs.rmSync(attemptDir, { recursive: true, force: true });
  });

  it('returns inconclusive when safety_mode is disabled', () => {
    const refDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-disabled-'));
    fs.writeFileSync(path.join(refDir, 'stdout.log'), 'ok');
    fs.writeFileSync(path.join(refDir, 'stderr.log'), '');
    fs.writeFileSync(
      path.join(refDir, 'execution.json'),
      JSON.stringify({ safety_mode: 'disabled' })
    );

    const sample: DatasetSample = {
      id: 'SL-DISABLED',
      annotation_source: 'synthetic',
      tags: ['safety-lite'],
      input: { attempt_dir_ref: refDir },
      expected: {},
    };

    const result = scoreSafetyLite(sample, fs.mkdtempSync(path.join(os.tmpdir(), 'sl-run-')));

    expect(result.status).toBe('inconclusive');
    fs.rmSync(refDir, { recursive: true, force: true });
  });
});

describe('classification_unit scorer', () => {
  it('emits unknown_rate and category_match for labeled samples', () => {
    const attemptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-attempt-'));
    writeAttemptEvidence(attemptDir);

    const cases: Array<{
      id: string;
      message: string;
      log: string;
      target: 'api' | 'e2e';
      expected: string;
    }> = [
      {
        id: 'FC-001',
        message: "element not found waiting for selector getByRole('button')",
        log: 'locator strict mode violation',
        target: 'e2e',
        expected: 'locator_failure',
      },
      {
        id: 'FC-003',
        message: 'AssertionError: expected 200 but received 401',
        log: 'assert response.status_code == 200',
        target: 'api',
        expected: 'assertion_failure',
      },
      {
        id: 'FC-005',
        message: 'Something completely unexpected happened',
        log: 'no recognizable failure signature',
        target: 'api',
        expected: 'unknown',
      },
    ];

    for (const c of cases) {
      const sample: DatasetSample = {
        id: c.id,
        annotation_source: 'human',
        tags: ['classification-unit'],
        input: { message: c.message, log_excerpt: c.log, target: c.target },
        expected: { category: c.expected },
      };
      const result = scoreClassificationUnit(sample, attemptDir);
      expect(result.status).toBe('ok');
      expect(result.metrics.category_match_rate).toBe(1);
      if (c.expected === 'unknown') {
        expect(result.metrics.unknown_rate).toBe(1);
      } else {
        expect(result.metrics.unknown_rate).toBe(0);
      }
    }

    fs.rmSync(attemptDir, { recursive: true, force: true });
  });
});
