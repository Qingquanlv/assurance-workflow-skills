import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import {
  findSchemaFile,
  loadSchemaFromFile,
  validateSchema,
} from '../orchestration/schema';
import { createWorkflowProgression } from '../orchestration/progression';
import { logError, logHeader, logBlank } from '../utils/logger';

/** Exit codes per orchestration-cli-contract.md. */
const VERDICT_EXIT: Record<string, number> = {
  pass: 0,
  enter: 0,
  exit: 0,
  needs_fix: 30,
  needs_human_review: 31,
  continue: 32,
  reject: 40,
  stop: 40,
  skip: 0,
};

const VERDICT_COLOR: Record<string, (s: string) => string> = {
  pass: chalk.green,
  enter: chalk.green,
  exit: chalk.green,
  needs_fix: chalk.yellow,
  needs_human_review: chalk.yellow,
  continue: chalk.cyan,
  reject: chalk.red,
  stop: chalk.red,
};

export function registerGateCommand(program: Command): void {
  const gateCmd = program.command('gate').description('Gate adjudication commands');

  gateCmd
    .command('check')
    .description('Adjudicate a single phase gate to one verdict (deterministic, no LLM)')
    .requiredOption('--change <change-id>', 'Change ID')
    .requiredOption('--phase <phase-id>', 'Phase whose gate to check')
    .option('--json', 'Machine-readable JSON output')
    .option('--schema-file <path>', 'Override workflow schema file')
    .action((options) => {
      const changeId: string = options.change;
      const phaseId: string = options.phase;
      const projectRoot = process.cwd();
      const changeDir = path.join(projectRoot, 'qa', 'changes', changeId);
      if (!fs.existsSync(changeDir)) {
        logError(`change '${changeId}' not found (expected: ${changeDir}). Check the change id, or run from the project root.`);
        process.exit(1);
        return;
      }

      let report;
      try {
        const schemaFile = findSchemaFile(projectRoot, options.schemaFile);
        const schema = loadSchemaFromFile(schemaFile);
        const validation = validateSchema(schema);
        if (!validation.ok) {
          logError('Schema validation failed:');
          for (const e of validation.errors) console.error('  - ' + e);
          process.exit(1);
        }
        const progression = createWorkflowProgression({ schema, projectRoot, changeId });
        report = progression.adjudicatePhaseGate(phaseId);
      } catch (err) {
        logError(`gate check failed: ${(err as Error).message}`);
        if (process.env.AWS_DEBUG) console.error((err as Error).stack);
        process.exit(1);
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        const color = VERDICT_COLOR[report.verdict] ?? chalk.white;
        logHeader(`aws gate check — ${report.phase} → ${report.gate}`);
        logBlank();
        console.log(`  Verdict       : ${color(report.verdict)}`);
        if (report.matched_rule) console.log(`  Matched rule  : ${report.matched_rule}`);
        if (report.recommended_phase) console.log(`  Next phase    : ${report.recommended_phase}`);
        console.log(`  Reads         : ${report.reads.join(', ') || '(none)'}`);
        if (Object.keys(report.evidence).length) {
          console.log(`  Evidence      : ${JSON.stringify(report.evidence)}`);
        }
        logBlank();
      }

      process.exit(VERDICT_EXIT[report.verdict] ?? 1);
    });
}
