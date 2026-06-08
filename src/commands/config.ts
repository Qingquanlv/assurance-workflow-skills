import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import chalk from 'chalk';
import { logError } from '../utils/logger';

export function registerConfigCommand(program: Command): void {
  const configCmd = program
    .command('config')
    .description('Manage AWS configuration');

  configCmd
    .command('print')
    .description('Print current .aws/config.yaml')
    .action(() => {
      const root = process.cwd();
      const configPath = path.join(root, '.aws/config.yaml');

      if (!fs.existsSync(configPath)) {
        logError('.aws/config.yaml not found.');
        console.log('Run ' + chalk.cyan('`aws init`') + ' first.');
        process.exit(1);
      }

      const content = fs.readFileSync(configPath, 'utf-8');
      process.stdout.write(content);
    });
}
