import { Command } from 'commander';
import chalk from 'chalk';
import { runDoctorChecks } from '../core/checks';
import { CheckResult, DoctorResult } from '../core/types';

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check AWE environment and configuration')
    .option('--json', 'Output machine-readable JSON')
    .action((options) => {
      const root = process.cwd();
      const result = runDoctorChecks(root);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.status === 'error' ? 1 : 0);
        return;
      }

      printDoctorResult(result);
      process.exit(result.status === 'error' ? 1 : 0);
    });
}

function printDoctorResult(result: DoctorResult): void {
  console.log(chalk.bold('\nAWE Doctor\n'));

  const groups = ['config', 'sources', 'directories', 'frameworks', 'workflow', 'execution', 'mcp'];
  const groupLabels: Record<string, string> = {
    config: 'Config',
    sources: 'Sources',
    directories: 'Directories',
    frameworks: 'Frameworks',
    workflow: 'Workflow',
    execution: 'Execution',
    mcp: 'MCP',
  };

  const grouped = new Map<string, CheckResult[]>();
  for (const check of result.checks) {
    if (!grouped.has(check.group)) grouped.set(check.group, []);
    grouped.get(check.group)!.push(check);
  }

  for (const group of groups) {
    const checks = grouped.get(group);
    if (!checks || checks.length === 0) continue;

    console.log(chalk.bold(groupLabels[group] ?? group));
    for (const check of checks) {
      printCheck(check);
    }
    console.log('');
  }

  // Print any ungrouped checks
  for (const [group, checks] of grouped.entries()) {
    if (!groups.includes(group)) {
      console.log(chalk.bold(group));
      for (const check of checks) printCheck(check);
      console.log('');
    }
  }

  const statusColor = result.status === 'ok' ? chalk.green : result.status === 'warning' ? chalk.yellow : chalk.red;
  console.log('Result: ' + statusColor.bold(result.status.toUpperCase()));
}

function printCheck(check: CheckResult): void {
  const icon =
    check.status === 'ok' ? chalk.green('✓') :
    check.status === 'warning' ? chalk.yellow('!') :
    chalk.red('✗');

  console.log(`${icon} ${check.message}`);
  if (check.suggested_fix && check.status !== 'ok') {
    console.log(`  ${chalk.dim('→ ' + check.suggested_fix)}`);
  }
}
