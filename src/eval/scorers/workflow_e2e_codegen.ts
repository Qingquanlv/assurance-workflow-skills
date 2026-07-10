import type { DatasetSample, SampleScore } from '../types';
import { resolveSampleProjectDir } from '../sut_registry';
import {
  buildCodegenSecretScanOpts,
  resolveAttemptEvidenceRoots,
  scoreFrameworkComplianceRate,
} from './_shared/codegen_scorer_helpers';
import { scoreOpenCodeProcessMetrics } from './_shared/opencode_process_metrics';
import {
  resolveRawOutputDir,
  runPytestCollectOnly,
  scoreCodegenSummaryPresentRate,
  scoreEvidenceIntegrity,
  scoreForbiddenWriteExecutedCount,
  scorePlanGateSatisfiedRate,
  scorePySyntaxValidRate,
  scoreTargetFileCoverageRate,
  scoreSecretLeakCount,
} from './_shared/workflow_metrics';

export function score(sample: DatasetSample, attemptDir: string): SampleScore {
  resolveAttemptEvidenceRoots(attemptDir);
  const rawOutputDir = resolveRawOutputDir(attemptDir);
  const input = sample.input as {
    sut?: string;
    project_dir?: string;
    test_collect_paths?: string[];
  };
  const projectDir = resolveSampleProjectDir(input);
  const testPaths = input.test_collect_paths ?? ['tests/e2e/eval'];
  const confcutdir =
    (input as { pytest_confcutdir?: string }).pytest_confcutdir ?? 'tests/e2e/eval';

  const collect = runPytestCollectOnly({
    projectDir,
    testPaths,
    syncFromRawOutput: rawOutputDir,
    syncSubpaths: ['tests/e2e'],
    confcutdir,
  });

  const metrics: Record<string, number> = {
    evidence_integrity: scoreEvidenceIntegrity(attemptDir),
    schema_valid_rate: scorePySyntaxValidRate(projectDir, 'tests/e2e/eval/**/*.py'),
    collection_success_rate: collect.collection_success_rate,
    test_executable_rate: collect.test_executable_rate,
    secret_leak_count: scoreSecretLeakCount(
      buildCodegenSecretScanOpts({
        attemptDir,
        projectDir,
        generatedGlobs: ['tests/e2e/eval/**/*.py'],
        summaryRelativePaths: ['codegen/e2e-codegen-summary.md'],
      })
    ),
    forbidden_write_executed_count: scoreForbiddenWriteExecutedCount(attemptDir),
    codegen_summary_present_rate: scoreCodegenSummaryPresentRate(
      rawOutputDir,
      'codegen/e2e-codegen-summary.md'
    ),
    framework_compliance_rate: scoreFrameworkComplianceRate(projectDir),
    plan_gate_satisfied_rate: scorePlanGateSatisfiedRate(
      rawOutputDir,
      'review/e2e-plan-review.json'
    ),
    target_file_coverage_rate: scoreTargetFileCoverageRate(
      rawOutputDir,
      'plans/e2e-codegen-plan.md',
      projectDir
    ),
    ...scoreOpenCodeProcessMetrics(attemptDir),
  };

  return {
    sample_id: sample.id,
    status: 'ok',
    metrics,
  };
}
