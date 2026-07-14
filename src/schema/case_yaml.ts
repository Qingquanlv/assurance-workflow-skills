import { z } from 'zod';

const caseId = z
  .string()
  .regex(/^[A-Za-z0-9_]+$/, 'case_id must be underscore-only (hyphens not allowed)');

const caseEntry = z.object({
  case_id: caseId,
  title: z.string().min(1),
  status: z.enum(['draft', 'active', 'deprecated']),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']),
  severity: z.enum(['blocker', 'critical', 'major', 'minor']),
  type: z.enum(['API', 'E2E', 'Fuzz', 'Performance']),
  module: z.string().min(1),
});

export const caseYamlSchema = z.object({
  schema_version: z.string().min(1),
  added: z.array(caseEntry),
  modified: z.array(caseEntry),
  removed: z.array(z.object({ case_id: caseId })),
});

export type CaseYaml = z.infer<typeof caseYamlSchema>;

export function validateCaseYaml(raw: unknown): { ok: boolean; errors: string[] } {
  const parsed = caseYamlSchema.safeParse(raw);
  if (parsed.success) return { ok: true, errors: [] };
  const errors = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
  return { ok: false, errors };
}
