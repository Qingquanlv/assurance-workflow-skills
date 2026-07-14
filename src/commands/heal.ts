import { Command } from 'commander';
import { recordApplySummary } from '../workflow/core/healing_state';
import { logBlank, logError, logHeader, logInfo, logOk } from '../utils/logger';

const TARGETS = new Set(['api', 'e2e']);

export function registerHealCommand(program: Command): void {
  const healCmd = program
    .command('heal')
    .description('Healing helper commands that produce CLI-owned artifacts');

  healCmd
    .command('record-apply')
    .description('Record a fixer application by deriving apply-summary files from the current test tree diff')
    .requiredOption('--change <change-id>', 'Change ID (e.g. REQ-002-user-logout)')
    .requiredOption('--target <target>', 'Fixer target: api or e2e')
    .requiredOption('--proposal <ids>', 'Comma-separated proposal ids applied by the fixer (e.g. FIX-001,FIX-002)')
    .action((options) => {
      const changeId: string = options.change;
      const target = String(options.target);
      const proposals = String(options.proposal)
        .split(',')
        .map(id => id.trim())
        .filter(Boolean);
      const projectRoot = process.cwd();

      logHeader(`aws heal record-apply — change: ${changeId}`);
      logBlank();
      logInfo(`Project root: ${projectRoot}`);
      logInfo(`Target: ${target}`);
      logInfo(`Proposals: ${proposals.join(', ') || '(none)'}`);
      logBlank();

      if (!TARGETS.has(target)) {
        logError(`Unsupported target "${target}". Expected one of: ${Array.from(TARGETS).join(', ')}`);
        process.exit(1);
      }

      try {
        const result = recordApplySummary(projectRoot, changeId, target as 'api' | 'e2e', proposals);
        logOk(`${target}-apply-summary.json → ${result.summaryPath}`);
        logOk(`${target}-apply-summary.md   → ${result.markdownPath}`);
        logInfo(`Modified files: ${result.modifiedFiles.length}`);
        logInfo(`Applied proposals: ${result.appliedProposalIds.join(', ') || '(none)'}`);
        if (result.skippedProposalIds.length > 0) {
          logInfo(`Skipped proposals: ${result.skippedProposalIds.join(', ')}`);
        }
        logBlank();
      } catch (err) {
        logError(`heal record-apply failed: ${(err as Error).message}`);
        if (process.env.AWS_DEBUG) console.error((err as Error).stack);
        process.exit(1);
      }
    });
}
