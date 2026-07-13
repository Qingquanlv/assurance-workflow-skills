import { Command } from 'commander';
import * as path from 'path';
import { createHeadlessAdapter } from '../driver/headless_adapter';
import { createOpenCodeAdapter, authHeadersFromEnv } from '../driver/opencode_adapter';
import { createProcessRunner } from '../driver/process_runner';
import {
  EXIT_COMPLETED,
  EXIT_ERROR,
  EXIT_HUMAN_REVIEW,
  EXIT_STOPPED,
  readDriverStatus,
  runWorkflowLoop,
} from '../driver/loop';
import { startWorkflowDetached } from '../driver/workflow_start';
import { logBlank, logError, logHeader, logInfo, logOk } from '../utils/logger';

export function registerWorkflowCommand(program: Command): void {
  const workflow = program
    .command('workflow')
    .description('Deterministic TS workflow driver (execute-scope M1)');

  const runAction = async (options: Record<string, string | boolean | undefined>) => {
    const changeId = String(options.change);
    const scope = (options.scope as 'execute' | 'full') || 'execute';
    const adapterName = (options.adapter as string) || 'headless';
    const projectRoot = process.cwd();

    logHeader(`aws workflow run — change: ${changeId}`);
    logBlank();
    logInfo(`Scope: ${scope}`);
    logInfo(`Adapter: ${adapterName}`);
    logBlank();

    let params: Record<string, unknown> = {};
    if (options.params) {
      try {
        params = JSON.parse(String(options.params));
      } catch (err) {
        logError(`Invalid --params JSON: ${(err as Error).message}`);
        process.exit(EXIT_ERROR);
      }
    }

    const runner = createProcessRunner({
      packageRoot: path.resolve(__dirname, '..', '..'),
    });

    const adapter = adapterName === 'opencode'
      ? (() => {
          const server = String(options.server || '');
          if (!server) {
            logError('--server is required for --adapter opencode');
            process.exit(EXIT_ERROR);
          }
          // Explicit --model "provider/model" overrides parent-session/server
          // default resolution (highest priority). Use when the parent session's
          // model is stale/unavailable on the server.
          let model: { providerID: string; modelID: string } | undefined;
          if (options.model) {
            const raw = String(options.model);
            const slash = raw.indexOf('/');
            if (slash <= 0 || slash >= raw.length - 1) {
              logError(`--model must be "provider/model" (got "${raw}")`);
              process.exit(EXIT_ERROR);
            }
            model = { providerID: raw.slice(0, slash), modelID: raw.slice(slash + 1) };
            logInfo(`Model: ${model.providerID}/${model.modelID}`);
          }
          return createOpenCodeAdapter({
            baseUrl: server,
            directory: options.directory ? String(options.directory) : projectRoot,
            authHeaders: authHeadersFromEnv(),
            parentSessionID: options.parentSession ? String(options.parentSession) : undefined,
            model,
          });
        })()
      : createHeadlessAdapter({
          agentCmd: String(options.agentCmd || 'cursor-agent --print'),
          cwd: projectRoot,
        });

    const result = await runWorkflowLoop({
      projectRoot,
      changeId,
      scope,
      adapter,
      runner,
      parentSessionId: options.parentSession ? String(options.parentSession) : null,
      params,
      packageRoot: path.resolve(__dirname, '..', '..'),
      adoptLockToken: options.adoptLock ? String(options.adoptLock) : undefined,
    });

    if (result.exitCode === EXIT_COMPLETED) {
      logOk(`completed: ${result.reason}`);
    } else if (result.exitCode === EXIT_HUMAN_REVIEW) {
      logInfo(`paused for human review: ${result.reason}`);
    } else if (result.exitCode === EXIT_STOPPED) {
      logError(`stopped: ${result.reason}`);
    } else {
      logError(`failed: ${result.reason}`);
    }
    logBlank();
    process.exit(result.exitCode);
  };

  workflow
    .command('run')
    .description('Run or resume the workflow driver from workflow-state breakpoint')
    .requiredOption('--change <change-id>', 'Change ID')
    .option('--scope <scope>', 'execute | full', 'execute')
    .option('--adapter <name>', 'opencode | headless', 'headless')
    .option('--server <url>', 'OpenCode server URL (opencode adapter)')
    .option('--parent-session <sid>', 'Parent session id for nested phase sessions')
    .option('--directory <path>', 'SUT directory for OpenCode ?directory=')
    .option('--agent-cmd <cmd>', 'Headless agent command', 'cursor-agent --print')
    .option('--model <provider/model>', 'Explicit phase model (opencode adapter), overrides parent/default')
    .option('--params <json>', 'Runtime params JSON override', '{}')
    .option('--detach', 'Acquire the driver lock and run in a detached process')
    .option('--adopt-lock <start-token>', 'Adopt lock from detached workflow run (internal)')
    .action((options) => {
      if (options.detach) {
        let params: Record<string, unknown>;
        try {
          params = JSON.parse(String(options.params ?? '{}'));
        } catch (err) {
          logError(`Invalid --params JSON: ${(err as Error).message}`);
          process.exit(EXIT_ERROR);
          return;
        }
        const directory = options.directory ? String(options.directory) : process.cwd();
        const result = startWorkflowDetached({
          projectRoot: directory,
          args: {
            change_id: String(options.change),
            scope: (options.scope as 'execute' | 'full') || 'execute',
            params,
            adapter: (options.adapter as 'opencode' | 'headless') || 'headless',
            agent_cmd: options.agentCmd ? String(options.agentCmd) : undefined,
            model: options.model ? String(options.model) : undefined,
          },
          ctx: {
            sessionID: options.parentSession ? String(options.parentSession) : undefined,
            directory,
          },
          serverUrl: options.server ? String(options.server) : undefined,
          packageRoot: path.resolve(__dirname, '..', '..'),
        });
        if (!result.ok) {
          logError(result.message);
          process.exit(EXIT_ERROR);
          return;
        }
        logOk(result.message);
        process.exit(EXIT_COMPLETED);
        return;
      }
      void runAction(options);
    });

  workflow
    .command('status')
    .description('Show driver.json metadata plus aws status --next')
    .requiredOption('--change <change-id>', 'Change ID')
    .option('--json', 'JSON output')
    .action((options) => {
      const changeId = String(options.change);
      const projectRoot = process.cwd();
      const driver = readDriverStatus(projectRoot, changeId);
      const runner = createProcessRunner({
        packageRoot: path.resolve(__dirname, '..', '..'),
      });
      const status = runner.runAws(
        ['status', '--change', changeId, '--next', '--json'],
        projectRoot,
      );
      let statusJson: unknown = null;
      try {
        statusJson = JSON.parse(status.stdout);
      } catch {
        statusJson = { raw: status.stdout, exitCode: status.exitCode };
      }
      const payload = { driver, status: statusJson };
      console.log(JSON.stringify(payload, null, 2));
      process.exit(status.exitCode === 10 || status.exitCode === 20 ? status.exitCode : 0);
    });
}
