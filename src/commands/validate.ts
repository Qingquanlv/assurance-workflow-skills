import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import {
  resolveSpecs,
  validateArtifactFile,
} from '../schema';
import { findSchemaFile, loadSchemaFromFile } from '../orchestration/schema';
import { ArtifactValidationResult } from '../schema/types';
import { logError, logHeader, logOk, logBlank } from '../utils/logger';

/** Walk qa/changes/<id> and return change-relative paths of files matching any spec glob. */
function collectArtifactPaths(changeDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else {
        const rel = path.relative(changeDir, abs).replace(/\\/g, '/');
        if (resolveSpecs(rel).length > 0) out.push(rel);
      }
    }
  };
  walk(changeDir);
  return out.sort();
}

/** Whether a change-relative artifact path is covered by a phase `produces` entry. */
function artifactBelongsToProduce(rel: string, produce: string): boolean {
  const norm = rel.replace(/\\/g, '/');
  const prod = produce.replace(/\\/g, '/');
  if (resolveSpecs(prod).length > 0) return norm === prod;
  if (prod.endsWith('/')) return norm.startsWith(prod);
  return norm === prod;
}

export function registerValidateCommand(program: Command): void {
  program
    .command('validate')
    .description('Validate per-change YAML/JSON artifacts against their schemas (deterministic, no LLM)')
    .requiredOption('--change <change-id>', 'Change ID')
    .option('--phase <phase-id>', 'Only validate artifacts a phase produces')
    .option('--artifact <relpath>', 'Validate a single change-relative artifact path')
    .option('--json', 'Machine-readable JSON output')
    .action((options) => {
      const changeId: string = options.change;
      const projectRoot = process.cwd();
      const changeDir = path.join(projectRoot, 'qa', 'changes', changeId);
      if (!fs.existsSync(changeDir)) {
        logError(`change '${changeId}' not found (expected: ${changeDir}).`);
        process.exit(1);
        return;
      }

      let relPaths: string[];
      if (options.artifact) {
        relPaths = [String(options.artifact).replace(/\\/g, '/')];
      } else if (options.phase) {
        const schemaFile = findSchemaFile(projectRoot);
        const schema = loadSchemaFromFile(schemaFile);
        const phase = schema.phasesById.get(String(options.phase));
        if (!phase) {
          logError(`unknown phase '${options.phase}'`);
          process.exit(2);
          return;
        }
        relPaths = collectArtifactPaths(changeDir).filter((rel) =>
          phase.produces.some((produce) => artifactBelongsToProduce(rel, produce)),
        );
      } else {
        relPaths = collectArtifactPaths(changeDir);
      }

      const results: ArtifactValidationResult[] = [];
      for (const rel of relPaths) {
        const abs = path.join(changeDir, rel);
        if (!fs.existsSync(abs)) {
          results.push({ path: rel, artifact_type: resolveSpecs(rel)[0]?.artifact_type ?? 'unknown', ok: false, errors: ['file not found'] });
          continue;
        }
        results.push(...validateArtifactFile(abs, rel));
      }

      const ok = results.every((r) => r.ok);

      if (options.json) {
        console.log(JSON.stringify({ ok, results }, null, 2));
      } else {
        logHeader(`aws validate — ${changeId}`);
        logBlank();
        if (results.length === 0) {
          console.log('  (no recognized artifacts found)');
        }
        for (const r of results) {
          if (r.ok) logOk(`${r.path} [${r.artifact_type}]`);
          else {
            logError(`${r.path} [${r.artifact_type}]`);
            for (const e of r.errors) console.log('    ' + chalk.red('· ') + e);
          }
        }
        logBlank();
      }

      process.exit(ok ? 0 : 1);
    });
}
