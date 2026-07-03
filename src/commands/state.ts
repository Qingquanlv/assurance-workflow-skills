import { Command } from 'commander';
import { applyPhaseState, ApplyPhase } from '../core/workflow_state';
import { logBlank, logError, logHeader, logInfo, logOk } from '../utils/logger';

const APPLY_PHASES = new Set(['execution', 'healing-rerun', 'inspect', 'report']);

export function registerStateCommand(program: Command): void {
  const stateCmd = program
    .command('state')
    .description('Workflow-state maintenance commands for the orchestrator');

  stateCmd
    .command('apply')
    .description('Apply a completed phase state delta after dispatch hash verification')
    .requiredOption('--change <change-id>', 'Change ID (e.g. REQ-002-user-logout)')
    .requiredOption('--phase <phase>', 'Phase to apply: execution, healing-rerun, inspect, or report')
    .action((options) => {
      const changeId: string = options.change;
      const phase = String(options.phase);
      const projectRoot = process.cwd();

      logHeader(`aws state apply — change: ${changeId}`);
      logBlank();
      logInfo(`Project root: ${projectRoot}`);
      logInfo(`Phase: ${phase}`);
      logBlank();

      if (!APPLY_PHASES.has(phase)) {
        logError(`Unsupported phase "${phase}". Expected one of: ${Array.from(APPLY_PHASES).join(', ')}`);
        process.exit(1);
      }

      try {
        applyPhaseState(projectRoot, changeId, phase as ApplyPhase);
        logOk(`workflow-state.yaml updated for phase "${phase}"`);
        logBlank();
      } catch (err) {
        logError(`state apply failed: ${(err as Error).message}`);
        if (process.env.AWS_DEBUG) console.error((err as Error).stack);
        process.exit(1);
      }
    });
}
