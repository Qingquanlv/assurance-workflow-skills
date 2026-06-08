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
`;
}
