import { Command } from 'commander';
import chalk from 'chalk';
import { inspect } from '../report/inspector';
import { generateReport } from '../report/report_generator';
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
        const gate = result.qualityGate;
        const gateColor =
          gate.final_status === 'PASS' ? chalk.green :
          gate.final_status === 'FAIL' ? chalk.red :
          gate.final_status === 'PASS_WITH_WARNINGS' ? chalk.yellow : chalk.gray;
        console.log(chalk.bold('  Quality Gate:'));
        console.log(`    Functional : ${gate.dimensions.functional.status}`);
        const covDim = gate.dimensions.coverage;
        console.log(`    Coverage   : ${covDim.status}` + (covDim.available ? `  (line=${covDim.line_coverage}% branch=${covDim.branch_coverage}%)` : '  (not collected)'));
        console.log(`    Final      : ${gateColor(gate.final_status)}`);

        logBlank();
        logOk(`failure-analysis.json    → ${result.analysisPath}`);
        logOk(`failure-summary.md       → ${result.summaryPath}`);
        logOk(`quality-gate-result.json → ${result.qualityGatePath}`);
        logBlank();

        if (gate.final_status === 'FAIL') {
          console.log(chalk.red('→ Quality gate failed. Do not archive/release.'));
          process.exit(1);
        } else if (gate.final_status === 'PASS_WITH_WARNINGS') {
          console.log(chalk.yellow('→ Quality gate passed with warnings. Proceed to report generate / archive with warnings.'));
          process.exit(0);
        } else if (analysis.status === 'no_failures') {
          console.log(chalk.green('→ No failures. Proceed to archive-for-qa.'));
          process.exit(0);
        } else if (analysis.hard_fails.length > 0) {
          console.log(chalk.red('→ Hard failures detected. Investigate product or environment issues.'));
          process.exit(1);
        } else if (analysis.failures.some(f => f.fix_proposal_eligible)) {
          console.log(chalk.yellow('→ Fixable failures found. Proceed to fix-proposal-for-qa.'));
          process.exit(0);
        } else {
          console.log(chalk.yellow('→ Review failures manually — no automatic fixes available.'));
          process.exit(0);
        }
      } catch (err) {
        logError(`Inspect failed: ${(err as Error).message}`);
        if (process.env.AWS_DEBUG) console.error((err as Error).stack);
        process.exit(1);
      }
    });

  reportCmd
    .command('generate')
    .description('Generate a deterministic quality report (quality-report.json/.md + executive-summary.md)')
    .requiredOption('--change <change-id>', 'Change ID (e.g. REQ-002-user-logout)')
    .action((options) => {
      const changeId: string = options.change;
      const projectRoot = process.cwd();

      logHeader(`aws report generate — change: ${changeId}`);
      logBlank();
      logInfo(`Project root: ${projectRoot}`);
      logInfo(`Change: ${changeId}`);
      logBlank();

      try {
        const result = generateReport({ changeId, projectRoot });
        const r = result.report;

        logHeader('Quality Report');
        logBlank();
        const statusColor =
          r.final_status === 'PASS' ? chalk.green :
          r.final_status === 'FAIL' ? chalk.red :
          r.final_status === 'PASS_WITH_WARNINGS' ? chalk.yellow : chalk.gray;
        console.log(`  Final Status  : ${statusColor(r.final_status)}`);
        console.log(`  Quality Score : ${chalk.bold(String(r.quality_score))} / 100`);
        console.log(`  Risk Level    : ${r.risk_level}`);
        console.log(`  Score parts   : functional=${r.score_breakdown.functional} coverage=${r.score_breakdown.coverage} fuzz=${r.score_breakdown.fuzz} performance=${r.score_breakdown.performance}`);
        console.log(`  Recommendation: ${r.recommendation}`);

        logBlank();
        logOk(`quality-report.json   → ${result.jsonPath}`);
        logOk(`quality-report.md     → ${result.mdPath}`);
        logOk(`executive-summary.md  → ${result.execSummaryPath}`);
        logBlank();
      } catch (err) {
        logError(`Report generation failed: ${(err as Error).message}`);
        if (process.env.AWS_DEBUG) console.error((err as Error).stack);
        process.exit(1);
      }
    });
}
