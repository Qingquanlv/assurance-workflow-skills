import { z } from 'zod';

export const applySummarySchema = z.object({
  schema_version: z.string().min(1),
  target: z.enum(['api', 'e2e']),
  applied: z.boolean(),
}).passthrough();

export type ApplySummary = z.infer<typeof applySummarySchema>;

export function validateApplySummary(raw: unknown): { ok: boolean; errors: string[] } {
  const parsed = applySummarySchema.safeParse(raw);
  if (parsed.success) return { ok: true, errors: [] };
  return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}
