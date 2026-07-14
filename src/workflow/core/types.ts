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

import type { CoverageThreshold } from '../../schema/contracts';

export type {
  AnalysisStatus,
  CoverageDimension,
  CoverageGapEntry,
  CoverageResult,
  CoverageScopeFile,
  CoverageScopeResult,
  CoverageThreshold,
  ExecutionManifest,
  FailureAnalysis,
  FailureCategory,
  FailureEntry,
  FailureEvidence,
  FailureSeverity,
  FunctionalCounts,
  FunctionalDimension,
  GateStatus,
  HumanDecisionReportItem,
  InspectFinalStatus,
  MinimumCoverageItemResult,
  MinimumCoverageResult,
  MinimumCoverageStatus,
  NonFunctionalDimension,
  PerformanceResult,
  PerformanceScenarioVerdict,
  QualityGateDimensions,
  QualityGateResult,
  QualityReport,
  QualityScoreBreakdown,
  ReportDefect,
  RiskLevel,
  SelectedTargets,
  UncoveredFile,
} from '../../schema/contracts';

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
  mode?: 'pytest-cov' | 'server-process';
  server_command?: string;
  server_port?: number;
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
