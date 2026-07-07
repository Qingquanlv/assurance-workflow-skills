import { Command } from 'commander';
import { applyPhaseState, ApplyPhase, OrchestratorSkill, stampRunContext } from '../core/workflow_state';
import { transitionHealingStatus, HealingStatus } from '../core/healing_state';
import { logBlank, logError, logHeader, logInfo, logOk } from '../utils/logger';

const APPLY_PHASES = new Set(['execution', 'healing-rerun', 'inspect', 'healing-reinspect', 'report']);
const ORCHESTRATOR_SKILLS = new Set(['aws-workflow', 'aws-intake', 'aws-execute']);
const HEAL_STATUSES = new Set([
  'proposal_created', 'applied', 'resolved', 'exhausted', 'not_needed', 'failed', 'skipped',
]);

export function registerStateCommand(program: Command): void {
  const stateCmd = program
    .command('state')
    .description('Workflow-state maintenance commands for the orchestrator');

  stateCmd
    .command('apply')
    .description('Apply a completed phase state delta after dispatch hash verification')
    .requiredOption('--change <change-id>', 'Change ID (e.g. REQ-002-user-logout)')
    .requiredOption('--phase <phase>', 'Phase to apply: execution, healing-rerun, inspect, healing-reinspect, or report')
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

  stateCmd
    .command('stamp-run-context')
    .description('Stamp derived run_context for the active orchestrator')
    .requiredOption('--change <change-id>', 'Change ID (e.g. REQ-002-user-logout)')
    .requiredOption('--orchestrator <skill>', 'Orchestrator skill: aws-workflow, aws-intake, or aws-execute')
    .action((options) => {
      const changeId: string = options.change;
      const orchestrator = String(options.orchestrator);
      const projectRoot = process.cwd();

      logHeader(`aws state stamp-run-context — change: ${changeId}`);
      logBlank();
      logInfo(`Project root: ${projectRoot}`);
      logInfo(`Orchestrator: ${orchestrator}`);
      logBlank();

      if (!ORCHESTRATOR_SKILLS.has(orchestrator)) {
        logError(`Unsupported orchestrator "${orchestrator}". Expected one of: ${Array.from(ORCHESTRATOR_SKILLS).join(', ')}`);
        process.exit(1);
      }

      try {
        stampRunContext(projectRoot, changeId, orchestrator as OrchestratorSkill);
        logOk(`workflow-state.yaml run_context stamped for "${orchestrator}"`);
        logBlank();
      } catch (err) {
        logError(`state stamp-run-context failed: ${(err as Error).message}`);
        if (process.env.AWS_DEBUG) console.error((err as Error).stack);
        process.exit(1);
      }
    });

  stateCmd
    .command('heal')
    .description('Transition healing.status with enforced preconditions')
    .requiredOption('--change <change-id>', 'Change ID (e.g. REQ-002-user-logout)')
    .requiredOption('--to <status>', 'Target healing status')
    .action((options) => {
      const changeId: string = options.change;
      const to = String(options.to);
      const projectRoot = process.cwd();

      logHeader(`aws state heal — change: ${changeId}`);
      logBlank();
      logInfo(`Target status: ${to}`);
      logBlank();

      if (!HEAL_STATUSES.has(to)) {
        logError(`Unsupported healing status "${to}". Expected one of: ${Array.from(HEAL_STATUSES).join(', ')}`);
        process.exit(1);
      }

      try {
        const result = transitionHealingStatus(projectRoot, changeId, to as HealingStatus);
        logOk(`healing.status: ${result.from} → ${result.to}`);
        logBlank();
      } catch (err) {
        const message = (err as Error).message;
        logError(message.startsWith('HEAL-') ? message : `state heal failed: ${message}`);
        if (process.env.AWS_DEBUG) console.error((err as Error).stack);
        process.exit(1);
      }
    });
}
