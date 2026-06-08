import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

const CLI = path.resolve(__dirname, '../../../dist/cli.js');

describe('aws doctor --json (integration)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-int-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('returns error status when no config', () => {
    let output: string;
    try {
      output = execSync(`node ${CLI} doctor --json`, {
        cwd: tmpDir,
        env: process.env,
      }).toString();
    } catch (e: unknown) {
      output = (e as { stdout: Buffer }).stdout?.toString() ?? '';
    }
    const result = JSON.parse(output);
    expect(result.status).toBe('error');
    expect(result.checks.find((c: { id: string }) => c.id === 'config.exists').status).toBe('error');
  });

  it('returns warning or ok status when config valid but dirs missing', () => {
    const awsDir = path.join(tmpDir, '.awe');
    fs.mkdirSync(awsDir);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const yaml = require('js-yaml');
    const config = {
      version: 1,
      project: { name: '', root: '.', layout: 'default' },
      sources: { frontend: './frontend', backend: './backend' },
      qa: { cases: './qa/cases', changes: './qa/changes' },
      tests: { root: './tests', api: './tests/api', e2e: './tests/e2e', fixtures: './tests/fixtures', helpers: './tests/helpers', reports: './tests/reports' },
      frameworks: { api: { enabled: true, name: 'pytest' }, e2e: { enabled: true, name: 'playwright' } },
      workflow: { primary_runner: 'skill', agents: { claude_code: false, codex: false } },
      mcp: { enabled: false },
      generation: { prd_input_mode: 'prompt', e2e: { default_pom: false, locator_priority: ['role'] }, api: { prefer_existing_fixtures: true } },
      execution: { entry: 'cli', policy_file: './.aws/execution-policy.json', ci_must_use_cli: true, self_healing: { mode: 'proposal-only', allow_assertion_change: false, allow_product_code_change: false, allow_auto_merge: false } },
      review: { require_case_review: true, require_subplan_review: true, require_fix_proposal_review: true },
      archive: { enable_trace_check: true, regression_default: true }
    };
    fs.writeFileSync(path.join(awsDir, 'config.yaml'), yaml.dump(config));
    fs.writeFileSync(path.join(awsDir, 'execution-policy.json'), '{}');

    let output: string;
    try {
      output = execSync(`node ${CLI} doctor --json`, { cwd: tmpDir, env: process.env }).toString();
    } catch (e: unknown) {
      output = (e as { stdout: Buffer }).stdout?.toString() ?? '';
    }

    const result = JSON.parse(output);
    expect(['ok', 'warning']).toContain(result.status);
    expect(result.checks).toBeInstanceOf(Array);
    expect(result.summary).toHaveProperty('ok');
    expect(result.summary).toHaveProperty('warning');
    expect(result.summary).toHaveProperty('error');
  });
});
