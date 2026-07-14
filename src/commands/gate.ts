import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import {
  findSchemaFile,
  loadSchemaFromFile,
  validateSchema,
} from '../workflow/orchestration/schema';
import { inspectNamedGate } from '../workflow/orchestration/progression';
import { exitCodeForGateVerdict } from '../workflow/core/exit_codes';
import { logError, logHeader, logBlank } from '../utils/logger';

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
        const progressionOptions = { schema, projectRoot, changeId };
        const phase = schema.phasesById.get(phaseId);
        if (!phase) {
          throw new Error(`Unknown phase '${phaseId}'`);
        }
        if (!phase.gate) {
          throw new Error(`Phase '${phaseId}' has no gate`);
        }
        report = inspectNamedGate(progressionOptions, phase.gate);
        if (report.verdict === 'needs_fix') {
          const recommended = schema.phases.find(p => p.repair_of === phaseId)?.id ?? null;
          report = { ...report, phase: phaseId, recommended_phase: recommended };
        } else {
          report = { ...report, phase: phaseId };
        }
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

      process.exit(exitCodeForGateVerdict(report.verdict));
    });
}
