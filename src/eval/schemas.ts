// src/eval/schemas.ts — Zod schemas for AI Eval Harness

import { z } from 'zod';

// ── Executor Schemas ──────────────────────────────────────────────────────────

export const InProcessExecutorSchema = z.object({
  type: z.literal('in_process'),
  target_module: z.string().min(1),
  target_export: z.string().min(1),
  expected_outputs: z.array(z.string()).optional(),
});

export const SubprocessExecutorSchema = z.object({
  type: z.literal('subprocess'),
  command: z.string().min(1),
  timeout_seconds: z.number().positive(),
  expected_outputs: z.array(z.string()),
  workdir: z.string().optional(),
  sandbox: z
    .object({
      copy_from: z.string().optional(),
      clean_before_run: z.boolean().optional(),
    })
    .optional(),
  allowed_writes: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export const MixedExecutorSchema = z.object({
  type: z.literal('mixed'),
  per_check_type: z.record(
    z.string(),
    z.union([InProcessExecutorSchema, SubprocessExecutorSchema])
  ),
});

export const ExecutorSchema = z.discriminatedUnion('type', [
  InProcessExecutorSchema,
  SubprocessExecutorSchema,
  MixedExecutorSchema,
]);

// ── CI Config Schemas ─────────────────────────────────────────────────────────

export const CiPrConfigSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(['smoke', 'full']),
  required: z.boolean(),
  max_samples: z.number().positive().optional(),
  tags: z.array(z.string()).optional(),
  tag_match: z.enum(['any', 'all']).optional(),
  trigger_paths: z.array(z.string()).optional(),
  always_run: z.boolean().optional(),
});

export const CiNightlyConfigSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(['smoke', 'full']),
  tags: z.array(z.string()).optional(),
});

export const CiConfigSchema = z.object({
  pr: CiPrConfigSchema.optional(),
  nightly: CiNightlyConfigSchema.optional(),
});

// ── Suite Schema ──────────────────────────────────────────────────────────────

export const JudgeConfigSchema = z.object({
  model: z.string().min(1),
  prompt_ref: z.string().min(1),
  temperature: z.number().min(0).max(2),
  seed: z.number().optional(),
  confidence_threshold: z.number().min(0).max(1),
});

export const JudgeCalibrationThresholdsSchema = z.object({
  judge_human_agreement: z.string(),
  judge_human_kappa: z.string(),
  critical_label_disagreement: z.string(),
  invalid_judge_output_rate: z.string(),
});

export const EvalSuiteSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  executor: ExecutorSchema,
  ci: CiConfigSchema,
  dataset: z.string().min(1),
  repeat: z.number().positive().optional(),
  thresholds: z.record(z.string(), z.string()),
  hard_gates: z.array(z.string()),
  judge: JudgeConfigSchema.optional(),
  judge_calibration: JudgeCalibrationThresholdsSchema.optional(),
});

// ── Dataset Sample Schema ─────────────────────────────────────────────────────

export const DatasetSampleSchema = z
  .object({
    id: z.string().min(1),
    annotation_source: z.enum(['human', 'archive_extracted', 'synthetic']),
    tags: z.array(z.string()).optional(),
    check_type: z.string().optional(),
    input: z.record(z.string(), z.unknown()),
    expected: z.record(z.string(), z.unknown()),
  })
  .passthrough(); // preserve extra fields (prediction, mock_judge_label, etc.)

// ── Manifest Schemas ──────────────────────────────────────────────────────────

export const RunManifestSchema = z.object({
  run_id: z.string().min(1),
  git_sha: z.string().min(1),
  suite: z.string().min(1),
  suite_version: z.string().min(1),
  suite_hash: z.string().min(1),
  dataset_version: z.string().min(1),
  dataset_hash: z.string().min(1),
  dataset_root_hash: z.string().min(1),
  selected_sample_ids: z.array(z.string()),
  skill_content_hashes: z.record(z.string(), z.string()),
  fixture_hashes: z.record(z.string(), z.string()),
  prompt_hashes: z.record(z.string(), z.string()),
  target_model: z.string(),
  target_model_params: z.record(z.string(), z.unknown()),
  judge_model: z.string().optional(),
  judge_prompt_hash: z.string().optional(),
  judge_temperature: z.number().optional(),
  scorer_version: z.string(),
  executor_version: z.string(),
  runner_version: z.string(),
  output_schema_version: z.string(),
  environment: z.object({
    node: z.string(),
    python: z.string().nullable(),
    pytest: z.string().nullable(),
    playwright: z.string().nullable(),
  }),
  started_at: z.string().datetime(),
  completed_at: z.string().datetime().optional(),
  total_samples: z.number().nonnegative(),
  executed_samples: z.number().nonnegative(),
  executed_attempts: z.number().nonnegative().optional(),
});

export const BatchManifestSchema = z.object({
  batch_id: z.string().min(1),
  git_sha: z.string().min(1),
  plan_hash: z.string().min(1),
  suite_runs: z.record(z.string(), z.string()),
  started_at: z.string().datetime(),
  completed_at: z.string().datetime().optional(),
});

// ── Verdict + Gate Result Schemas ─────────────────────────────────────────────

export const EvalVerdictSchema = z.enum([
  'pass',
  'pass_with_warnings',
  'fail',
  'inconclusive',
  'needs_human_review',
]);

export const EvalGateResultSchema = z.object({
  run_id: z.string(),
  suite: z.string(),
  verdict: EvalVerdictSchema,
  hard_gate_failures: z.array(z.string()),
  threshold_failures: z.array(z.string()),
  inconclusive_count: z.number().nonnegative().optional(),
  metrics_delta: z.record(z.string(), z.number()).optional(),
});

export const SuiteRunEntrySchema = z.object({
  run_id: z.string(),
  verdict: EvalVerdictSchema,
  required: z.boolean(),
});

export const BatchGateResultSchema = z.object({
  batch_id: z.string(),
  verdict: EvalVerdictSchema,
  suite_results: z.record(z.string(), SuiteRunEntrySchema),
  hard_gate_failures: z.array(z.string()),
});

// ── Judge Output Schema ───────────────────────────────────────────────────────

export const JudgeOutputSchema = z.object({
  label: z.enum(['covered', 'partial', 'missing', 'hallucinated']),
  reason: z.string(),
  evidence_refs: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  needs_human_review: z.boolean().optional(),
});

// ── Eval Plan Schema ──────────────────────────────────────────────────────────

export const EvalPlanSuiteEntrySchema = z.object({
  name: z.string().min(1),
  tags: z.array(z.string()).optional(),
  tag_match: z.enum(['any', 'all']).optional(),
  max_samples: z.number().positive().optional(),
  required: z.boolean(),
  repeat: z.number().positive().optional(),
});

export const EvalPlanSchema = z.object({
  event: z.enum(['pull_request', 'nightly', 'manual']),
  generated_at: z.string().datetime(),
  changed_files: z.array(z.string()),
  suites: z.array(EvalPlanSuiteEntrySchema),
});

// ── SuiteMetrics Schema ───────────────────────────────────────────────────────

export const SuiteMetricsSchema = z.object({
  suite: z.string(),
  run_id: z.string(),
  sample_count: z.number().nonnegative(),
  inconclusive_count: z.number().nonnegative(),
  error_count: z.number().nonnegative(),
  metrics: z.record(z.string(), z.number()),
});
