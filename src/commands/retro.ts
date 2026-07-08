import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { buildRetroContext } from '../retro/aggregator';
import type { RetroContext } from '../retro/types';

function countSignals(context: RetroContext): number {
  return (
    context.signals.failure_distribution.length +
    context.signals.gate_pushback.length +
    (context.signals.healing_efficiency.proposal_created > 0 ||
    context.signals.healing_efficiency.created_proposals > 0 ? 1 : 0) +
    context.signals.human_overrides.length +
    context.signals.reclassifications.length +
    context.signals.skill_execution.length +
    context.signals.eval_trend.length
  );
}

function defaultOutPath(projectRoot: string, retroId: string): string {
  return path.join(projectRoot, 'qa', 'retro', retroId, 'context.json');
}

export function registerRetroCommand(program: Command): void {
  program
    .command('retro')
    .description('Aggregate archived QA evidence into retro context')
    .option('--since <iso>', 'Scan archived changes archived at or after this ISO date')
    .option('--change <id>', 'Archived change id to include (repeatable)', collectChange, [])
    .option('--out <path>', 'Output path for context.json')
    .option('--json', 'Output { retro_id, change_count, signal_count }')
    .action((opts) => {
      const projectRoot = process.cwd();
      const changes = opts.change as string[];
      if (opts.since && changes.length > 0) {
        console.error(chalk.red('Error: --since and --change are mutually exclusive'));
        process.exit(1);
      }

      const context = buildRetroContext(projectRoot, {
        since: opts.since,
        changes: changes.length ? changes : undefined,
      });
      const outPath = opts.out
        ? path.resolve(projectRoot, opts.out)
        : defaultOutPath(projectRoot, context.retro_id);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(context, null, 2));

      const summary = {
        retro_id: context.retro_id,
        change_count: context.window.change_count,
        signal_count: countSignals(context),
      };
      if (opts.json) {
        console.log(JSON.stringify(summary));
        return;
      }
      console.log(chalk.bold(`retro_id: ${summary.retro_id}`));
      console.log(`change_count: ${summary.change_count}`);
      console.log(`signal_count: ${summary.signal_count}`);
      console.log(`context: ${path.relative(projectRoot, outPath)}`);
    });
}

function collectChange(value: string, previous: string[]): string[] {
  return [...previous, value];
}
