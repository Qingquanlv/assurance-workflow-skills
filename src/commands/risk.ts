import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { buildRiskContext, writeRiskContext } from '../risk/context_builder';
import { loadCasesFromQa } from '../risk/case_loader';
import { advisoryJsonPath, contextJsonPath } from '../risk/paths';
import { RiskSafetyError, assertChangeIdSafe, resolveInsideProject } from '../risk/safety';
import { validateAdvisory, validateContextShape } from '../risk/validate_advisory';
import { RiskContext } from '../risk/types';
import { logBlank, logError, logHeader, logInfo, logOk } from '../utils/logger';

function parsePositiveInt(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new RiskSafetyError(`${flag} must be a positive integer, got: ${value}`);
  }
  return n;
}

export function registerRiskCommand(program: Command): void {
  const riskCmd = program.command('risk').description('Risk Advisory commands (Phase 0.5)');

  riskCmd
    .command('context')
    .description('Aggregate git diff, cases, and archive history into risk-advisory/context.json')
    .requiredOption('--change <change-id>', 'Change ID')
    .option('--project-dir <path>', 'Project root', process.cwd())
    .option('--diff-base <ref>', 'Git diff base ref', 'main')
    .option('--archive-depth <n>', 'Number of recent archives to sample', '10')
    .option('--requirement <path>', 'Requirement text file (must be inside project root)')
    .option('--staleness-days <n>', 'Archive staleness threshold in days', '30')
    .action((options) => {
      try {
        const changeId: string = options.change;
        const projectRoot = path.resolve(options.projectDir);
        assertChangeIdSafe(changeId);
        resolveInsideProject(projectRoot, 'qa', 'changes', changeId);

        if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
          throw new RiskSafetyError(`--project-dir is not a directory: ${projectRoot}`);
        }

        logHeader(`aws risk context — change: ${changeId}`);
        logInfo(`Project root: ${projectRoot}`);
        logBlank();

        const archiveDepth = parsePositiveInt(options.archiveDepth, '--archive-depth');
        const stalenessDays = parsePositiveInt(options.stalenessDays, '--staleness-days');

        const context = buildRiskContext({
          changeId,
          projectRoot,
          diffBase: options.diffBase,
          archiveDepth,
          stalenessDays,
          requirementPath: options.requirement,
        });

        const shape = validateContextShape(context);
        if (!shape.valid) {
          logError(`Context validation failed: ${shape.errors.join('; ')}`);
          process.exit(1);
        }

        const outPath = writeRiskContext(projectRoot, changeId, context);
        logOk(`Wrote ${path.relative(projectRoot, outPath)}`);
        logInfo(`Evidence entries: ${context.evidence.length}`);
        logInfo(`Degraded: ${context.degraded}${context.degraded ? ` (${context.degraded_reasons.join(', ')})` : ''}`);
        logBlank();
      } catch (err) {
        if (err instanceof RiskSafetyError) {
          logError(err.message);
          process.exit(1);
        }
        throw err;
      }
    });

  riskCmd
    .command('validate-advisory')
    .description('Validate risk-advisory/advisory.json against context.json (§5.5)')
    .requiredOption('--change <change-id>', 'Change ID')
    .option('--project-dir <path>', 'Project root', process.cwd())
    .action((options) => {
      try {
        const changeId: string = options.change;
        const projectRoot = path.resolve(options.projectDir);
        assertChangeIdSafe(changeId);

        const ctxPath = contextJsonPath(projectRoot, changeId);
        const advPath = advisoryJsonPath(projectRoot, changeId);
        if (!fs.existsSync(ctxPath)) {
          logError(`Missing ${ctxPath}`);
          process.exit(1);
        }
        if (!fs.existsSync(advPath)) {
          logError(`Missing ${advPath}`);
          process.exit(1);
        }

        const context = JSON.parse(fs.readFileSync(ctxPath, 'utf-8')) as RiskContext;
        const advisory = JSON.parse(fs.readFileSync(advPath, 'utf-8')) as Record<string, unknown>;
        const knownCases = loadCasesFromQa(projectRoot).map((c) => c.case_id);
        const result = validateAdvisory(context, advisory, knownCases);

        if (result.valid) {
          logOk('advisory.json validation passed');
          process.exit(0);
        }
        logError('advisory.json validation failed:');
        for (const e of result.errors) console.log(chalk.red(`  - ${e}`));
        process.exit(1);
      } catch (err) {
        if (err instanceof RiskSafetyError) {
          logError(err.message);
          process.exit(1);
        }
        throw err;
      }
    });
}
