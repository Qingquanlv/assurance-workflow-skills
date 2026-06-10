import { Command } from 'commander';
import chalk from 'chalk';
import { inspect } from '../report/inspector';
import { logInfo, logOk, logError, logBlank, logHeader } from '../utils/logger';

export function registerReportCommand(program: Command): void {
  const reportCmd = program
    .command('report')
    .description('Report commands');

  reportCmd
    .command('inspect')
    .description('Inspect execution results, classify failures, and write failure analysis')
    .requiredOption('--change <change-id>', 'Change ID (e.g. REQ-002-user-logout)')
    .action((options) => {
      const changeId: string = options.change;
      const projectRoot = process.cwd();

      logHeader(`aws report inspect — change: ${changeId}`);
      logBlank();
      logInfo(`Project root: ${projectRoot}`);
      logInfo(`Change: ${changeId}`);
      logBlank();

      try {
        const result = inspect({ changeId, projectRoot });

        logBlank();
        logHeader('Failure Analysis');
        logBlank();

        const { analysis } = result;
        const statusColor =
          analysis.status === 'no_failures' ? chalk.green :
          analysis.status === 'analyzed' ? chalk.yellow :
          chalk.gray;

        const finalColor =
          analysis.final_status === 'PASS' ? chalk.green :
          analysis.final_status === 'FAIL' ? chalk.red : chalk.gray;
        console.log(`  Final Status : ${finalColor(analysis.final_status)}`);
        console.log(`  Batch ID     : ${analysis.batch_id || '(unknown)'}`);
        console.log(`  Inspect Mode : ${analysis.inspect_mode}`);
        console.log(`  Failures     : ${analysis.failures.length}`);
        console.log(`  Hard Fails   : ${analysis.hard_fails.length}`);
        console.log(`  Needs Review : ${analysis.needs_review.length}`);

        if (analysis.failures.length > 0) {
          logBlank();
          console.log(chalk.bold('  Failure breakdown:'));
          const catCounts: Record<string, number> = {};
          for (const f of analysis.failures) {
            catCounts[f.category] = (catCounts[f.category] ?? 0) + 1;
          }
          for (const [cat, cnt] of Object.entries(catCounts)) {
            const allowed = analysis.failures.find(f => f.category === cat)?.fix_proposal_eligible;
            const flag = allowed ? chalk.green('fix-allowed') : chalk.red('no-fix');
            console.log(`    ${cat.padEnd(28)} ×${cnt}  [${flag}]`);
          }
        }

        logBlank();
        logOk(`failure-analysis.json → ${result.analysisPath}`);
        logOk(`failure-summary.md    → ${result.summaryPath}`);
        logBlank();

        if (analysis.status === 'no_failures') {
          console.log(chalk.green('→ No failures. Proceed to archive-for-qa.'));
        } else if (analysis.hard_fails.length > 0) {
          console.log(chalk.red('→ Hard failures detected. Investigate product or environment issues.'));
          process.exit(1);
        } else if (analysis.failures.some(f => f.fix_proposal_eligible)) {
          console.log(chalk.yellow('→ Fixable failures found. Proceed to fix-proposal-for-qa.'));
        } else {
          console.log(chalk.yellow('→ Review failures manually — no automatic fixes available.'));
        }
      } catch (err) {
        logError(`Inspect failed: ${(err as Error).message}`);
        if (process.env.AWS_DEBUG) console.error((err as Error).stack);
        process.exit(1);
      }
    });
}
