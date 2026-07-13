import { z } from 'zod';

const factBaselineUnavailableSchema = z.object({
  source: z.literal('unavailable'),
  facts: z.any(),
  warnings: z.array(z.any()),
}).passthrough();

const factBaselineFullSchema = z.object({
  schema_version: z.string().min(1),
  change_id: z.any(),
  generated_at: z.any(),
  source: z.enum(['seed_file', 'db_probe', 'both']),
  seed_file: z.any(),
  facts: z.any(),
  warnings: z.array(z.any()),
}).passthrough();

export const factBaselineSchema = z.discriminatedUnion('source', [
  factBaselineUnavailableSchema,
  factBaselineFullSchema.extend({ source: z.literal('seed_file') }),
  factBaselineFullSchema.extend({ source: z.literal('db_probe') }),
  factBaselineFullSchema.extend({ source: z.literal('both') }),
]);

export type FactBaseline = z.infer<typeof factBaselineSchema>;

export function validateFactBaseline(raw: unknown): { ok: boolean; errors: string[] } {
  const parsed = factBaselineSchema.safeParse(raw);
  if (parsed.success) return { ok: true, errors: [] };
  return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}
