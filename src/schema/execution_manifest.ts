import { z } from 'zod';
import type { ExecutionManifest } from '../core/types';
import type { AssertAssignable } from './types';

const gateStatus = z.enum(['PASS', 'PASS_WITH_WARNINGS', 'FAIL', 'SKIPPED']);

export const executionManifestSchema = z.object({
  schema_version: z.literal('1.0'),
  change_id: z.string().min(1),
  batch_id: z.string().min(1),
  selected_targets: z.object({
    api: z.boolean(), e2e: z.boolean(), fuzz: z.boolean(), performance: z.boolean(),
  }),
  result_files: z.record(z.string(), z.string()),
  tests_tree_sha256: z.string().optional(),
  test_files_sha256: z.record(z.string(), z.string()).optional(),
  product_tree_sha256: z.string().optional(),
  final_status: gateStatus.optional(),
});

export type ExecutionManifestInferred = z.infer<typeof executionManifestSchema>;
export type _ManifestOk = AssertAssignable<ExecutionManifestInferred, ExecutionManifest>;

export function validateExecutionManifest(raw: unknown): { ok: boolean; errors: string[] } {
  const parsed = executionManifestSchema.safeParse(raw);
  if (parsed.success) return { ok: true, errors: [] };
  return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}
