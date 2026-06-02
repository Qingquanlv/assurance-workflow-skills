import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { runDoctorChecks } from '../../../src/core/checks';

describe('runDoctorChecks', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awe-doctor-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  function writeConfig() {
    const config = buildValidConfig();
    const configDir = path.join(tmpDir, '.awe');
    fs.mkdirSync(configDir, { recursive: true });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const yaml = require('js-yaml');
    fs.writeFileSync(path.join(configDir, 'config.yaml'), yaml.dump(config));
    return config;
  }

  function writePolicy() {
    const policyPath = path.join(tmpDir, '.awe/execution-policy.json');
    fs.writeFileSync(policyPath, JSON.stringify({ tier: 'local' }));
  }

  it('returns error when config.yaml does not exist', () => {
    const result = runDoctorChecks(tmpDir);
    const configCheck = result.checks.find(c => c.id === 'config.exists');
    expect(configCheck?.status).toBe('error');
    expect(result.status).toBe('error');
  });

  it('returns ok for all config checks when config is valid', () => {
    writeConfig();
    writePolicy();
    const result = runDoctorChecks(tmpDir);
    const configExists = result.checks.find(c => c.id === 'config.exists');
    const schemaValid = result.checks.find(c => c.id === 'config.schema');
    expect(configExists?.status).toBe('ok');
    expect(schemaValid?.status).toBe('ok');
  });

  it('returns error when config schema is invalid', () => {
    const configDir = path.join(tmpDir, '.awe');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.yaml'), 'not_a_valid_config: true\n');

    const result = runDoctorChecks(tmpDir);
    const schemaCheck = result.checks.find(c => c.id === 'config.schema');
    expect(schemaCheck?.status).toBe('error');
  });

  it('returns warning when frontend path does not exist', () => {
    writeConfig();
    writePolicy();
    const result = runDoctorChecks(tmpDir);
    const frontendCheck = result.checks.find(c => c.id === 'sources.frontend');
    expect(frontendCheck?.status).toBe('warning');
  });

  it('returns ok when frontend path exists', () => {
    writeConfig();
    writePolicy();
    fs.mkdirSync(path.join(tmpDir, 'frontend'), { recursive: true });
    const result = runDoctorChecks(tmpDir);
    const frontendCheck = result.checks.find(c => c.id === 'sources.frontend');
    expect(frontendCheck?.status).toBe('ok');
  });

  it('returns warning when qa/cases does not exist', () => {
    writeConfig();
    writePolicy();
    const result = runDoctorChecks(tmpDir);
    const check = result.checks.find(c => c.id === 'dir.qa.cases');
    expect(check?.status).toBe('warning');
  });

  it('returns ok when qa/cases exists', () => {
    writeConfig();
    writePolicy();
    fs.mkdirSync(path.join(tmpDir, 'qa/cases'), { recursive: true });
    const result = runDoctorChecks(tmpDir);
    const check = result.checks.find(c => c.id === 'dir.qa.cases');
    expect(check?.status).toBe('ok');
  });

  it('returns warning when policy file does not exist', () => {
    writeConfig();
    // do NOT write policy
    const result = runDoctorChecks(tmpDir);
    const check = result.checks.find(c => c.id === 'execution.policy');
    expect(check?.status).toBe('warning');
  });

  it('returns ok when policy file exists', () => {
    writeConfig();
    writePolicy();
    const result = runDoctorChecks(tmpDir);
    const check = result.checks.find(c => c.id === 'execution.policy');
    expect(check?.status).toBe('ok');
  });

  it('status is error when any check is error', () => {
    const result = runDoctorChecks(tmpDir);
    expect(result.status).toBe('error');
  });

  it('status is warning when no errors but some warnings', () => {
    writeConfig();
    writePolicy();
    const result = runDoctorChecks(tmpDir);
    const hasError = result.checks.some(c => c.status === 'error');
    const hasWarning = result.checks.some(c => c.status === 'warning');
    expect(hasError).toBe(false);
    expect(hasWarning).toBe(true);
    expect(result.status).toBe('warning');
  });

  it('summary counts are accurate', () => {
    writeConfig();
    writePolicy();
    const result = runDoctorChecks(tmpDir);
    const actual = {
      ok: result.checks.filter(c => c.status === 'ok').length,
      warning: result.checks.filter(c => c.status === 'warning').length,
      error: result.checks.filter(c => c.status === 'error').length,
    };
    expect(result.summary).toEqual(actual);
  });
});

function buildValidConfig() {
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
      prd_input_mode: 'prompt',
      e2e: { default_pom: false, locator_priority: ['role'] },
      api: { prefer_existing_fixtures: true }
    },
    execution: {
      entry: 'cli',
      policy_file: './.awe/execution-policy.json',
      ci_must_use_cli: true,
      self_healing: {
        mode: 'proposal-only',
        allow_assertion_change: false,
        allow_product_code_change: false,
        allow_auto_merge: false
      }
    },
    review: { require_case_review: true, require_subplan_review: true, require_fix_proposal_review: true },
    archive: { enable_trace_check: true, regression_default: true }
  };
}
