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

/** Fuzz result reuses the pytest/ApiResult shape (schemathesis runs via pytest), but is tagged `fuzz`. */
export interface FuzzResult extends Omit<ApiResult, 'target'> {
  target: 'fuzz';
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
  framework: 'pytest-playwright' | 'playwright';
  raw_log: string;
  junit_xml?: string;
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

export interface SelectedTargets {
  api: boolean;
  e2e: boolean;
  fuzz: boolean;
  performance: boolean;
}

export interface ExecutionManifest {
  schema_version: '1.0';
  change_id: string;
  batch_id: string;
  selected_targets: SelectedTargets;
  result_files: Partial<Record<keyof SelectedTargets | 'coverage' | 'summary', string>>;
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
  | 'known_product_issue'
  | 'coverage_gap'
  // Fuzz-specific (M3 Phase B):
  | 'fuzz_configuration_error'  // schema fetch / auth / setup misconfig — not a product bug, not auto-fixable
  | 'fuzz_stateful_failure'     // stateful sequence revealed a server fault — product issue, needs review
  // Performance-specific (M3 Phase C):
  | 'perf_script_error'         // locustfile error / could not run — fix the script, not auto-fixable
  | 'perf_threshold_exceeded'   // measured p95/error_rate exceeded the absolute threshold — needs review
  | 'perf_environment'          // target environment unreachable / no traffic — environment, not a product bug
  // Manifest integrity (M1/M3):
  | 'manifest_asset_missing'   // selected_targets declares a target but its result file is absent — execution asset corrupted
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
  id?: string;
  case_id: string;
  test?: string;
  target: 'api' | 'e2e' | 'fuzz' | 'performance' | 'coverage';
  category: FailureCategory;
  /** Whether the CLI considers this failure eligible for an automated fix proposal */
  fix_proposal_eligible: boolean;
  severity: FailureSeverity;
  evidence: FailureEvidence;
  diagnosis: string;
  recommended_action: string;
  recommended_next_action?: string;
}

export interface CoverageGapEntry {
  file: string;
  line_coverage: number;
  threshold: number;
}

export type AnalysisStatus = 'analyzed' | 'no_failures' | 'skipped' | 'failed';

/** High-level workflow status emitted in failure-analysis.json, consumed by healing gates */
export type InspectFinalStatus = 'PASS' | 'PASS_WITH_WARNINGS' | 'FAIL' | 'SKIPPED';

export interface FailureAnalysis {
  schema_version: '1.0';
  change_id: string;
  source_manifest: string;
  inspection_status: 'completed' | 'skipped' | 'failed';
  /** Batch ID of the execution run this analysis is based on */
  batch_id: string;
  /** Same as batch_id for primary inspect; kept for healing re-inspect compatibility */
  source_batch_id: string;
  /** High-level outcome consumed by healing gates in workflow-state.yaml */
  final_status: InspectFinalStatus;
  /**
   * "primary" — manifest present, batch-scoped, fully trusted.
   * "compat_fallback" — no execution-manifest.yaml; inspected latest pointer files as compatibility fallback.
   *   Results are informational only; healing gate should not treat them as primary evidence.
   */
  inspect_mode: 'primary' | 'compat_fallback';
  /** Non-empty only in compat_fallback mode — explains why fallback was used. */
  warnings?: string[];
  classification_performed: boolean;
  status: AnalysisStatus;
  failures: FailureEntry[];
  hard_fails: FailureEntry[];
  needs_review: FailureEntry[];
  known_product_issues: FailureEntry[];
  /** Low-coverage files surfaced from coverage-result.json (M1). Never a Fix Proposal source. */
  coverage_gaps?: CoverageGapEntry[];
}

// ─── Coverage / Quality Gate / Report types (M1) ─────────────────────────────

/** Four-state status shared by coverage, quality-gate dimensions, and reports. */
export type GateStatus = 'PASS' | 'PASS_WITH_WARNINGS' | 'FAIL' | 'SKIPPED';

export interface CoverageThreshold {
  line: number;
  branch: number;
}

export interface UncoveredFile {
  file: string;
  line_coverage: number;
}

/** Canonical coverage result, normalised from coverage.py JSON (M1). */
export interface CoverageResult {
  schema_version: '1.0';
  change_id: string;
  batch_id: string;
  kind: 'coverage';
  /** false when pytest-cov is unavailable — coverage is a warning, never a hard fail. */
  available: boolean;
  line_coverage: number;
  branch_coverage: number;
  threshold: CoverageThreshold;
  status: 'PASS' | 'PASS_WITH_WARNINGS' | 'SKIPPED';
  /**
   * Present when status == SKIPPED. Explains why coverage was not collected.
   * "api_unselected" — the API target was not in selectedTargets for this run.
   * "pytest_cov_unavailable" — pytest-cov plugin was not installed.
   * "disabled" — coverage.enabled=false in .aws/config.yaml.
   */
  skip_reason?: 'api_unselected' | 'pytest_cov_unavailable' | 'disabled';
  uncovered_critical_files: UncoveredFile[];
  source: {
    coverage_json: string;
    coverage_xml: string;
  };
}

export interface FunctionalCounts {
  total: number;
  passed: number;
  failed: number;
}

export interface FunctionalDimension {
  status: GateStatus;
  api: FunctionalCounts;
  e2e: FunctionalCounts;
  /** Added by M3 Phase D when fuzz targets exist. */
  fuzz?: FunctionalCounts;
}

export interface CoverageDimension {
  status: GateStatus;
  available: boolean;
  line_coverage: number;
  branch_coverage: number;
  threshold: CoverageThreshold;
}

/** Per-scenario performance verdict (M3 Phase C/D). */
export interface PerformanceScenarioVerdict {
  capability: string;
  endpoint: string;
  measured_p95_ms: number | null;
  threshold_p95_ms: number;
  measured_error_rate: number | null;
  threshold_error_rate_max: number;
  verdict: 'PASS' | 'FAIL' | 'SKIPPED';
}

/** Non-functional dimension (M3 Phase D). Optional in M1. */
export interface NonFunctionalDimension {
  status: GateStatus;
  performance: PerformanceScenarioVerdict[];
}

/** Canonical performance result produced by the Locust runner (M3 Phase C). */
export interface PerformanceResult {
  schema_version: '1.0';
  change_id: string;
  batch_id: string;
  kind: 'performance';
  /** false when locust is unavailable or the target environment produced no measurements → SKIPPED. */
  available: boolean;
  status: 'PASS' | 'FAIL' | 'SKIPPED';
  scenarios: PerformanceScenarioVerdict[];
  command: string;
  source: {
    raw_log: string;
    csv_prefix: string;
  };
}

export interface QualityGateDimensions {
  functional: FunctionalDimension;
  coverage: CoverageDimension;
  /** Added by M3 Phase D. */
  non_functional?: NonFunctionalDimension;
}

/** Unified gate conclusion produced by `aws report inspect` (M1). */
export interface QualityGateResult {
  schema_version: '1.0';
  change_id: string;
  batch_id: string;
  dimensions: QualityGateDimensions;
  final_status: GateStatus;
}

export interface QualityScoreBreakdown {
  functional: number | 'N/A';
  coverage: number | 'N/A';
  /** 'N/A' until M3 introduces fuzz. */
  fuzz: number | 'N/A';
  /** 'N/A' until M3 introduces performance. */
  performance: number | 'N/A';
}

export interface ReportDefect {
  case_id: string;
  category: string;
  diagnosis: string;
}

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/** Structured quality report produced by `aws report generate` (M1). */
export interface QualityReport {
  schema_version: '1.0';
  change_id: string;
  batch_id: string;
  final_status: GateStatus;
  /** Deterministic 0-100 score computed by the CLI. */
  quality_score: number;
  score_breakdown: QualityScoreBreakdown;
  scope: {
    cases: number;
    requirements: string[];
  };
  functional: FunctionalDimension;
  coverage: CoverageDimension;
  non_functional?: NonFunctionalDimension;
  defects: {
    product: ReportDefect[];
    test: ReportDefect[];
    environment: ReportDefect[];
  };
  /** Initial CLI-computed risk level; skill layer may refine the rationale wording only. */
  risk_level: RiskLevel;
  risk_rationale: string;
  recommendation: string;
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
  coverage?: CoverageConfig;
}

export interface CoverageConfig {
  enabled: boolean;
  target_package: string;
  threshold: CoverageThreshold;
  /** warn: below threshold → PASS_WITH_WARNINGS (default). block: below threshold → FAIL. */
  gate_mode: 'warn' | 'block';
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
