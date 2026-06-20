import type { DatasetSample, SampleScore } from '../types';
import {
  resolveRawOutputDir,
  runPytestCollectOnly,
  scoreCodegenSummaryPresentRate,
  scoreEvidenceIntegrity,
  scoreForbiddenWriteExecutedCount,
  scorePlanGateSatisfiedRate,
  scorePySyntaxValidRate,
  scoreSecretLeakCount,
  scoreTargetFileCoverageRate,
} from './_shared/workflow_metrics';

export function score(sample: DatasetSample, attemptDir: string): SampleScore {
  const rawOutputDir = resolveRawOutputDir(attemptDir);
  const input = sample.input as {
    project_dir?: string;
    test_collect_paths?: string[];
  };
  const projectDir = input.project_dir ?? process.cwd();
  const testPaths = input.test_collect_paths ?? ['tests/api'];

  const collect = runPytestCollectOnly({
    projectDir,
    testPaths,
    syncFromRawOutput: rawOutputDir,
  });

  const testsScanRoot = projectDir;

  const metrics: Record<string, number> = {
    evidence_integrity: scoreEvidenceIntegrity(attemptDir),
    schema_valid_rate: scorePySyntaxValidRate(testsScanRoot, 'tests/api/**/*.py'),
    collection_success_rate: collect.collection_success_rate,
    test_executable_rate: collect.test_executable_rate,
    secret_leak_count: scoreSecretLeakCount({
      attemptDir,
      rawOutputDir,
      rawOutputGlobs: ['codegen/**', 'tests/**'],
      extraScanRoots: [{ root: projectDir, globs: ['tests/**/*.py'] }],
    }),
    forbidden_write_executed_count: scoreForbiddenWriteExecutedCount(attemptDir),
    codegen_summary_present_rate: scoreCodegenSummaryPresentRate(rawOutputDir),
    plan_gate_satisfied_rate: scorePlanGateSatisfiedRate(rawOutputDir),
    target_file_coverage_rate: scoreTargetFileCoverageRate(rawOutputDir),
  };

  return {
    sample_id: sample.id,
    status: 'ok',
    metrics,
  };
}
