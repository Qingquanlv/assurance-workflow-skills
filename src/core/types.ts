// ─── Execution types (M5) ────────────────────────────────────────────────────

export type ExecutionStatus = 'passed' | 'failed' | 'skipped';

export interface ApiCaseResult {
  case_id: string;
  status: ExecutionStatus;
  file: string;
  test_name: string;
  duration_ms: number;
  message: string;
  raw_log_ref: string;
}

export interface ApiResultSource {
  framework: 'pytest';
  raw_log: string;
  junit_xml: string;
  json_report: string;
}

export interface ApiResult {
  schema_version: '1.0';
  change_id: string;
  batch_id: string;
  target: 'api';
  status: ExecutionStatus;
  command: string;
  source: ApiResultSource;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  cases: ApiCaseResult[];
  unmapped_tests: ApiCaseResult[];
}

export interface E2eCaseResult {
  case_id: string;
  status: ExecutionStatus;
  file: string;
  test_name: string;
  duration_ms: number;
  message: string;
  trace: string;
  screenshot: string;
  video: string;
}

export interface E2eResultSource {
  framework: 'playwright';
  raw_log: string;
  json_report: string;
  html_report: string;
}

export interface E2eResult {
  schema_version: '1.0';
  change_id: string;
  batch_id: string;
  target: 'e2e';
  status: ExecutionStatus;
  command: string;
  source: E2eResultSource;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  cases: E2eCaseResult[];
  unmapped_tests: E2eCaseResult[];
}

// ─── Failure analysis types (M5) ─────────────────────────────────────────────

export type FailureCategory =
  | 'environment_failure'
  | 'test_data_failure'
  | 'locator_failure'
  | 'wait_strategy_failure'
  | 'assertion_failure'
  | 'business_logic_failure'
  | 'case_semantic_failure'
  | 'test_code_error'
  | 'unknown';

export type FailureSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface FailureEvidence {
  result_file: string;
  test_file: string;
  trace: string;
  screenshot: string;
  video: string;
  raw_log: string;
  log_excerpt: string;
}

export interface FailureEntry {
  case_id: string;
  target: 'api' | 'e2e';
  category: FailureCategory;
  fix_proposal_allowed: boolean;
  severity: FailureSeverity;
  evidence: FailureEvidence;
  diagnosis: string;
  recommended_action: string;
}

export type AnalysisStatus = 'analyzed' | 'no_failures' | 'skipped';

export interface FailureAnalysis {
  schema_version: '1.0';
  change_id: string;
  status: AnalysisStatus;
  failures: FailureEntry[];
  hard_fails: FailureEntry[];
  needs_review: FailureEntry[];
}

// ─── Existing types ───────────────────────────────────────────────────────────

export interface AwsConfig {
  version: number;
  project: {
    name: string;
    root: string;
    layout: string;
  };
  sources: {
    frontend: string;
    backend: string;
  };
  qa: {
    cases: string;
    changes: string;
  };
  tests: {
    root: string;
    api: string;
    e2e: string;
    fixtures: string;
    helpers: string;
    reports: string;
  };
  frameworks: {
    api: { enabled: boolean; name: string };
    e2e: { enabled: boolean; name: string };
  };
  workflow: {
    primary_runner: string;
    agents: { claude_code: boolean; codex: boolean };
  };
  mcp: { enabled: boolean; config_file?: string };
  generation: {
    prd_input_mode: string;
    e2e: { default_pom: boolean; locator_priority: string[] };
    api: { prefer_existing_fixtures: boolean };
  };
  execution: {
    entry: string;
    policy_file: string;
    ci_must_use_cli: boolean;
    self_healing: {
      mode: string;
      allow_assertion_change: boolean;
      allow_product_code_change: boolean;
      allow_auto_merge: boolean;
    };
  };
  review: {
    require_case_review: boolean;
    require_subplan_review: boolean;
    require_fix_proposal_review: boolean;
  };
  archive: { enable_trace_check: boolean; regression_default: boolean };
}

export type CheckStatus = 'ok' | 'warning' | 'error';

export interface CheckResult {
  id: string;
  group: string;
  status: CheckStatus;
  message: string;
  suggested_fix?: string;
}

export interface DoctorResult {
  status: CheckStatus;
  summary: { ok: number; warning: number; error: number };
  checks: CheckResult[];
}

export interface InitAnswers {
  apiFramework: 'pytest' | 'none';
  e2eFramework: 'playwright' | 'none';
  enableMcp: boolean;
  confirm: boolean;
  frontendPath?: string;
  backendPath?: string;
}
