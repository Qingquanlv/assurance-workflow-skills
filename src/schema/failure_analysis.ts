import { z } from 'zod';
import type { FailureAnalysis } from '../core/types';
import type { AssertAssignable } from './types';

const failureCategory = z.enum([
  'environment_failure','test_data_failure','locator_failure','wait_strategy_failure',
  'assertion_failure','assertion_expectation_error','business_logic_failure','case_semantic_failure',
  'test_code_error','known_product_issue','coverage_gap','fuzz_configuration_error','fuzz_stateful_failure',
  'perf_script_error','perf_threshold_exceeded','perf_environment','manifest_asset_missing','unknown',
]);
const severity = z.enum(['low', 'medium', 'high', 'critical']);
const inspectFinal = z.enum(['PASS', 'PASS_WITH_WARNINGS', 'FAIL', 'SKIPPED']);

const evidence = z.object({
  result_file: z.string(), test_file: z.string(), trace: z.string(), screenshot: z.string(),
  video: z.string(), raw_log: z.string(), log_excerpt: z.string(),
});
const failureEntry = z.object({
  id: z.string().optional(),
  case_id: z.string(),
  test: z.string().optional(),
  target: z.enum(['api', 'e2e', 'fuzz', 'performance', 'coverage']),
  category: failureCategory,
  fix_proposal_eligible: z.boolean(),
  severity,
  evidence,
  diagnosis: z.string(),
  recommended_action: z.string(),
  recommended_next_action: z.string().optional(),
  needs_review: z.boolean().optional(),
  reclassified: z.object({ from: failureCategory, evidence: z.string(), at: z.string() }).optional(),
});

export const failureAnalysisSchema = z.object({
  schema_version: z.literal('1.0'),
  change_id: z.string(),
  source_manifest: z.string(),
  inspection_status: z.enum(['completed', 'skipped', 'failed']),
  batch_id: z.string(),
  source_batch_id: z.string(),
  final_status: inspectFinal,
  inspect_mode: z.enum(['primary', 'compat_fallback']),
  warnings: z.array(z.string()).optional(),
  classification_performed: z.boolean(),
  status: z.enum(['analyzed', 'no_failures', 'skipped', 'failed']),
  failures: z.array(failureEntry),
  hard_fails: z.array(failureEntry),
  needs_review: z.array(failureEntry),
  known_product_issues: z.array(failureEntry),
  coverage_gaps: z.array(z.object({ file: z.string(), line_coverage: z.number(), threshold: z.number() })).optional(),
});

export type _FaOk = AssertAssignable<z.infer<typeof failureAnalysisSchema>, FailureAnalysis>;

export function validateFailureAnalysis(raw: unknown): { ok: boolean; errors: string[] } {
  const parsed = failureAnalysisSchema.safeParse(raw);
  if (parsed.success) return { ok: true, errors: [] };
  return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}
