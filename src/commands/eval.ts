// src/commands/eval.ts — aws eval command group

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { runSuite, runPlan } from '../eval/runner';
import { readGateResult } from '../eval/gate';
import { BatchGate, BatchReporter, readBatchManifest } from '../eval/batch';
import { generateRunReport, generateTrendReport, compareWithBaseline } from '../eval/report';
import { updateBaseline, readBaseline, getBaselineForSuite } from '../eval/baseline';
import { generatePlan, writePlan, loadSuite, readPlan } from '../eval/plan';
import { readMetrics } from '../eval/metrics';
import { evalBatchesDir, evalRunsDir } from '../eval/paths';

function getEvalRoot(projectRoot: string): string {
  return path.join(projectRoot, 'eval');
}

/** Gate command: non-pass verdicts block CI. Run command does NOT use this by default. */
function exitWithGateVerdict(verdict: string): void {
  const failing = ['fail', 'inconclusive', 'needs_human_review'];
  if (failing.includes(verdict)) {
    process.exit(1);
  }
  process.exit(0);
}

function printRunResult(opts: {
  output: string;
  json: boolean;
  id: string;
  verdict: string;
  kind: 'run' | 'batch';
}): void {
  const { output, json, id, verdict, kind } = opts;
  const idKey = kind === 'batch' ? 'batch_id' : 'run_id';

  if (output === 'id') {
    console.log(id);
    return;
  }

  if (json) {
    console.log(JSON.stringify({ [idKey]: id, verdict }));
    return;
  }

  console.log(chalk.bold(`${idKey}: ${id}`));
  console.log(`verdict: ${verdictColor(verdict)(verdict)}`);
}

export function registerEvalCommand(program: Command): void {
  const evalCmd = program
    .command('eval')
    .description('AI Eval Harness — evaluate AI tool quality');

  // ── aws eval run ────────────────────────────────────────────────────────────
  evalCmd
    .command('run')
    .description('Run an eval suite or batch plan')
    .option('--suite <name>', 'Suite name to run')
    .option('--plan <path>', 'Path to eval-plan.json')
    .option('--sample <id>', 'Run a single sample only')
    .option('--repeat <n>', 'Repeat runs (stability)', parseInt)
    .option('--output <mode>', 'Output mode: id (CI-friendly, prints only the id)')
    .option('--json', 'Output result as JSON { run_id|batch_id, verdict }')
    .option('--fail-on-verdict', 'Exit 1 when gate verdict is not pass (opt-in)')
    .option('--calibrate', 'Run judge calibration before finalizing gate result')
    .option('--extra-memory-dir <path>', 'Overlay .aws/memory files into evaluated SUT workspaces')
    .option('--sut-dir <path>', 'Override SUT checkout directory (overrides eval/suts.yaml and EVAL_SUT_DIR)')
    .action(async (opts) => {
      const projectRoot = process.cwd();
      const evalRoot = getEvalRoot(projectRoot);

      if (!opts.suite && !opts.plan) {
        console.error(chalk.red('Error: --suite <name> or --plan <path> required'));
        process.exit(1);
      }

      if (opts.suite && opts.plan) {
        console.error(chalk.red('Error: --suite and --plan are mutually exclusive'));
        process.exit(1);
      }

      try {
        if (opts.suite) {
          const suitesDir = path.join(evalRoot, 'suites');
          const { suite, filePath } = loadSuite(suitesDir, opts.suite);

          if (opts.output !== 'id' && !opts.json) {
            console.log(chalk.cyan(`Running suite: ${suite.name}`));
          }

          const { runId, gateResult } = await runSuite({
            suite,
            suiteFilePath: filePath,
            evalRoot,
            projectRoot,
            sampleId: opts.sample,
            repeat: opts.repeat,
            calibrate: opts.calibrate,
            extraMemoryDir: opts.extraMemoryDir
              ? path.resolve(projectRoot, opts.extraMemoryDir)
              : undefined,
            sutDirOverride: opts.sutDir ? path.resolve(opts.sutDir) : undefined,
          });

          printRunResult({
            output: opts.output,
            json: opts.json,
            id: runId,
            verdict: gateResult.verdict,
            kind: 'run',
          });

          if (opts.failOnVerdict) {
            exitWithGateVerdict(gateResult.verdict);
          }
          process.exit(0);
        } else {
          if (opts.output !== 'id' && !opts.json) {
            console.log(chalk.cyan(`Running plan: ${opts.plan}`));
          }
          const { batchId, gateResult } = await runPlan({
            planPath: opts.plan,
            projectRoot,
            evalRoot,
          });

          printRunResult({
            output: opts.output,
            json: opts.json,
            id: batchId,
            verdict: gateResult.verdict,
            kind: 'batch',
          });

          if (opts.failOnVerdict) {
            exitWithGateVerdict(gateResult.verdict);
          }
          process.exit(0);
        }
      } catch (err) {
        console.error(chalk.red(`eval run failed: ${(err as Error).message}`));
        if (process.env.AWS_DEBUG) console.error((err as Error).stack);
        process.exit(1);
      }
    });

  // ── aws eval gate ───────────────────────────────────────────────────────────
  evalCmd
    .command('gate')
    .description('Read gate result (does NOT recompute)')
    .option('--run <run-id>', 'Run ID')
    .option('--batch <batch-id>', 'Batch ID')
    .action((opts) => {
      const projectRoot = process.cwd();
      const evalRoot = getEvalRoot(projectRoot);

      if (!opts.run && !opts.batch) {
        console.error(chalk.red('Error: --run <id> or --batch <id> required'));
        process.exit(1);
      }

      try {
        if (opts.run) {
          const runDir = path.join(evalRunsDir(evalRoot), opts.run);
          const gateResult = readGateResult(runDir);
          console.log(`suite:   ${gateResult.suite}`);
          console.log(`verdict: ${verdictColor(gateResult.verdict)(gateResult.verdict)}`);
          if (gateResult.hard_gate_failures.length > 0) {
            console.log(`hard_gate_failures: ${gateResult.hard_gate_failures.join(', ')}`);
          }
          exitWithGateVerdict(gateResult.verdict);
        } else {
          const batchDir = path.join(evalBatchesDir(evalRoot), opts.batch);
          const gateResult = BatchGate.read(batchDir);
          console.log(`batch:   ${gateResult.batch_id}`);
          console.log(`verdict: ${verdictColor(gateResult.verdict)(gateResult.verdict)}`);
          for (const [suite, entry] of Object.entries(gateResult.suite_results)) {
            const prefix = entry.required ? '' : ' (optional)';
            console.log(`  ${suite}${prefix}: ${verdictColor(entry.verdict)(entry.verdict)}`);
          }
          exitWithGateVerdict(gateResult.verdict);
        }
      } catch (err) {
        console.error(chalk.red(`eval gate failed: ${(err as Error).message}`));
        process.exit(1);
      }
    });

  // ── aws eval report ─────────────────────────────────────────────────────────
  evalCmd
    .command('report')
    .description('Generate or display run report')
    .option('--run <run-id>', 'Run ID to report on')
    .option('--trend', 'Show trend across all runs')
    .option('--suite <name>', 'Filter trend by suite name')
    .option('--from <iso>', 'Trend filter: runs started on or after this ISO datetime')
    .option('--to <iso>', 'Trend filter: runs started on or before this ISO datetime')
    .option('--html', 'Write HTML report (run: report.html; trend: eval/out/reports/trend-<suite>.html)')
    .option('--output <path>', 'Override HTML output path')
    .option('--json', 'Output structured JSON instead of markdown/text')
    .action((opts) => {
      const projectRoot = process.cwd();
      const evalRoot = getEvalRoot(projectRoot);

      try {
        if (opts.trend) {
          const runsDir = evalRunsDir(evalRoot);
          const { entries, htmlPath } = generateTrendReport(runsDir, {
            suite: opts.suite,
            from: opts.from,
            to: opts.to,
            html: opts.html,
            htmlPath: opts.output,
            evalRoot,
          });

          if (opts.json) {
            console.log(JSON.stringify({ entries, html_path: htmlPath ?? null }, null, 2));
          } else {
            console.log(JSON.stringify(entries, null, 2));
          }

          if (htmlPath) {
            console.error(chalk.green(`HTML report: ${htmlPath}`));
          }
        } else if (opts.run) {
          const runDir = path.join(evalRunsDir(evalRoot), opts.run);
          const { markdown, data, htmlPath } = generateRunReport(runDir, {
            html: opts.html,
            htmlPath: opts.output,
          });

          if (opts.json) {
            console.log(JSON.stringify({ ...data, html_path: htmlPath ?? null }, null, 2));
          } else {
            console.log(markdown);
          }

          if (htmlPath) {
            console.error(chalk.green(`HTML report: ${htmlPath}`));
          }
        } else {
          console.error(chalk.red('Error: --run <id> or --trend required'));
          process.exit(1);
        }
      } catch (err) {
        console.error(chalk.red(`eval report failed: ${(err as Error).message}`));
        process.exit(1);
      }
    });

  // ── aws eval compare ────────────────────────────────────────────────────────
  evalCmd
    .command('compare')
    .description('Compare run or batch against baseline')
    .requiredOption('--baseline <name>', 'Baseline name (currently only "main" supported)')
    .option('--run <run-id>', 'Run ID')
    .option('--batch <batch-id>', 'Batch ID')
    .action((opts) => {
      const projectRoot = process.cwd();
      const evalRoot = getEvalRoot(projectRoot);
      const baselinePath = path.join(evalRoot, 'baselines', `${opts.baseline}.json`);

      if (!opts.run && !opts.batch) {
        console.error(chalk.red('Error: --run <id> or --batch <id> required'));
        process.exit(1);
      }

      try {
        const baseline = readBaseline(baselinePath);

        if (opts.run) {
          const runDir = path.join(evalRunsDir(evalRoot), opts.run);
          const manifest = JSON.parse(
            fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf-8')
          );
          const suiteName = manifest.suite;
          const baselineEntry = baseline[suiteName];

          if (!baselineEntry) {
            console.log(chalk.yellow(`No baseline found for suite: ${suiteName}`));
            process.exit(0);
          }

          const delta = compareWithBaseline(runDir, baselineEntry.metrics);
          console.log(`Comparing ${opts.run} vs baseline (${baselineEntry.run_id})`);
          for (const [k, v] of Object.entries(delta)) {
            const arrow = v >= 0 ? chalk.green(`+${v.toFixed(4)}`) : chalk.red(v.toFixed(4));
            console.log(`  ${k}: ${arrow}`);
          }
        } else {
          // Batch compare: iterate suite runs
          const batchDir = path.join(evalBatchesDir(evalRoot), opts.batch);
          const batchManifest = readBatchManifest(batchDir);

          for (const [suiteName, runId] of Object.entries(batchManifest.suite_runs)) {
            const runDir = path.join(evalRunsDir(evalRoot), runId);
            const baselineEntry = baseline[suiteName];
            if (!baselineEntry) {
              console.log(chalk.yellow(`  ${suiteName}: no baseline`));
              continue;
            }
            const delta = compareWithBaseline(runDir, baselineEntry.metrics);
            console.log(`\n${suiteName} (${runId} vs ${baselineEntry.run_id}):`);
            for (const [k, v] of Object.entries(delta)) {
              const arrow = v >= 0 ? chalk.green(`+${v.toFixed(4)}`) : chalk.red(v.toFixed(4));
              console.log(`  ${k}: ${arrow}`);
            }
          }
        }
      } catch (err) {
        console.error(chalk.red(`eval compare failed: ${(err as Error).message}`));
        process.exit(1);
      }
    });

  // ── aws eval baseline update ────────────────────────────────────────────────
  const baselineCmd = evalCmd
    .command('baseline')
    .description('Manage eval baselines');

  baselineCmd
    .command('update')
    .description('Update baseline for a suite (requires human confirmation)')
    .requiredOption('--suite <name>', 'Suite name')
    .requiredOption('--run <run-id>', 'Run ID to use as new baseline')
    .option('--approved-by <initials>', 'Approver initials', 'unknown')
    .action(async (opts) => {
      const projectRoot = process.cwd();
      const evalRoot = getEvalRoot(projectRoot);
      const baselinePath = path.join(evalRoot, 'baselines', 'main.json');
      const runDir = path.join(evalRunsDir(evalRoot), opts.run);

      try {
        await updateBaseline({
          baselinePath,
          suiteName: opts.suite,
          runDir,
          approvedBy: opts.approvedBy,
          interactive: true,
        });
      } catch (err) {
        console.error(chalk.red(`eval baseline update failed: ${(err as Error).message}`));
        process.exit(1);
      }
    });

  // ── aws eval plan ───────────────────────────────────────────────────────────
  evalCmd
    .command('plan')
    .description('Generate eval plan from CI event')
    .requiredOption('--event <event>', 'CI event: pull_request | nightly | manual')
    .option('--changed-files <path>', 'Path to file containing changed file paths (pull_request)')
    .option('--suite <name>', 'Suite name (manual event)')
    .option('--out <path>', 'Output path for eval-plan.json', 'eval-plan.json')
    .action((opts) => {
      const projectRoot = process.cwd();
      const evalRoot = getEvalRoot(projectRoot);
      const suitesDir = path.join(evalRoot, 'suites');

      const event = opts.event as 'pull_request' | 'nightly' | 'manual';

      if (event === 'pull_request' && !opts.changedFiles) {
        console.error(chalk.red('Error: --changed-files is required for pull_request event'));
        process.exit(1);
      }

      let changedFiles: string[] = [];
      if (opts.changedFiles) {
        if (!fs.existsSync(opts.changedFiles)) {
          console.error(chalk.red(`Error: changed-files not found: ${opts.changedFiles}`));
          process.exit(1);
        }
        changedFiles = fs
          .readFileSync(opts.changedFiles, 'utf-8')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
      }

      try {
        const plan = generatePlan({
          event,
          suitesDir,
          changedFiles,
          suiteName: opts.suite,
        });

        writePlan(plan, opts.out);

        console.log(chalk.green(`✅ Plan written to: ${opts.out}`));
        console.log(`event: ${plan.event}`);
        console.log(`suites: ${plan.suites.map((s) => s.name).join(', ') || '(none)'}`);
      } catch (err) {
        console.error(chalk.red(`eval plan failed: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}

function verdictColor(verdict: string): (s: string) => string {
  switch (verdict) {
    case 'pass': return chalk.green;
    case 'pass_with_warnings': return chalk.yellow;
    case 'fail': return chalk.red;
    case 'inconclusive': return chalk.magenta;
    case 'needs_human_review': return chalk.blue;
    default: return chalk.white;
  }
}
