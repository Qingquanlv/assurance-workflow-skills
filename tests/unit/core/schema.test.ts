import { validateConfig, isValidConfig } from '../../../src/core/schema';

describe('validateConfig', () => {
  it('returns valid for a complete config', () => {
    const config = buildMinimalConfig({});
    expect(isValidConfig(config)).toBe(true);
    expect(validateConfig(config)).toHaveLength(0);
  });

  it('returns errors for missing required fields', () => {
    expect(isValidConfig({})).toBe(false);
    expect(validateConfig({})).toContain('missing: version');
    expect(validateConfig({})).toContain('missing: project');
    expect(validateConfig({})).toContain('missing: sources');
  });

  it('returns error when prd_input_mode is not prompt', () => {
    const config = buildMinimalConfig({ prd_input_mode: 'directory' });
    const errors = validateConfig(config);
    expect(errors).toContain('generation.prd_input_mode must be "prompt"');
  });

  it('returns error when execution.entry is not cli', () => {
    const config = buildMinimalConfig({ entry: 'mcp' });
    const errors = validateConfig(config);
    expect(errors).toContain('execution.entry must be "cli"');
  });

  it('returns error when self_healing.mode is not proposal-only', () => {
    const config = buildMinimalConfig({ healingMode: 'auto' });
    const errors = validateConfig(config);
    expect(errors).toContain('execution.self_healing.mode must be "proposal-only"');
  });

  it('returns error when e2e.default_pom is true', () => {
    const config = buildMinimalConfig({ defaultPom: true });
    const errors = validateConfig(config);
    expect(errors).toContain('generation.e2e.default_pom must be false');
  });
});

function buildMinimalConfig(overrides: {
  prd_input_mode?: string;
  entry?: string;
  healingMode?: string;
  defaultPom?: boolean;
}) {
  return {
    version: 1,
    project: { name: '', root: '.', layout: 'default' },
    sources: { frontend: './frontend', backend: './backend' },
    qa: { cases: './qa/cases', changes: './qa/changes' },
    tests: {
      root: './tests', api: './tests/api', e2e: './tests/e2e',
      fixtures: './tests/fixtures', helpers: './tests/helpers', reports: './tests/reports'
    },
    frameworks: {
      api: { enabled: true, name: 'pytest' },
      e2e: { enabled: true, name: 'playwright' }
    },
    workflow: { primary_runner: 'skill', agents: { claude_code: true, codex: false } },
    mcp: { enabled: false },
    generation: {
      prd_input_mode: overrides.prd_input_mode ?? 'prompt',
      e2e: { default_pom: overrides.defaultPom ?? false, locator_priority: ['role'] },
      api: { prefer_existing_fixtures: true }
    },
    execution: {
      entry: overrides.entry ?? 'cli',
      policy_file: './.awe/execution-policy.json',
      ci_must_use_cli: true,
      self_healing: {
        mode: overrides.healingMode ?? 'proposal-only',
        allow_assertion_change: false,
        allow_product_code_change: false,
        allow_auto_merge: false
      }
    },
    review: { require_case_review: true, require_subplan_review: true, require_fix_proposal_review: true },
    archive: { enable_trace_check: true, regression_default: true }
  };
}
