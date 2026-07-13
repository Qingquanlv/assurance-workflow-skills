import { Command } from 'commander';
import {
  configureWorkflowParams,
  OrchestratorSkill,
} from '../core/workflow_state';
import { transitionHealingStatus, HealingStatus } from '../core/healing_state';
import { findSchemaFile, loadSchemaFromFile } from '../orchestration/schema';
import { createWorkflowProgression } from '../orchestration/progression';
import { logBlank, logError, logHeader, logInfo, logOk } from '../utils/logger';

const CONFIGURE_ORCHESTRATORS = new Set(['aws-workflow', 'aws-intake', 'aws-execute']);
const HEAL_STATUSES = new Set([
  'resolved', 'exhausted', 'not_needed', 'failed', 'skipped',
]);

export function registerStateCommand(program: Command): void {
  const stateCmd = program
    .command('state')
    .description('Workflow-state maintenance commands for the orchestrator');

  stateCmd
    .command('apply')
    .description('Apply a completed phase state delta after dispatch hash verification')
    .requiredOption('--change <change-id>', 'Change ID (e.g. REQ-002-user-logout)')
    .requiredOption('--phase <phase>', 'Schema phase id to apply (registry fail-closed)')
    .option('--attempt-id <id>', 'Stable dispatch attempt id for idempotent retries')
    .action((options) => {
      const changeId: string = options.change;
      const phase = String(options.phase);
      const projectRoot = process.cwd();

      logHeader(`aws state apply — change: ${changeId}`);
      logBlank();
      logInfo(`Project root: ${projectRoot}`);
      logInfo(`Phase: ${phase}`);
      logBlank();

      try {
        const schema = loadSchemaFromFile(findSchemaFile(projectRoot));
        const progressionOptions = { schema, projectRoot, changeId };
        const progression = createWorkflowProgression(progressionOptions);
        const { action } = progression.inspect();
        if (action.kind !== 'dispatch_phase' || action.phase !== phase) {
          throw new Error(
            `state apply: phase '${phase}' is not the current dispatch target ` +
            `(inspect returned ${action.kind === 'dispatch_phase' ? action.phase : action.kind})`,
          );
        }
        progression.advance({
          attemptId: options.attemptId ? String(options.attemptId) : action.attemptId,
          stateGuard: action.stateGuard,
          kind: 'dispatch_phase',
          phase,
        });
        logOk(`workflow-state.yaml updated for phase "${phase}"`);
        logBlank();
      } catch (err) {
        logError(`state apply failed: ${(err as Error).message}`);
        if (process.env.AWS_DEBUG) console.error((err as Error).stack);
        process.exit(1);
      }
    });

  stateCmd
    .command('configure')
    .description('Merge runtime params into workflow-state.yaml and stamp run_context')
    .requiredOption('--change <change-id>', 'Change ID')
    .option('--params-json <json>', 'JSON object of params to merge', '{}')
    .requiredOption('--orchestrator <skill>', 'Logical orchestrator: aws-intake, aws-execute, or aws-workflow')
    .action((options) => {
      const changeId: string = options.change;
      const orchestrator = String(options.orchestrator);
      const projectRoot = process.cwd();

      logHeader(`aws state configure — change: ${changeId}`);
      logBlank();

      if (!CONFIGURE_ORCHESTRATORS.has(orchestrator)) {
        logError(`Unsupported orchestrator "${orchestrator}". Expected aws-intake, aws-execute, or aws-workflow`);
        process.exit(1);
      }

      let params: Record<string, unknown>;
      try {
        params = JSON.parse(String(options.paramsJson));
        if (params === null || typeof params !== 'object' || Array.isArray(params)) {
          throw new Error('params-json must be a JSON object');
        }
      } catch (err) {
        logError(`Invalid --params-json: ${(err as Error).message}`);
        process.exit(1);
        return;
      }

      try {
        configureWorkflowParams(projectRoot, changeId, params, orchestrator as OrchestratorSkill);
        logOk(`params merged and run_context stamped for "${orchestrator}"`);
        logBlank();
      } catch (err) {
        logError(`state configure failed: ${(err as Error).message}`);
        if (process.env.AWS_DEBUG) console.error((err as Error).stack);
        process.exit(1);
      }
    });

  stateCmd
    .command('heal')
    .description('Record an orchestrator healing judgment')
    .requiredOption('--change <change-id>', 'Change ID (e.g. REQ-002-user-logout)')
    .requiredOption('--to <status>', 'Healing judgment')
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
        logOk(`healing judgment recorded: ${result.from} → ${result.to}`);
        logBlank();
      } catch (err) {
        const message = (err as Error).message;
        logError(message.startsWith('HEAL-') ? message : `state heal failed: ${message}`);
        if (process.env.AWS_DEBUG) console.error((err as Error).stack);
        process.exit(1);
      }
    });
}
