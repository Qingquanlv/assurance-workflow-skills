export interface AweConfig {
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
  agent: 'claude_code' | 'codex' | 'both' | 'none';
  apiFramework: 'pytest' | 'go test' | 'jest' | 'none';
  e2eFramework: 'playwright' | 'none';
  enableMcp: boolean;
  confirm: boolean;
  frontendPath?: string;
  backendPath?: string;
}
