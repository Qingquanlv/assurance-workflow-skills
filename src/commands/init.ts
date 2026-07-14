import * as path from 'path';
import * as fs from 'fs';
import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { InitAnswers } from '../workflow/core/types';
import { generateProject, repairProject, registerOpenCode } from '../workflow/core/generator';
import { copyOpencodeAssets, syncOpencodeAssets } from '../workflow/core/agents_assets';
import { logOk, logWarn, logError, logInfo, logBlank } from '../utils/logger';

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize AWS project in current directory')
    .option('--repair', 'Repair mode: only create missing files, never overwrite')
    .action(async (options) => {
      const root = process.cwd();

      if (options.repair) {
        await runRepair(root);
      } else {
        await runInit(root);
      }
    });
}

async function runInit(root: string): Promise<void> {
  const defaultFrontend = './frontend';
  const defaultBackend = './backend';

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

  const questions: inquirer.QuestionCollection = [
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

  // OpenCode registration
  logBlank();
  const packageRoot = path.resolve(__dirname, '../../');
  const ocResult = registerOpenCode(root, packageRoot);

  if (ocResult.opencodejsonCreated) {
    logOk('created: opencode.json');
  } else {
    logOk('updated: opencode.json (plugin entry added)');
  }

  const assets = copyOpencodeAssets(root, packageRoot);
  for (const f of assets.agents.created) logOk(`created: ${f}`);
  for (const f of assets.agents.skipped) logWarn(`skipped (exists): ${f}`);
  for (const f of assets.tools.created) logOk(`created: ${f}`);
  for (const f of assets.tools.skipped) logWarn(`skipped (exists): ${f}`);

  logBlank();
  console.log(chalk.green.bold('AWS initialized successfully.'));
  console.log('Run ' + chalk.cyan('aws doctor') + ' to verify your environment.');

  logBlank();
  console.log(chalk.bold('OpenCode setup complete. Next steps:'));
  console.log('  1. Restart OpenCode');
  console.log('  2. Start intake: ' + chalk.cyan('use agent aws-intake-host') + ' / skill aws-intake');
  console.log('  3. Or full driver: ' + chalk.cyan('aws workflow run --change <id> --scope full'));
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

    const packageRoot = path.resolve(__dirname, '../../');
    const assets = syncOpencodeAssets(root, packageRoot);
    for (const f of [...assets.agents.created, ...assets.tools.created]) logOk(`created: ${f}`);
    for (const f of [...assets.agents.updated, ...assets.tools.updated]) logOk(`updated: ${f}`);
    for (const f of [...assets.agents.unchanged, ...assets.tools.unchanged]) logInfo(`unchanged: ${f}`);

    logBlank();
    console.log(chalk.green.bold('Repair complete.'));
    if (assets.agents.updated.length > 0 || assets.tools.updated.length > 0) {
      logWarn('OpenCode assets updated — restart OpenCode to pick up agents/tools.');
    }
  } catch (err) {
    logError((err as Error).message);
    process.exit(1);
  }
}
