// src/eval/types.ts — AI Eval Harness core types

// ── Executor ──────────────────────────────────────────────────────────────────

export type ExecutorType = 'in_process' | 'subprocess' | 'workflow-run' | 'aws-run' | 'mixed';

export interface InProcessExecutorConfig {
  type: 'in_process';
  target_module: string;
  target_export: string;
}

export interface SubprocessExecutorConfig {
  type: 'subprocess';
  command: string;
  timeout_seconds: number;
  expected_outputs: string[];
  workdir?: string;
  sandbox?: {
    copy_from?: string;
    clean_before_run?: boolean;
  };
  allowed_writes?: string[];
  env?: Record<string, string>;
}

interface CompiledWrapperExecutorConfig {
  timeout_seconds: number;
  expected_outputs: string[];
  env?: Record<string, string>;
}

export interface WorkflowRunExecutorConfig extends CompiledWrapperExecutorConfig {
  type: 'workflow-run';
  run_mode: string;
  test_types?: string;
  run_tests?: boolean;
  entry?: 'driver' | 'orchestrator' | 'phase-skill';
  skip_seed?: boolean;
}

export interface AwsRunExecutorConfig extends CompiledWrapperExecutorConfig {
  type: 'aws-run';
  fixture_tier?: string;
  skip_seed?: boolean;
}

export type LeafExecutorConfig =
  | InProcessExecutorConfig
  | SubprocessExecutorConfig
  | WorkflowRunExecutorConfig
  | AwsRunExecutorConfig;

export interface MixedExecutorConfig {
  type: 'mixed';
  per_check_type: Record<string, LeafExecutorConfig>;
}

export type ExecutorConfig =
  | InProcessExecutorConfig
  | SubprocessExecutorConfig
  | WorkflowRunExecutorConfig
  | AwsRunExecutorConfig
  | MixedExecutorConfig;

// ── CI Config ─────────────────────────────────────────────────────────────────

export interface CiPrConfig {
  enabled: boolean;
  mode: 'smoke' | 'full';
  required: boolean;
  max_samples?: number;
  tags?: string[];
  tag_match?: 'any' | 'all';
  trigger_paths?: string[];
  always_run?: boolean;
}

export interface CiNightlyConfig {
  enabled: boolean;
  mode: 'smoke' | 'full';
  tags?: string[];
}

export interface CiConfig {
  pr?: CiPrConfig;
  nightly?: CiNightlyConfig;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

export interface EvalSuite {
  name: string;
  version: string;
  executor: ExecutorConfig;
  ci: CiConfig;
  dataset: string;
  repeat?: number;
  thresholds: Record<string, string>;
  hard_gates: string[];
  judge?: JudgeConfig;
  judge_calibration?: JudgeCalibrationThresholds;
}

// ── Dataset Sample ─────────────────────────────────────────────────────────────

export interface DatasetSample {
  id: string;
  annotation_source: 'human' | 'archive_extracted' | 'synthetic';
  tags?: string[];
  check_type?: string;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
  [key: string]: unknown;
}

// ── Manifest ──────────────────────────────────────────────────────────────────

export interface RunManifest {
  run_id: string;
  git_sha: string;
  suite: string;
  suite_version: string;
  suite_hash: string;
  dataset_version: string;
  dataset_hash: string;
  dataset_root_hash: string;
  selected_sample_ids: string[];
  skill_content_hashes: Record<string, string>;
  fixture_hashes: Record<string, string>;
  prompt_hashes: Record<string, string>;
  target_model: string;
  target_model_params: Record<string, unknown>;
  judge_model?: string;
  judge_prompt_hash?: string;
  judge_temperature?: number;
  scorer_version: string;
  executor_version: string;
  runner_version: string;
  output_schema_version: string;
  environment: {
    node: string;
    python: string | null;
    pytest: string | null;
    playwright: string | null;
  };
  started_at: string;
  completed_at?: string;
  total_samples: number;
  executed_samples: number;
  executed_attempts?: number;
}

export interface BatchManifest {
  batch_id: string;
  git_sha: string;
  plan_hash: string;
  suite_runs: Record<string, string>;
  started_at: string;
  completed_at?: string;
}

// ── Verdict ───────────────────────────────────────────────────────────────────

export type EvalVerdict =
  | 'pass'
  | 'pass_with_warnings'
  | 'fail'
  | 'inconclusive'
  | 'needs_human_review';

export interface EvalGateResult {
  run_id: string;
  suite: string;
  verdict: EvalVerdict;
  hard_gate_failures: string[];
  threshold_failures: string[];
  inconclusive_count?: number;
  metrics_delta?: Record<string, number>;
}

export interface SuiteRunEntry {
  run_id: string;
  verdict: EvalVerdict;
  required: boolean;
}

export interface BatchGateResult {
  batch_id: string;
  verdict: EvalVerdict;
  suite_results: Record<string, SuiteRunEntry>;
  hard_gate_failures: string[];
}

// ── Metrics ───────────────────────────────────────────────────────────────────

export interface SampleScore {
  sample_id: string;
  status: 'ok' | 'error' | 'inconclusive';
  metrics: Record<string, number | boolean | string>;
  error?: string;
}

export interface SuiteMetrics {
  suite: string;
  run_id: string;
  sample_count: number;
  inconclusive_count: number;
  error_count: number;
  metrics: Record<string, number>;
}

// ── Judge ─────────────────────────────────────────────────────────────────────

export interface JudgeCalibrationThresholds {
  judge_human_agreement: string;
  judge_human_kappa: string;
  critical_label_disagreement: string;
  invalid_judge_output_rate: string;
}

export interface JudgeConfig {
  model: string;
  prompt_ref: string;
  temperature: number;
  seed?: number;
  confidence_threshold: number;
}

export interface JudgeOutput {
  label: 'covered' | 'partial' | 'missing' | 'hallucinated';
  reason: string;
  evidence_refs: string[];
  confidence: number;
  needs_human_review?: boolean;
}

// ── Tool Events ────────────────────────────────────────────────────────────────

export type ToolEventType =
  | 'tool_call'
  | 'file_write'
  | 'safety_violation'
  | 'skill_load'
  | 'subprocess_spawn';

export interface ToolEvent {
  event: ToolEventType;
  tool?: string;
  command?: string;
  path?: string;
  allowed?: boolean;
  violation_type?: string;
  sample_id: string;
  ts: string;
}

export interface SecurityEvent {
  type:
    | 'forbidden_write_attempt'
    | 'path_escape_attempt'
    | 'secret_leak'
    | 'dangerous_command_attempt'
    | 'gate_bypass_attempt';
  detail: string;
  sample_id: string;
  source: 'tool_event' | 'diff_scan' | 'secret_scan';
  executed: boolean;
  blocked: boolean;
  ts: string;
}

// ── Eval Plan ─────────────────────────────────────────────────────────────────

export interface EvalPlanSuiteEntry {
  name: string;
  tags?: string[];
  tag_match?: 'any' | 'all';
  max_samples?: number;
  required: boolean;
  repeat?: number;
}

export interface EvalPlan {
  event: 'pull_request' | 'nightly' | 'manual';
  generated_at: string;
  changed_files: string[];
  suites: EvalPlanSuiteEntry[];
}

// ── Execution Result ──────────────────────────────────────────────────────────

export interface ExecutionResult {
  sample_id: string;
  attempt: number;
  executor_type: ExecutorType;
  check_type?: string;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  exit_code?: number;
  status: 'ok' | 'error' | 'timeout';
  error?: string;
}
