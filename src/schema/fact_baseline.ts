import { z } from 'zod';

export const factBaselineSchema = z.object({
  schema_version: z.string().min(1),
  change_id: z.any(),
  generated_at: z.any(),
  source: z.any(),
  seed_file: z.any(),
  facts: z.any(),
  warnings: z.array(z.any()),
}).passthrough();

export type FactBaseline = z.infer<typeof factBaselineSchema>;

export function validateFactBaseline(raw: unknown): { ok: boolean; errors: string[] } {
  const parsed = factBaselineSchema.safeParse(raw);
  if (parsed.success) return { ok: true, errors: [] };
  return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}
