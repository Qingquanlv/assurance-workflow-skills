import { Command } from 'commander';
import chalk from 'chalk';
import { run } from '../execution/runner';
import { logInfo, logOk, logError, logBlank, logHeader } from '../utils/logger';

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Execute API and E2E tests for a change and write normalized execution results')
    .requiredOption('--change <change-id>', 'Change ID (e.g. REQ-002-user-logout)')
    .action((options) => {
      const changeId: string = options.change;
      const projectRoot = process.cwd();

      logHeader(`aws run — change: ${changeId}`);
      logBlank();
      logInfo(`Project root: ${projectRoot}`);
      logInfo(`Change: ${changeId}`);
      logBlank();

      try {
        const result = run({ changeId, projectRoot });

        logBlank();
        logHeader('Execution Results');
        logBlank();

        const apiStatus = result.api?.status ?? 'unselected';
        const e2eStatus = result.e2e?.status ?? 'unselected';
        const apiColor = apiStatus === 'passed' ? chalk.green : apiStatus === 'failed' ? chalk.red : chalk.yellow;
        const e2eColor = e2eStatus === 'passed' ? chalk.green : e2eStatus === 'failed' ? chalk.red : chalk.yellow;

        console.log(`  API  : ${apiColor(apiStatus.padEnd(10))}  total=${result.api?.total ?? 0}  passed=${result.api?.passed ?? 0}  failed=${result.api?.failed ?? 0}  skipped=${result.api?.skipped ?? 0}`);
        console.log(`  E2E  : ${e2eColor(e2eStatus.padEnd(10))}  total=${result.e2e?.total ?? 0}  passed=${result.e2e?.passed ?? 0}  failed=${result.e2e?.failed ?? 0}  skipped=${result.e2e?.skipped ?? 0}`);
        if (result.fuzz) {
          const fuzzColor = result.fuzz.status === 'passed' ? chalk.green : result.fuzz.status === 'failed' ? chalk.red : chalk.yellow;
          console.log(`  FUZZ : ${fuzzColor(result.fuzz.status.padEnd(10))}  total=${result.fuzz.total}  passed=${result.fuzz.passed}  failed=${result.fuzz.failed}  skipped=${result.fuzz.skipped}`);
        } else {
          console.log(`  FUZZ : ${chalk.gray('unselected '.padEnd(10))}  total=0  passed=0  failed=0  skipped=0`);
        }
        if (result.performance) {
          const perfColor = result.performance.status === 'PASS' ? chalk.green : result.performance.status === 'FAIL' ? chalk.red : chalk.yellow;
          console.log(`  PERF : ${perfColor(result.performance.status.padEnd(10))}  scenarios=${result.performance.scenarios.length}`);
        } else {
          console.log(`  PERF : ${chalk.gray('unselected '.padEnd(10))}  scenarios=0`);
        }

        const cov = result.coverage;
        if (cov?.available) {
          const covColor = cov.status === 'PASS' ? chalk.green : chalk.yellow;
          console.log(`  COV  : ${covColor(cov.status.padEnd(8))}  line=${cov.line_coverage}%  branch=${cov.branch_coverage}%  (threshold line=${cov.threshold.line}% branch=${cov.threshold.branch}%)`);
        } else if (cov) {
          console.log(`  COV  : ${chalk.gray('SKIPPED ')}  (pytest-cov unavailable or disabled — coverage is a warning, not a failure)`);
        } else {
          console.log(`  COV  : ${chalk.gray('UNSELECTED')}`);
        }

        logBlank();
        logOk(`execution-manifest.yaml → ${result.executionDir}/execution-manifest.yaml`);
        if (result.api) logOk(`api-result.json         → ${result.executionDir}/api-result.json`);
        if (result.e2e) logOk(`e2e-result.json         → ${result.executionDir}/e2e-result.json`);
        if (result.coverage) logOk(`coverage-result.json    → ${result.executionDir}/coverage-result.json`);
        if (result.fuzz) logOk(`fuzz-result.json        → ${result.executionDir}/fuzz-result.json`);
        if (result.performance) logOk(`performance-result.json → ${result.executionDir}/performance-result.json`);
        logOk(`summary.md              → ${result.executionDir}/summary.md`);
        logBlank();

        if (result.qualityGate.final_status === 'FAIL') {
          console.log(chalk.red(`→ Quality gate failed. Run: aws report inspect --change ${changeId}`));
          process.exit(1);
        } else if (result.qualityGate.final_status === 'PASS') {
          console.log(chalk.green('→ Quality gate passed. Proceed to archive-for-qa.'));
          process.exit(0);
        } else if (result.qualityGate.final_status === 'PASS_WITH_WARNINGS') {
          console.log(chalk.yellow(`→ Quality gate passed with warnings. Run: aws report inspect --change ${changeId}`));
          process.exit(0);
        } else {
          // final_status === 'SKIPPED'
          const anyTargetSelected = Object.values(result.selectedTargets).some(Boolean);
          if (!anyTargetSelected) {
            // All targets explicitly unselected — treat as a no-op run, not a failure.
            console.log(chalk.cyan('→ No targets selected — run skipped. Pass --change with selected targets.'));
            process.exit(0);
          } else {
            // Some targets were selected but all ran as SKIPPED (environment issue, missing fixtures, etc.).
            // Exit 1 so CI does not silently pass when tests never actually ran.
            console.log(chalk.yellow(`→ All selected targets were skipped (environment may be unreachable). Run: aws report inspect --change ${changeId}`));
            process.exit(1);
          }
        }
      } catch (err) {
        logError(`Run failed: ${(err as Error).message}`);
        if (process.env.AWS_DEBUG) console.error((err as Error).stack);
        process.exit(1);
      }
    });
}
