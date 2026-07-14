import { z } from 'zod';

export const qaYamlSchema = z.object({
  schema_version: z.string().min(1),
  schema: z.string().min(1),
  created_at: z.string().min(1),
  change: z.object({
    change_id: z.string().min(1),
    requirement_id: z.string().min(1),
    feature_name: z.string().min(1),
    status: z.string().min(1),
  }),
  targets: z.object({
    cases: z.array(
      z.object({
        module: z.string().min(1),
        change_case_file: z.string().min(1),
        target_case_file: z.string().min(1),
      }),
    ),
  }),
  workflow: z
    .object({ current_step: z.string().optional(), next_step: z.string().optional() })
    .optional(),
});

export type QaYaml = z.infer<typeof qaYamlSchema>;

export function validateQaYaml(raw: unknown): { ok: boolean; errors: string[] } {
  const parsed = qaYamlSchema.safeParse(raw);
  if (parsed.success) return { ok: true, errors: [] };
  return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}
