import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { resolveSelectedTargets, run, RunnerResult } from '../execution/runner';
import { appendEvents } from '../core/events';
import {
  assertHealingRunAllowed,
  assertProductTreeUnchangedInHealing,
  assertRerunReasonIfNeeded,
  assertTestTreeUnchangedOrHealing,
  loadProductCodeRoots,
} from '../core/healing_state';
import { writeTestChangesOverrideEvidence } from '../core/override_evidence';
import { logInfo, logOk, logError, logBlank, logHeader } from '../utils/logger';

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Execute API and E2E tests for a change and write normalized execution results')
    .requiredOption('--change <change-id>', 'Change ID (e.g. REQ-002-user-logout)')
    .option('--rerun-reason <text>', 'Required when re-running after execution is already done')
    .option('--allow-test-changes', 'Allow test tree changes outside healing after explicit human decision')
    .option('--reason <text>', 'Human decision reason for --allow-test-changes')
    .action((options) => {
      const changeId: string = options.change;
      const rerunReason: string | undefined = options.rerunReason;
      const allowTestChanges: boolean = options.allowTestChanges === true;
      const overrideReason: string | undefined = options.reason;
      const projectRoot = process.cwd();

      logHeader(`aws run — change: ${changeId}`);
      logBlank();
      logInfo(`Project root: ${projectRoot}`);
      logInfo(`Change: ${changeId}`);
      logBlank();

      try {
        if (allowTestChanges && !overrideReason?.trim()) {
          throw new Error('ALLOW-TEST-CHANGES-REASON-REQUIRED: --allow-test-changes requires --reason "<user decision>"');
        }
        const overridePolicy = loadTestChangesOverridePolicy(projectRoot);
        if (allowTestChanges && overridePolicy === 'forbidden') {
          throw new Error('ALLOW-TEST-CHANGES-FORBIDDEN: execution policy forbids --allow-test-changes');
        }
        assertHealingRunAllowed(projectRoot, changeId);
        assertRerunReasonIfNeeded(projectRoot, changeId, rerunReason);
        const integrity = assertTestTreeUnchangedOrHealing(projectRoot, changeId, allowTestChanges);
        const productIntegrity = assertProductTreeUnchangedInHealing(projectRoot, changeId, loadProductCodeRoots(projectRoot));

        const selectedTargets = resolveSelectedTargets(projectRoot, changeId);
        const startedAt = Date.now();
        if (productIntegrity.productChanged && productIntegrity.previousSha256) {
          appendEvents(projectRoot, changeId, [{
            source: 'run',
            type: 'product_tree_changed',
            prev_sha256: productIntegrity.previousSha256,
            new_sha256: productIntegrity.current.aggregate,
            ...(productIntegrity.previousBatchId ? { baseline_batch_id: productIntegrity.previousBatchId } : {}),
          }]);
        }
        appendEvents(projectRoot, changeId, [{
          source: 'run',
          type: 'execution_start',
          targets: { ...selectedTargets },
          ...(rerunReason ? { rerun_reason: rerunReason } : {}),
          tests_changed: integrity.testsChanged,
        }]);

        const result = run({ changeId, projectRoot, selectedTargets });
        if (allowTestChanges && integrity.testsChanged) {
          const evidence = overridePolicy === 'free'
            ? null
            : writeTestChangesOverrideEvidence({
                projectRoot,
                changeId,
                batchId: result.batchId,
                batchDir: result.batchDir,
                reason: overrideReason!.trim(),
                integrity,
              });
          appendEvents(projectRoot, changeId, [{
            source: 'run',
            type: 'human_override',
            phase: 'execution',
            action: 'allow_test_changes',
            reason: overrideReason!.trim(),
            review_sha256: integrity.current.aggregate,
            ...(evidence ? {
              evidence_file: evidence.relPath,
              evidence_sha256: evidence.sha256,
              changed_files_count: evidence.changedFilesCount,
            } : {}),
          }]);
        }
        appendEvents(projectRoot, changeId, [{
          source: 'run',
          type: 'execution_end',
          duration_ms: Date.now() - startedAt,
          per_target: toPerTarget(result),
        }]);

        logBlank();
        logHeader('Execution Results');
        logBlank();

        const apiStatus = result.api?.status ?? 'unselected';
        const e2eStatus = result.e2e?.status ?? 'unselected';
        const apiColor = apiStatus === 'passed' ? chalk.green : apiStatus === 'failed' ? chalk.red : chalk.yellow;
        const e2eColor = e2eStatus === 'passed' ? chalk.green : e2eStatus === 'failed' ? chalk.red : chalk.yellow;

        console.log(`  API  : ${apiColor(apiStatus.padEnd(10))}  total=${result.api?.total ?? 0}  passed=${result.api?.passed ?? 0}  failed=${result.api?.failed ?? 0}  skipped=${result.api?.skipped ?? 0}`);
        console.log(`  E2E  : ${e2eColor(e2eStatus.padEnd(10))}  total=${result.e2e?.total ?? 0}  passed=${result.e2e?.passed ?? 0}  failed=${result.e2e?.failed ?? 0}  skipped=${result.e2e?.skipped ?? 0}`);
        if (result.fuzz) {
          const fuzzColor = result.fuzz.status === 'passed' ? chalk.green : result.fuzz.status === 'failed' ? chalk.red : chalk.yellow;
          console.log(`  FUZZ : ${fuzzColor(result.fuzz.status.padEnd(10))}  total=${result.fuzz.total}  passed=${result.fuzz.passed}  failed=${result.fuzz.failed}  skipped=${result.fuzz.skipped}`);
        } else {
          console.log(`  FUZZ : ${chalk.gray('unselected '.padEnd(10))}  total=0  passed=0  failed=0  skipped=0`);
        }
        if (result.performance) {
          const perfColor = result.performance.status === 'PASS' ? chalk.green : result.performance.status === 'FAIL' ? chalk.red : chalk.yellow;
          console.log(`  PERF : ${perfColor(result.performance.status.padEnd(10))}  scenarios=${result.performance.scenarios.length}`);
        } else {
          console.log(`  PERF : ${chalk.gray('unselected '.padEnd(10))}  scenarios=0`);
        }

        const cov = result.coverage;
        if (cov?.available) {
          const covColor = cov.status === 'PASS' ? chalk.green : chalk.yellow;
          console.log(`  COV  : ${covColor(cov.status.padEnd(8))}  line=${cov.line_coverage}%  branch=${cov.branch_coverage}%  (threshold line=${cov.threshold.line}% branch=${cov.threshold.branch}%)`);
        } else if (cov) {
          console.log(`  COV  : ${chalk.gray('SKIPPED ')}  (pytest-cov unavailable or disabled — coverage is a warning, not a failure)`);
        } else {
          console.log(`  COV  : ${chalk.gray('UNSELECTED')}`);
        }

        logBlank();
        logOk(`execution-manifest.yaml → ${result.executionDir}/execution-manifest.yaml`);
        if (result.api) logOk(`api-result.json         → ${result.executionDir}/api-result.json`);
        if (result.e2e) logOk(`e2e-result.json         → ${result.executionDir}/e2e-result.json`);
        if (result.coverage) logOk(`coverage-result.json    → ${result.executionDir}/coverage-result.json`);
        if (result.fuzz) logOk(`fuzz-result.json        → ${result.executionDir}/fuzz-result.json`);
        if (result.performance) logOk(`performance-result.json → ${result.executionDir}/performance-result.json`);
        logOk(`summary.md              → ${result.executionDir}/summary.md`);
        logBlank();

        if (result.qualityGate.final_status === 'FAIL') {
          console.log(chalk.red(`→ Quality gate failed. Run: aws report inspect --change ${changeId}`));
          process.exit(1);
        } else if (result.qualityGate.final_status === 'PASS') {
          console.log(chalk.green('→ Quality gate passed. Proceed to archive-for-qa.'));
          process.exit(0);
        } else if (result.qualityGate.final_status === 'PASS_WITH_WARNINGS') {
          console.log(chalk.yellow(`→ Quality gate passed with warnings. Run: aws report inspect --change ${changeId}`));
          process.exit(0);
        } else {
          // final_status === 'SKIPPED'
          const anyTargetSelected = Object.values(result.selectedTargets).some(Boolean);
          if (!anyTargetSelected) {
            // All targets explicitly unselected — treat as a no-op run, not a failure.
            console.log(chalk.cyan('→ No targets selected — run skipped. Pass --change with selected targets.'));
            process.exit(0);
          } else {
            // Some targets were selected but all ran as SKIPPED (environment issue, missing fixtures, etc.).
            // Exit 1 so CI does not silently pass when tests never actually ran.
            console.log(chalk.yellow(`→ All selected targets were skipped (environment may be unreachable). Run: aws report inspect --change ${changeId}`));
            process.exit(1);
          }
        }
      } catch (err) {
        logError(`Run failed: ${(err as Error).message}`);
        if (process.env.AWS_DEBUG) console.error((err as Error).stack);
        process.exit(1);
      }
    });
}

type TestChangesOverridePolicy = 'forbidden' | 'with-evidence' | 'free';

function loadTestChangesOverridePolicy(projectRoot: string): TestChangesOverridePolicy {
  const configPath = path.join(projectRoot, '.aws', 'execution-policy.json');
  if (!fs.existsSync(configPath)) return 'with-evidence';
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.healing)) return 'with-evidence';
    const value = parsed.healing.testChangesOverride;
    return value === 'forbidden' || value === 'free' || value === 'with-evidence'
      ? value
      : 'with-evidence';
  } catch {
    return 'with-evidence';
  }
}

function toPerTarget(result: RunnerResult): Record<string, unknown> {
  return {
    api: result.api
      ? pickExecutionResult(result.api)
      : { status: 'unselected', total: 0, passed: 0, failed: 0, skipped: 0 },
    e2e: result.e2e
      ? pickExecutionResult(result.e2e)
      : { status: 'unselected', total: 0, passed: 0, failed: 0, skipped: 0 },
    fuzz: result.fuzz
      ? pickExecutionResult(result.fuzz)
      : { status: 'unselected', total: 0, passed: 0, failed: 0, skipped: 0 },
    performance: result.performance
      ? { status: result.performance.status, scenarios: result.performance.scenarios.length }
      : { status: 'unselected', scenarios: 0 },
  };
}

function pickExecutionResult(result: {
  status: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}): Record<string, unknown> {
  return {
    status: result.status,
    total: result.total,
    passed: result.passed,
    failed: result.failed,
    skipped: result.skipped,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
