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

        const apiStatus = result.api.status;
        const e2eStatus = result.e2e.status;
        const apiColor = apiStatus === 'passed' ? chalk.green : apiStatus === 'failed' ? chalk.red : chalk.yellow;
        const e2eColor = e2eStatus === 'passed' ? chalk.green : e2eStatus === 'failed' ? chalk.red : chalk.yellow;

        console.log(`  API  : ${apiColor(apiStatus.padEnd(8))}  total=${result.api.total}  passed=${result.api.passed}  failed=${result.api.failed}  skipped=${result.api.skipped}`);
        console.log(`  E2E  : ${e2eColor(e2eStatus.padEnd(8))}  total=${result.e2e.total}  passed=${result.e2e.passed}  failed=${result.e2e.failed}  skipped=${result.e2e.skipped}`);

        const cov = result.coverage;
        if (cov.available) {
          const covColor = cov.status === 'PASS' ? chalk.green : chalk.yellow;
          console.log(`  COV  : ${covColor(cov.status.padEnd(8))}  line=${cov.line_coverage}%  branch=${cov.branch_coverage}%  (threshold line=${cov.threshold.line}% branch=${cov.threshold.branch}%)`);
        } else {
          console.log(`  COV  : ${chalk.gray('SKIPPED ')}  (pytest-cov unavailable or disabled — coverage is a warning, not a failure)`);
        }

        logBlank();
        logOk(`api-result.json      → ${result.executionDir}/api-result.json`);
        logOk(`e2e-result.json      → ${result.executionDir}/e2e-result.json`);
        logOk(`coverage-result.json → ${result.executionDir}/coverage-result.json`);
        logOk(`summary.md           → ${result.executionDir}/summary.md`);
        logBlank();

        const anyFailed = apiStatus === 'failed' || e2eStatus === 'failed';
        const allSkipped = apiStatus === 'skipped' && e2eStatus === 'skipped';
        const allPassed = apiStatus === 'passed' && e2eStatus === 'passed';

        if (anyFailed) {
          console.log(chalk.yellow(`→ Some tests failed. Run: aws report inspect --change ${changeId}`));
          process.exit(1);
        } else if (allSkipped) {
          console.log(chalk.yellow('→ All targets were skipped. Fix environment and rerun.'));
          process.exit(0);
        } else if (allPassed) {
          console.log(chalk.green('→ All tests passed. Proceed to archive-for-qa.'));
          process.exit(0);
        } else {
          console.log(chalk.cyan(`→ Run: aws report inspect --change ${changeId}`));
          process.exit(0);
        }
      } catch (err) {
        logError(`Run failed: ${(err as Error).message}`);
        if (process.env.AWS_DEBUG) console.error((err as Error).stack);
        process.exit(1);
      }
    });
}
