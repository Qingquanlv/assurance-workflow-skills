import { z } from 'zod';

const proposal = z.object({
  target: z.enum(['api', 'e2e', 'fuzz', 'performance']),
  eligible: z.boolean(),
}).passthrough();

export const fixProposalSchema = z.object({
  schema_version: z.string().min(1),
  proposals: z.array(proposal),
}).passthrough();

export type FixProposal = z.infer<typeof fixProposalSchema>;

export function validateFixProposal(raw: unknown): { ok: boolean; errors: string[] } {
  const parsed = fixProposalSchema.safeParse(raw);
  if (parsed.success) return { ok: true, errors: [] };
  return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}
