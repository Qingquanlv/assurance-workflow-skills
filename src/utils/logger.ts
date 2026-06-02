import chalk from 'chalk';

export function logOk(message: string): void {
  console.log(chalk.green('✓') + ' ' + message);
}

export function logWarn(message: string): void {
  console.log(chalk.yellow('!') + ' ' + message);
}

export function logError(message: string): void {
  console.log(chalk.red('✗') + ' ' + message);
}

export function logInfo(message: string): void {
  console.log(chalk.cyan('→') + ' ' + message);
}

export function logHeader(title: string): void {
  console.log('\n' + chalk.bold(title));
}

export function logSection(title: string): void {
  console.log('\n' + chalk.bold.underline(title));
}

export function logBlank(): void {
  console.log('');
}
