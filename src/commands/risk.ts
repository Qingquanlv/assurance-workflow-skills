import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildRiskContext,
  serializeContext,
  writeContextToPath,
  writeRiskContext,
} from '../risk/context_builder';
import { loadCasesFromQa } from '../risk/case_loader';
import { advisoryJsonPath, contextJsonPath } from '../risk/paths';
import {
  RiskSafetyError,
  assertChangeIdSafe,
  assertInsideProject,
  resolveInsideProject,
} from '../risk/safety';
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
  const riskCmd = program.command('risk').description('Explore commands (Phase 0.5)');

  riskCmd
    .command('context')
    .description('Aggregate git diff, cases, and archive history into explore/context.json')
    .requiredOption('--change <change-id>', 'Change ID')
    .option('--project-dir <path>', 'Project root', process.cwd())
    .option('--diff-base <ref>', 'Git diff base ref', 'main')
    .option('--archive-depth <n>', 'Number of recent archives to sample', '10')
    .option('--requirement <path>', 'Requirement text file (must be inside project root)')
    .option('--staleness-days <n>', 'Archive staleness threshold in days', '30')
    .option('--stdout', 'Print context JSON to stdout and do NOT write to disk (pre-folder explore)')
    .option(
      '--output-dir <path>',
      'Write context.json into this directory (inside project root) instead of qa/changes/<id>/explore/',
    )
    .action((options) => {
      const toStdout: boolean = options.stdout === true;
      try {
        const changeId: string = options.change;
        const projectRoot = path.resolve(options.projectDir);
        assertChangeIdSafe(changeId);

        // In --stdout / --output-dir (explore-scratch) mode the change folder may
        // not exist yet, so we do NOT require qa/changes/<id>/ to be present.
        if (!toStdout && !options.outputDir) {
          resolveInsideProject(projectRoot, 'qa', 'changes', changeId);
        }

        if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
          throw new RiskSafetyError(`--project-dir is not a directory: ${projectRoot}`);
        }

        let outputDir: string | undefined;
        if (options.outputDir) {
          outputDir = path.resolve(projectRoot, options.outputDir);
          assertInsideProject(projectRoot, outputDir);
        }

        // Decorative logs go to stdout; suppress them in --stdout mode so the
        // only thing on stdout is the JSON document (pipeable).
        if (!toStdout) {
          logHeader(`aws risk context — change: ${changeId}`);
          logInfo(`Project root: ${projectRoot}`);
          logBlank();
        }

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
          const msg = `Context validation failed: ${shape.errors.join('; ')}`;
          if (toStdout) {
            process.stderr.write(msg + '\n');
          } else {
            logError(msg);
          }
          process.exit(1);
        }

        if (toStdout) {
          process.stdout.write(serializeContext(context));
          return;
        }

        const outPath = outputDir
          ? writeContextToPath(path.join(outputDir, 'context.json'), context)
          : writeRiskContext(projectRoot, changeId, context);
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
    .description('Validate explore/advisory.json against context.json (§5.5)')
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
