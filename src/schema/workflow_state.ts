import { z } from 'zod';

export const workflowStateSchema = z.object({
  schema_version: z.string().optional(),
  params: z.record(z.string(), z.any()).optional(),
  phases: z.record(z.string(), z.any()).optional(),
}).passthrough();

export type WorkflowState = z.infer<typeof workflowStateSchema>;

export function validateWorkflowState(raw: unknown): { ok: boolean; errors: string[] } {
  const parsed = workflowStateSchema.safeParse(raw);
  if (parsed.success) return { ok: true, errors: [] };
  return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}
