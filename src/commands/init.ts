import * as path from 'path';
import * as fs from 'fs';
import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { InitAnswers } from '../core/types';
import { generateProject, repairProject } from '../core/generator';
import { logOk, logWarn, logError, logInfo, logBlank } from '../utils/logger';

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize AWE project in current directory')
    .option('--repair', 'Repair mode: only create missing files, never overwrite')
    .option('--claude', 'Generate Claude Code skill (repair mode only)')
    .option('--codex', 'Generate Codex AGENTS.md (repair mode only)')
    .action(async (options) => {
      const root = process.cwd();

      if (options.repair) {
        await runRepair(root, options);
      } else {
        await runInit(root);
      }
    });
}

async function runInit(root: string): Promise<void> {
  const defaultFrontend = './frontend';
  const defaultBackend = './backend';

  console.log(chalk.bold('\nWelcome to AWE.\n'));
  console.log('AWE will initialize this project with:');
  console.log(`  - project root: .`);
  console.log(`  - frontend source: ${defaultFrontend}`);
  console.log(`  - backend source: ${defaultBackend}`);
  console.log(`  - QA cases: ./qa/cases`);
  console.log(`  - QA changes: ./qa/changes`);
  console.log(`  - test output: ./tests`);
  console.log(`  - PRD input mode: prompt`);
  console.log(`  - API + E2E workflow enabled by default`);
  logBlank();

  const questions: inquirer.QuestionCollection = [
    {
      type: 'list',
      name: 'agent',
      message: 'Agent workflow:',
      choices: [
        { name: 'Claude Code', value: 'claude_code' },
        { name: 'Codex', value: 'codex' },
        { name: 'Both', value: 'both' },
        { name: 'None', value: 'none' },
      ],
      default: 'claude_code',
    },
    {
      type: 'list',
      name: 'apiFramework',
      message: 'API test framework:',
      choices: [
        { name: 'pytest', value: 'pytest' },
        { name: 'go test', value: 'go test' },
        { name: 'jest', value: 'jest' },
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

  const answers = await inquirer.prompt(questions) as Omit<InitAnswers, 'frontendPath' | 'backendPath'>;

  if (!answers.confirm) {
    logInfo('Init cancelled.');
    process.exit(0);
  }

  // Ask about missing paths
  let frontendPath: string | undefined;
  let backendPath: string | undefined;

  if (!fs.existsSync(path.join(root, 'frontend'))) {
    console.log(chalk.yellow('\n./frontend not found.'));
    const { fp } = await inquirer.prompt([{
      type: 'input',
      name: 'fp',
      message: 'Frontend path:',
      default: './frontend',
    }]);
    frontendPath = fp;
  }

  if (!fs.existsSync(path.join(root, 'backend'))) {
    console.log(chalk.yellow('\n./backend not found.'));
    const { bp } = await inquirer.prompt([{
      type: 'input',
      name: 'bp',
      message: 'Backend path:',
      default: './backend',
    }]);
    backendPath = bp;
  }

  const fullAnswers: InitAnswers = {
    ...answers,
    frontendPath,
    backendPath,
  };

  logBlank();
  const result = generateProject(root, fullAnswers);

  for (const f of result.created) {
    logOk(`created: ${f}`);
  }
  for (const f of result.skipped) {
    logWarn(`skipped (exists): ${f}`);
  }

  logBlank();
  console.log(chalk.green.bold('AWE initialized successfully.'));
  console.log('Run ' + chalk.cyan('awe doctor') + ' to verify your environment.');
}

async function runRepair(root: string, options: { claude?: boolean; codex?: boolean }): Promise<void> {
  const configPath = path.join(root, '.awe/config.yaml');
  if (!fs.existsSync(configPath)) {
    logError('.awe/config.yaml not found.');
    console.log('Run ' + chalk.cyan('`awe init`') + ' first.');
    process.exit(1);
  }

  logInfo('Running repair...');
  logBlank();

  try {
    const result = repairProject(root, {
      claude: options.claude,
      codex: options.codex,
    });

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
