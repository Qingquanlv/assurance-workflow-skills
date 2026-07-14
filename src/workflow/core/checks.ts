import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import * as yaml from 'js-yaml';
import { AwsConfig, CheckResult, CheckStatus, DoctorResult } from './types';
import { validateConfig } from './schema';

export function runDoctorChecks(root: string): DoctorResult {
  const checks: CheckResult[] = [];

  // --- Config checks ---
  const configPath = path.join(root, '.aws/config.yaml');
  if (!fs.existsSync(configPath)) {
    checks.push({
      id: 'config.exists', group: 'config', status: 'error',
      message: '.aws/config.yaml not found',
      suggested_fix: 'Run `aws init`',
    });
    return buildResult(checks);
  }
  checks.push({ id: 'config.exists', group: 'config', status: 'ok', message: '.aws/config.yaml found' });

  let config: unknown;
  try {
    config = yaml.load(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    checks.push({ id: 'config.schema', group: 'config', status: 'error', message: 'config.yaml parse error' });
    return buildResult(checks);
  }

  const schemaErrors = validateConfig(config);
  if (schemaErrors.length > 0) {
    checks.push({
      id: 'config.schema', group: 'config', status: 'error',
      message: `config schema invalid: ${schemaErrors[0]}`,
    });
    return buildResult(checks);
  }
  checks.push({ id: 'config.schema', group: 'config', status: 'ok', message: 'config schema valid' });

  const cfg = config as AwsConfig;

  checks.push(checkConfigValue(
    'config.prd_input_mode', 'config',
    cfg.generation.prd_input_mode === 'prompt',
    'PRD input mode = prompt',
    'generation.prd_input_mode must be "prompt"',
  ));

  checks.push(checkConfigValue(
    'config.execution_entry', 'config',
    cfg.execution.entry === 'cli',
    'execution entry = cli',
    'execution.entry must be "cli"',
  ));

  checks.push(checkConfigValue(
    'config.self_healing_mode', 'config',
    cfg.execution.self_healing.mode === 'proposal-only',
    'self-healing mode = proposal-only',
    'execution.self_healing.mode must be "proposal-only"',
  ));

  checks.push(checkConfigValue(
    'config.e2e_default_pom', 'config',
    cfg.generation.e2e.default_pom === false,
    'e2e.default_pom = false',
    'generation.e2e.default_pom must be false',
  ));

  // --- Sources ---
  checks.push(checkPath(root, cfg.sources.frontend, 'sources.frontend', 'sources', 'warning',
    `frontend path exists: ${cfg.sources.frontend}`,
    `frontend path not found: ${cfg.sources.frontend}`));

  checks.push(checkPath(root, cfg.sources.backend, 'sources.backend', 'sources', 'warning',
    `backend path exists: ${cfg.sources.backend}`,
    `backend path not found: ${cfg.sources.backend}`));

  // --- Directories ---
  const dirs = [
    { id: 'dir.qa.cases', path: cfg.qa.cases, label: 'qa/cases' },
    { id: 'dir.qa.changes', path: cfg.qa.changes, label: 'qa/changes' },
    { id: 'dir.tests.api', path: cfg.tests.api, label: 'tests/api' },
    { id: 'dir.tests.e2e', path: cfg.tests.e2e, label: 'tests/e2e' },
    { id: 'dir.tests.fixtures', path: cfg.tests.fixtures, label: 'tests/fixtures' },
    { id: 'dir.tests.helpers', path: cfg.tests.helpers, label: 'tests/helpers' },
    { id: 'dir.tests.reports', path: cfg.tests.reports, label: 'tests/reports' },
  ];

  for (const dir of dirs) {
    checks.push(checkPath(root, dir.path, dir.id, 'directories', 'warning',
      `${dir.label} exists`,
      `${dir.label} not found`));
  }

  // --- Frameworks ---
  if (cfg.frameworks.api.enabled) {
    checks.push(checkFramework(cfg.frameworks.api.name));
  }
  if (cfg.frameworks.e2e.enabled) {
    checks.push(checkE2eFramework(cfg.frameworks.e2e.name));
  }

  // --- Workflow ---
  const workflowAgents = cfg.workflow.agents ?? { claude_code: false, codex: false };
  if (workflowAgents.claude_code) {
    const skillPath = path.join(root, '.claude/skills/aws/SKILL.md');
    checks.push({
      id: 'workflow.claude_skill', group: 'workflow',
      status: fs.existsSync(skillPath) ? 'ok' : 'warning',
      message: fs.existsSync(skillPath) ? 'Claude Code skill found' : 'Claude Code skill not found',
      suggested_fix: fs.existsSync(skillPath) ? undefined : 'Run `aws init --repair --claude`',
    });
  } else {
    checks.push({
      id: 'workflow.claude_skill', group: 'workflow',
      status: 'ok',
      message: 'Claude Code workflow disabled',
    });
  }

  if (workflowAgents.codex) {
    const agentsPath = path.join(root, 'AGENTS.md');
    checks.push({
      id: 'workflow.codex_agents', group: 'workflow',
      status: fs.existsSync(agentsPath) ? 'ok' : 'warning',
      message: fs.existsSync(agentsPath) ? 'Codex AGENTS.md found' : 'Codex AGENTS.md not found',
      suggested_fix: fs.existsSync(agentsPath) ? undefined : 'Run `aws init --repair --codex`',
    });
  } else {
    checks.push({
      id: 'workflow.codex_agents', group: 'workflow',
      status: 'ok',
      message: 'Codex workflow disabled',
    });
  }

  // --- MCP ---
  if (cfg.mcp.enabled) {
    const mcpConfigFile = cfg.mcp.config_file ?? '.mcp/config.json';
    const mcpPath = path.join(root, mcpConfigFile);
    checks.push({
      id: 'mcp.config', group: 'mcp',
      status: fs.existsSync(mcpPath) ? 'ok' : 'warning',
      message: fs.existsSync(mcpPath) ? `MCP config found: ${mcpConfigFile}` : `MCP config not found: ${mcpConfigFile}`,
    });
  }

  // --- Execution policy ---
  const policyPath = path.join(root, cfg.execution.policy_file);
  checks.push({
    id: 'execution.policy', group: 'execution',
    status: fs.existsSync(policyPath) ? 'ok' : 'warning',
    message: fs.existsSync(policyPath) ? `policy file found: ${cfg.execution.policy_file}` : `policy file not found: ${cfg.execution.policy_file}`,
    suggested_fix: fs.existsSync(policyPath) ? undefined : 'Run `aws init --repair`',
  });

  return buildResult(checks);
}

function checkConfigValue(
  id: string, group: string,
  condition: boolean,
  okMsg: string, errMsg: string,
): CheckResult {
  return {
    id, group,
    status: condition ? 'ok' : 'error',
    message: condition ? okMsg : errMsg,
  };
}

function checkPath(
  root: string, relPath: string, id: string, group: string,
  missingStatus: CheckStatus,
  okMsg: string, missingMsg: string,
): CheckResult {
  const exists = fs.existsSync(path.join(root, relPath));
  return {
    id, group,
    status: exists ? 'ok' : missingStatus,
    message: exists ? okMsg : missingMsg,
  };
}

function checkFramework(name: string): CheckResult {
  const id = `tool.${name.replace(' ', '_')}`;
  switch (name) {
    case 'pytest':
      return checkCommand(id, 'frameworks', 'pytest', 'API framework: pytest', 'pip install pytest');
    case 'go test':
      return checkCommand(id, 'frameworks', 'go', 'API framework: go test', 'Install Go from https://go.dev');
    case 'jest':
      return checkCommand(id, 'frameworks', 'node', 'API framework: jest (node)', 'Install Node.js from https://nodejs.org');
    default:
      return { id, group: 'frameworks', status: 'ok', message: `API framework: ${name}` };
  }
}

function checkE2eFramework(name: string): CheckResult {
  const id = `tool.${name.toLowerCase()}`;
  switch (name) {
    case 'playwright':
      return checkCommand(id, 'frameworks', 'playwright', 'E2E framework: Playwright', 'npm install @playwright/test && npx playwright install');
    default:
      return { id, group: 'frameworks', status: 'ok', message: `E2E framework: ${name}` };
  }
}

function checkCommand(
  id: string, group: string, command: string,
  okMsg: string, installFix: string,
): CheckResult {
  try {
    execSync(`which ${command}`, { stdio: 'ignore' });
    return { id, group, status: 'ok', message: okMsg };
  } catch {
    try {
      execSync(`${command} --version`, { stdio: 'ignore' });
      return { id, group, status: 'ok', message: okMsg };
    } catch {
      return {
        id, group, status: 'warning',
        message: `${command} not found`,
        suggested_fix: installFix,
      };
    }
  }
}

function buildResult(checks: CheckResult[]): DoctorResult {
  const hasError = checks.some(c => c.status === 'error');
  const hasWarning = checks.some(c => c.status === 'warning');
  const status: CheckStatus = hasError ? 'error' : hasWarning ? 'warning' : 'ok';
  return {
    status,
    summary: {
      ok: checks.filter(c => c.status === 'ok').length,
      warning: checks.filter(c => c.status === 'warning').length,
      error: checks.filter(c => c.status === 'error').length,
    },
    checks,
  };
}
