import type { DatasetSample, SampleScore } from '../types';
import {
  resolveRawOutputDir,
  scoreApiPassRate,
  scoreE2ePassRate,
  scoreEvidenceIntegrity,
  scoreExecutionPassRate,
  scoreForbiddenWriteExecutedCount,
  scoreFuzzPassRate,
  scorePerformancePassRate,
  scoreSecretLeakCount,
  scoreTestExecutableRateE3,
} from './_shared/workflow_metrics';

export function score(sample: DatasetSample, attemptDir: string): SampleScore {
  const rawOutputDir = resolveRawOutputDir(attemptDir);

  const metrics: Record<string, number> = {
    evidence_integrity: scoreEvidenceIntegrity(attemptDir),
    test_executable_rate: scoreTestExecutableRateE3(rawOutputDir),
    secret_leak_count: scoreSecretLeakCount({
      attemptDir,
      rawOutputDir,
      rawOutputGlobs: ['execution/**/raw/**/*.log', 'execution/**/*.log'],
    }),
    forbidden_write_executed_count: scoreForbiddenWriteExecutedCount(attemptDir),
    execution_pass_rate: scoreExecutionPassRate(rawOutputDir),
    api_pass_rate: scoreApiPassRate(rawOutputDir),
    e2e_pass_rate: scoreE2ePassRate(rawOutputDir),
    fuzz_pass_rate: scoreFuzzPassRate(rawOutputDir),
    performance_pass_rate: scorePerformancePassRate(rawOutputDir),
  };

  return {
    sample_id: sample.id,
    status: 'ok',
    metrics,
  };
}
