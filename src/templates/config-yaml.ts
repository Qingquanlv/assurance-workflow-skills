import { InitAnswers } from '../core/types';

export function buildConfigYaml(answers: InitAnswers): string {
  const apiEnabled = answers.apiFramework !== 'none';
  const e2eEnabled = answers.e2eFramework !== 'none';
  const frontendPath = answers.frontendPath ?? './frontend';
  const backendPath = answers.backendPath ?? './backend';

  return `version: 1

project:
  name: ""
  root: .
  layout: default

sources:
  frontend: ${frontendPath}
  backend: ${backendPath}

qa:
  cases: ./qa/cases
  changes: ./qa/changes

tests:
  root: ./tests
  api: ./tests/api
  e2e: ./tests/e2e
  fuzz: ./tests/fuzz
  fixtures: ./tests/fixtures
  helpers: ./tests/helpers
  reports: ./tests/reports

frameworks:
  api:
    enabled: ${apiEnabled}
    name: ${answers.apiFramework}
  e2e:
    enabled: ${e2eEnabled}
    name: ${answers.e2eFramework}

workflow:
  primary_runner: skill
  agent: opencode

mcp:
  enabled: ${answers.enableMcp}

generation:
  prd_input_mode: prompt
  e2e:
    default_pom: false
    locator_priority:
      - role
      - label
      - testid
      - css
  api:
    prefer_existing_fixtures: true

execution:
  entry: cli
  policy_file: ./.aws/execution-policy.json
  ci_must_use_cli: true
  self_healing:
    mode: proposal-only
    allow_assertion_change: false
    allow_product_code_change: false
    allow_auto_merge: false

review:
  require_case_review: true
  require_subplan_review: true
  require_fix_proposal_review: true

archive:
  enable_trace_check: true
  regression_default: true

coverage:
  enabled: true
  target_package: app          # --cov=<target_package>
  threshold:
    line: 70
    branch: 60
  gate_mode: warn              # warn: below threshold → PASS_WITH_WARNINGS (default). block: below → FAIL.

# M3 — Fuzz layer (schemathesis via pytest). Tests live under tests/fuzz/.
# Cases opt in with type: Fuzz; this block only configures the runner.
fuzz:
  enabled: true
  schema_source: ""            # OpenAPI URL or file; codegen uses from_uri/from_asgi accordingly

# M3 — Performance layer (Locust, absolute thresholds, no baseline). Locustfiles live under tests/perf/.
# Cases opt in with type: Performance and confirmed thresholds; SKIPPED if locust is unavailable.
performance:
  enabled: true
  base_url: http://localhost:8000   # target host for Locust --host
  default_load:                      # used when a scenario omits its own load profile
    users: 10                        # concurrent users
    spawn_rate: 2                    # users spawned per second
    run_time_s: 30                   # headless run duration per scenario (seconds)
`;
}
