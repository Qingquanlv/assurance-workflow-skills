import { z } from 'zod';

export const reviewSchema = z.object({
  schema_version: z.string().min(1),
  verdict: z.string().min(1),
  findings: z.array(z.any()),
}).passthrough();

export type Review = z.infer<typeof reviewSchema>;

export function validateReview(raw: unknown): { ok: boolean; errors: string[] } {
  const parsed = reviewSchema.safeParse(raw);
  if (parsed.success) return { ok: true, errors: [] };
  return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}
