import { z } from 'zod';
import type { QualityGateResult } from './contracts';
import type { AssertAssignable } from './types';

const gateStatus = z.enum(['PASS', 'PASS_WITH_WARNINGS', 'FAIL', 'SKIPPED']);
const counts = z.object({ total: z.number(), passed: z.number(), failed: z.number() });
const threshold = z.object({ line: z.number(), branch: z.number(), module_line: z.number().optional(), diff_line: z.number().optional() });
const functional = z.object({
  status: gateStatus, api: counts, e2e: counts, fuzz: counts.optional(), unmapped_tests: z.number().optional(),
});
const coverageDim = z.object({
  status: gateStatus, available: z.boolean(), line_coverage: z.number(), branch_coverage: z.number(),
  threshold, scope: z.any().optional(),
});
const perfScenario = z.object({
  capability: z.string(), endpoint: z.string(), measured_p95_ms: z.number().nullable(),
  threshold_p95_ms: z.number(), measured_error_rate: z.number().nullable(),
  threshold_error_rate_max: z.number(), verdict: z.enum(['PASS', 'FAIL', 'SKIPPED']),
});
const nonFunctional = z.object({ status: gateStatus, performance: z.array(perfScenario) });

export const qualityGateResultSchema = z.object({
  schema_version: z.literal('1.0'),
  change_id: z.string(),
  batch_id: z.string(),
  dimensions: z.object({ functional, coverage: coverageDim, non_functional: nonFunctional.optional() }),
  final_status: gateStatus,
  warnings: z.array(z.string()).optional(),
});

export type _QgOk = AssertAssignable<z.infer<typeof qualityGateResultSchema>, QualityGateResult>;

export function validateQualityGateResult(raw: unknown): { ok: boolean; errors: string[] } {
  const parsed = qualityGateResultSchema.safeParse(raw);
  if (parsed.success) return { ok: true, errors: [] };
  return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}
