import { z } from 'zod';

export const advisorySchema = z.object({
  schema_version: z.string().min(1),
  change_id: z.any(),
  context_ref: z.any(),
  generated_at: z.any(),
  executive_summary: z.any(),
  watchlist: z.array(z.any()),
  evidence_inventory: z.any(),
  case_design_guidance: z.any(),
  minimum_required_coverage: z.any(),
  open_questions_for_case_design: z.array(z.any()),
}).passthrough();

export type Advisory = z.infer<typeof advisorySchema>;

export function validateAdvisory(raw: unknown): { ok: boolean; errors: string[] } {
  const parsed = advisorySchema.safeParse(raw);
  if (parsed.success) return { ok: true, errors: [] };
  return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}
