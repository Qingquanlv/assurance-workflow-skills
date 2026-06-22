import type { DatasetSample, SampleScore } from '../types';
import {
  buildCodegenSecretScanOpts,
  resolveAttemptEvidenceRoots,
  scoreOpenapiRefValidRate,
} from './_shared/codegen_scorer_helpers';
import {
  resolveRawOutputDir,
  runPytestCollectOnly,
  scoreCodegenSummaryPresentRate,
  scoreEvidenceIntegrity,
  scoreForbiddenWriteExecutedCount,
  scoreFuzzSchemaValidRate,
  scorePlanGateSatisfiedRate,
  scoreTargetFileCoverageRate,
  scoreSecretLeakCount,
} from './_shared/workflow_metrics';

export function score(sample: DatasetSample, attemptDir: string): SampleScore {
  resolveAttemptEvidenceRoots(attemptDir);
  const rawOutputDir = resolveRawOutputDir(attemptDir);
  const input = sample.input as {
    project_dir?: string;
    test_collect_paths?: string[];
  };
  const projectDir = input.project_dir ?? process.cwd();
  const testPaths = input.test_collect_paths ?? ['tests/fuzz'];

  const collect = runPytestCollectOnly({
    projectDir,
    testPaths,
    syncFromRawOutput: rawOutputDir,
    syncSubpaths: ['tests/fuzz'],
  });

  const metrics: Record<string, number> = {
    evidence_integrity: scoreEvidenceIntegrity(attemptDir),
    schema_valid_rate: scoreFuzzSchemaValidRate(projectDir),
    collection_success_rate: collect.collection_success_rate,
    test_executable_rate: collect.test_executable_rate,
    secret_leak_count: scoreSecretLeakCount(
      buildCodegenSecretScanOpts({
        attemptDir,
        projectDir,
        generatedGlobs: ['tests/fuzz/**/*.py'],
        summaryRelativePaths: ['codegen/fuzz-codegen-summary.md'],
      })
    ),
    forbidden_write_executed_count: scoreForbiddenWriteExecutedCount(attemptDir),
    fuzz_plan_gate_pass_rate: scorePlanGateSatisfiedRate(
      rawOutputDir,
      'review/fuzz-plan-review.json'
    ),
    openapi_ref_valid_rate: scoreOpenapiRefValidRate(projectDir),
    codegen_summary_present_rate: scoreCodegenSummaryPresentRate(
      rawOutputDir,
      'codegen/fuzz-codegen-summary.md'
    ),
    target_file_coverage_rate: scoreTargetFileCoverageRate(
      rawOutputDir,
      'plans/fuzz-codegen-plan.md',
      projectDir
    ),
  };

  return {
    sample_id: sample.id,
    status: 'ok',
    metrics,
  };
}
