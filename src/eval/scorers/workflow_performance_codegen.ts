import type { DatasetSample, SampleScore } from '../types';
import {
  buildCodegenSecretScanOpts,
  resolveAttemptEvidenceRoots,
  scoreThresholdDeclaredRate,
} from './_shared/codegen_scorer_helpers';
import { runLocustListOnly, scoreLocustAstValid } from './_shared/locust_collect';
import {
  resolveRawOutputDir,
  scoreCodegenSummaryPresentRate,
  scoreEvidenceIntegrity,
  scoreForbiddenWriteExecutedCount,
  scorePlanGateSatisfiedRate,
  scoreSecretLeakCount,
  scoreTargetFileCoverageRate,
} from './_shared/workflow_metrics';

export function score(sample: DatasetSample, attemptDir: string): SampleScore {
  resolveAttemptEvidenceRoots(attemptDir);
  const rawOutputDir = resolveRawOutputDir(attemptDir);
  const input = sample.input as {
    project_dir?: string;
  };
  const projectDir = input.project_dir ?? process.cwd();

  const collect = runLocustListOnly(projectDir);
  const schemaValid = scoreLocustAstValid(projectDir);

  const metrics: Record<string, number> = {
    evidence_integrity: scoreEvidenceIntegrity(attemptDir),
    schema_valid_rate: schemaValid,
    collection_success_rate: collect.collection_success_rate,
    test_executable_rate: collect.test_executable_rate,
    secret_leak_count: scoreSecretLeakCount(
      buildCodegenSecretScanOpts({
        attemptDir,
        projectDir,
        generatedGlobs: ['qa/perf/**/*.py'],
        summaryRelativePaths: ['codegen/performance-codegen-summary.md'],
      })
    ),
    forbidden_write_executed_count: scoreForbiddenWriteExecutedCount(attemptDir),
    performance_plan_gate_pass_rate: scorePlanGateSatisfiedRate(
      rawOutputDir,
      'review/performance-plan-review.json'
    ),
    threshold_declared_rate: scoreThresholdDeclaredRate(rawOutputDir),
    codegen_summary_present_rate: scoreCodegenSummaryPresentRate(
      rawOutputDir,
      'codegen/performance-codegen-summary.md'
    ),
    target_file_coverage_rate: scoreTargetFileCoverageRate(
      rawOutputDir,
      'plans/performance-codegen-plan.md',
      projectDir
    ),
  };

  return {
    sample_id: sample.id,
    status: 'ok',
    metrics,
  };
}
