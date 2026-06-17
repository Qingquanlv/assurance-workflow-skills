import * as path from 'path';
import * as fs from 'fs';
import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { InitAgent, InitAnswers } from '../core/types';
import {
  generateProject,
  repairProject,
  registerOpenCode,
  findPackageRoot,
} from '../core/generator';
import { formatStaleAssetWarning, wantsOpenCode } from '../core/opencode-assets';
import { logOk, logWarn, logError, logInfo, logBlank } from '../utils/logger';

interface InitCliOptions {
  repair?: boolean;
  agent?: InitAgent;
  yes?: boolean;
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize AWS project in current directory')
    .option('--repair', 'Repair mode: only create missing files, never overwrite')
    .option(
      '--agent <workflow>',
      'Agent workflow: claude_code | codex | both | opencode | all | none'
    )
    .option('--yes', 'Non-interactive mode with defaults (requires --agent for OpenCode-only init)')
    .action(async (options: InitCliOptions) => {
      const root = process.cwd();

      if (options.repair) {
        await runRepair(root);
      } else {
        await runInit(root, options);
      }
    });
}

function parseAgent(value?: string): InitAgent | undefined {
  if (!value) return undefined;
  const allowed: InitAgent[] = [
    'claude_code',
    'codex',
    'both',
    'opencode',
    'all',
    'none',
  ];
  if (!allowed.includes(value as InitAgent)) {
    throw new Error(`Invalid --agent value '${value}'`);
  }
  return value as InitAgent;
}

async function runInit(root: string, options: InitCliOptions): Promise<void> {
  const defaultFrontend = './frontend';
  const defaultBackend = './backend';
  const agentFromCli = parseAgent(options.agent);

  if (options.yes && !agentFromCli) {
    logError('--yes requires --agent (e.g. --agent opencode)');
    process.exit(1);
  }

  if (!options.yes) {
    console.log(chalk.bold('\nWelcome to AWS.\n'));
    console.log('AWS will initialize this project with:');
    console.log(`  - project root: .`);
    console.log(`  - frontend source: ${defaultFrontend}`);
    console.log(`  - backend source: ${defaultBackend}`);
    console.log(`  - QA cases: ./qa/cases`);
    console.log(`  - QA changes: ./qa/changes`);
    console.log(`  - test output: ./tests`);
    console.log(`  - PRD input mode: prompt`);
    console.log(`  - API + E2E workflow enabled by default`);
    logBlank();
  }

  let answers: InitAnswers;

  if (options.yes && agentFromCli) {
    answers = {
      apiFramework: 'pytest',
      e2eFramework: 'playwright',
      enableMcp: false,
      confirm: true,
      agent: agentFromCli,
    };
  } else {
    const questions: inquirer.QuestionCollection = [
      {
        type: 'list',
        name: 'agent',
        message: 'Agent workflow:',
        choices: [
          { name: 'OpenCode (recommended for hybrid workflow)', value: 'opencode' },
          { name: 'All (Claude Code + Codex + OpenCode)', value: 'all' },
          { name: 'Claude Code only', value: 'claude_code' },
          { name: 'Codex only', value: 'codex' },
          { name: 'Both (Claude Code + Codex)', value: 'both' },
          { name: 'None', value: 'none' },
        ],
        default: agentFromCli ?? 'opencode',
      },
      {
        type: 'list',
        name: 'apiFramework',
        message: 'API test framework:',
        choices: [
          { name: 'pytest', value: 'pytest' },
          { name: 'none', value: 'none' },
        ],
        default: 'pytest',
      },
      {
        type: 'list',
        name: 'e2eFramework',
        message: 'E2E test framework:',
        choices: [
          { name: 'Playwright', value: 'playwright' },
          { name: 'none', value: 'none' },
        ],
        default: 'playwright',
      },
      {
        type: 'confirm',
        name: 'enableMcp',
        message: 'Enable MCP config?',
        default: false,
      },
      {
        type: 'confirm',
        name: 'confirm',
        message: 'Confirm and write files?',
        default: true,
      },
    ];

    const prompted = (await inquirer.prompt(questions)) as Omit<
      InitAnswers,
      'frontendPath' | 'backendPath'
    >;

    if (!prompted.confirm) {
      logInfo('Init cancelled.');
      process.exit(0);
    }

    answers = { ...prompted, agent: prompted.agent ?? 'opencode' };
  }

  let frontendPath: string | undefined;
  let backendPath: string | undefined;

  if (!options.yes) {
    if (!fs.existsSync(path.join(root, 'frontend'))) {
      console.log(chalk.yellow('\n./frontend not found.'));
      const { fp } = await inquirer.prompt([
        {
          type: 'input',
          name: 'fp',
          message: 'Frontend path:',
          default: './frontend',
        },
      ]);
      frontendPath = fp;
    }

    if (!fs.existsSync(path.join(root, 'backend'))) {
      console.log(chalk.yellow('\n./backend not found.'));
      const { bp } = await inquirer.prompt([
        {
          type: 'input',
          name: 'bp',
          message: 'Backend path:',
          default: './backend',
        },
      ]);
      backendPath = bp;
    }
  }

  answers = {
    ...answers,
    frontendPath,
    backendPath,
  };

  logBlank();
  const result = generateProject(root, answers);

  for (const f of result.created) {
    logOk(`created: ${f}`);
  }
  for (const f of result.skipped) {
    logWarn(`skipped (exists): ${f}`);
  }

  if (wantsOpenCode(answers.agent)) {
    logBlank();
    try {
      const packageRoot = findPackageRoot(path.resolve(__dirname, '../..'));
      const ocResult = registerOpenCode(root, packageRoot, { agent: answers.agent });

      if (ocResult.config.opencodejsonCreated) {
        logOk(`created: ${path.basename(ocResult.config.configPath)}`);
      } else if (ocResult.config.configPath && ocResult.config.pluginEntry) {
        logOk(
          `updated: ${path.basename(ocResult.config.configPath)} (plugin: ${ocResult.strategy})`
        );
      }

      if (ocResult.plugin?.created) {
        logOk(`created: ${ocResult.plugin.relPath}`);
      } else if (ocResult.plugin?.refreshed) {
        logOk(`refreshed: ${ocResult.plugin.relPath}`);
      } else if (ocResult.plugin?.skipped) {
        logInfo(`skipped existing: ${ocResult.plugin.relPath}`);
      } else if (ocResult.strategy === 'local-copy') {
        logInfo('OpenCode plugin strategy: local-copy (.opencode/plugins/aws.mjs)');
      }

      if (ocResult.assets) {
        for (const f of ocResult.assets.created) {
          logOk(`created: ${f}`);
        }
        for (const f of ocResult.assets.skipped) {
          logInfo(`skipped existing: ${f}`);
        }
        if (ocResult.assets.staleAssetWarning) {
          logWarn(formatStaleAssetWarning());
        }
      }

      logBlank();
      console.log(chalk.bold('OpenCode setup complete. Next steps:'));
      console.log('  1. Restart OpenCode');
      console.log('  2. Select primary agent: aws-conductor');
      console.log('  3. Ask: "Start AWS workflow for this repository"');
    } catch (err) {
      logError((err as Error).message);
      process.exit(1);
    }
  }

  logBlank();
  console.log(chalk.green.bold('AWS initialized successfully.'));
  console.log('Run ' + chalk.cyan('aws doctor') + ' to verify your environment.');
}

async function runRepair(root: string): Promise<void> {
  const configPath = path.join(root, '.aws/config.yaml');
  if (!fs.existsSync(configPath)) {
    logError('.aws/config.yaml not found.');
    console.log('Run ' + chalk.cyan('`aws init`') + ' first.');
    process.exit(1);
  }

  logInfo('Running repair...');
  logBlank();

  try {
    const result = repairProject(root, {});

    for (const f of result.created) {
      logOk(`created: ${f}`);
    }
    for (const f of result.skipped) {
      logInfo(`exists: ${f}`);
    }

    logBlank();
    console.log(chalk.green.bold('Repair complete.'));
  } catch (err) {
    logError((err as Error).message);
    process.exit(1);
  }
}
