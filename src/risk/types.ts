export type ConfidenceLevel = 'high' | 'medium' | 'low';
export type Layer = 'api' | 'e2e';
export type ExecutionCaseStatus = 'passed' | 'failed' | 'skipped';

export interface ModuleImpact {
  name: string;
  confidence: ConfidenceLevel;
  matched_rules: string[];
  reason?: string;
}

export interface CaseSignal {
  case_id: string;
  module: string;
  priority?: string;
  automation_status?: string;
  flaky?: boolean;
}

export interface TestHealthEntry {
  module: string;
  layer: Layer;
  runs_sampled: number;
  pass_rate: number;
  recent_fail_case_ids: string[];
  evidence_id: string;
}

export interface HistoricalIssue {
  id: string;
  module: string;
  endpoint?: string;
  severity?: string;
  status?: string;
  evidence_id: string;
}

export interface EvidenceEntry {
  id: string;
  type: 'test_pass_rate' | 'historical_issue' | 'code_change';
  module?: string;
  layer?: Layer;
  value?: number;
  runs_sampled?: number;
  /** test_pass_rate only: pass_rate < aggregation_policy.pass_rate_fail_threshold (eligible for high-confidence). */
  below_fail_threshold?: boolean;
  endpoint?: string;
  issue_id?: string;
  confidence?: ConfidenceLevel;
  changed_files?: string[];
  source: string;
  parse_source?: string;
  parse_confidence_cap?: ConfidenceLevel;
}

export interface RiskContext {
  schema_version: '1.0';
  change_id: string;
  generated_at: string;
  requirement_summary?: string;
  aggregation_policy: {
    archive_depth: number;
    archive_order: string;
    runs_per_archive: string;
    skipped_counted_in_denominator: boolean;
    layers: Layer[];
    xfail_treated_as: string;
    xfail_rationale: string;
    recent_fail_batch_window_k: number;
    pass_rate_fail_threshold: number;
  };
  archive_window: {
    depth: number;
    archives_sampled: string[];
    newest_archive: string | null;
    oldest_archive: string | null;
  };
  staleness: {
    max_age_days: number;
    stale: boolean;
  };
  impact: {
    diff_base: string;
    changed_files: string[];
    modules: ModuleImpact[];
    affected_case_ids: string[];
    affected_cases_by_module: Record<string, string[]>;
    affected_test_files: string[];
  };
  case_signals: CaseSignal[];
  test_health: TestHealthEntry[];
  historical_issues: HistoricalIssue[];
  evidence: EvidenceEntry[];
  degraded: boolean;
  degraded_reasons: string[];
  no_git?: boolean;
}

export interface ModuleMapRule {
  pattern: string;
  modules: string[];
  confidence: ConfidenceLevel;
  reason?: string;
}

export interface ModuleMapConfig {
  rules: ModuleMapRule[];
}

export interface LoadedCase {
  case_id: string;
  module: string;
  priority?: string;
  flaky?: boolean;
  automation_required?: boolean;
}

export interface ArchiveBatchSample {
  archive_id: string;
  batch_id: string;
  batch_path: string;
  batch_mtime_ms: number;
  api_result_path?: string;
  e2e_result_path?: string;
}

export interface BuildContextOptions {
  changeId: string;
  projectRoot: string;
  diffBase?: string;
  archiveDepth?: number;
  stalenessDays?: number;
  requirementPath?: string;
}

export interface AdvisoryValidationResult {
  valid: boolean;
  errors: string[];
}
