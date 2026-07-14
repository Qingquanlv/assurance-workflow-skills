import { Command } from 'commander';
import { recordHumanDecision } from '../workflow/core/decide';
import { isHumanDecisionAction } from '../workflow/core/events';
import { logBlank, logError, logHeader, logOk } from '../utils/logger';

export function registerDecideCommand(program: Command): void {
  program
    .command('decide')
    .description('Record a supported human workflow decision')
    .requiredOption('--change <change-id>', 'Change ID')
    .requiredOption('--at <checkpoint>', 'Gate, phase, or supported workflow checkpoint')
    .requiredOption('--action <action>', 'Supported action for the checkpoint')
    .requiredOption('--reason <text>', 'Human decision reason')
    .option('--evidence <path>', 'Supporting evidence file within the project root')
    .action((options) => {
      const changeId = String(options.change);
      const checkpoint = String(options.at);
      const action = String(options.action);

      try {
        if (!isHumanDecisionAction(action)) {
          logError(`decide failed: unsupported action '${action}'`);
          process.exit(1);
          return;
        }
        recordHumanDecision({
          projectRoot: process.cwd(),
          changeId,
          checkpoint,
          action,
          reason: String(options.reason),
          evidence: options.evidence ? String(options.evidence) : undefined,
        });
        logHeader(`aws decide — ${checkpoint}`);
        logBlank();
        logOk(`human_decision recorded: action=${action}`);
        logBlank();
      } catch (err) {
        logError(`decide failed: ${(err as Error).message}`);
        if (process.env.AWS_DEBUG) console.error((err as Error).stack);
        process.exit(1);
      }
    });
}
