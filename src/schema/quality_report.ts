import { z } from 'zod';
import type { QualityReport } from '../core/types';
import type { AssertAssignable } from './types';

const gateStatus = z.enum(['PASS', 'PASS_WITH_WARNINGS', 'FAIL', 'SKIPPED']);
const counts = z.object({ total: z.number(), passed: z.number(), failed: z.number() });
const threshold = z.object({ line: z.number(), branch: z.number(), module_line: z.number().optional(), diff_line: z.number().optional() });
const functional = z.object({ status: gateStatus, api: counts, e2e: counts, fuzz: counts.optional(), unmapped_tests: z.number().optional() });
const coverageDim = z.object({ status: gateStatus, available: z.boolean(), line_coverage: z.number(), branch_coverage: z.number(), threshold, scope: z.any().optional() });
const scoreVal = z.union([z.number(), z.literal('N/A')]);
const defect = z.object({ case_id: z.string(), category: z.string(), diagnosis: z.string() });

export const qualityReportSchema = z.object({
  schema_version: z.literal('1.0'),
  change_id: z.string(),
  batch_id: z.string(),
  final_status: gateStatus,
  quality_score: z.number(),
  score_breakdown: z.object({ functional: scoreVal, coverage: scoreVal, fuzz: scoreVal, performance: scoreVal }),
  scope: z.object({ cases: z.number(), requirements: z.array(z.string()) }),
  functional,
  coverage: coverageDim,
  human_decisions: z.array(z.any()).optional(),
  minimum_required_coverage: z.any().optional(),
  non_functional: z.any().optional(),
  defects: z.object({ product: z.array(defect), test: z.array(defect), environment: z.array(defect) }),
  risk_level: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  risk_rationale: z.string(),
  recommendation: z.string(),
});

export type _QrOk = AssertAssignable<z.infer<typeof qualityReportSchema>, QualityReport>;

export function validateQualityReport(raw: unknown): { ok: boolean; errors: string[] } {
  const parsed = qualityReportSchema.safeParse(raw);
  if (parsed.success) return { ok: true, errors: [] };
  return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}
