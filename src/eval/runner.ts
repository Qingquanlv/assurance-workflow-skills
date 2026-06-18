// src/eval/runner.ts — Orchestrate single-suite runs and batch plan runs

import * as fs from 'fs';
import * as path from 'path';
import type {
  EvalSuite,
  DatasetSample,
  SampleScore,
  EvalPlan,
  EvalGateResult,
  BatchGateResult,
  JudgeCalibrationThresholds,
} from './types';
import { DatasetLoader } from './dataset_loader';
import { buildManifest, finalizeManifest, generateRunId, readManifest } from './manifest';
import { getGitSha } from './manifest_helpers';
import { readMetrics as readMetricsFromFile } from './metrics';
import { executeAttempt } from './executor';
import { aggregateScores } from './metrics';
import { computeGateResult, evaluateThreshold } from './gate';
import { BatchBuilder, BatchGate, BatchReporter } from './batch';
import { generateRunReport } from './report';
import { loadSuite, readPlan } from './plan';
import {
  resolveScorerModule,
  resolveScorerModuleRef,
  resolveRuntimeModule,
} from './module_resolver';
import { runCalibration } from './judge/calibration';

export interface RunOptions {
  suiteName?: string;
  planPath?: string;
  sampleId?: string;
  repeat?: number;
  projectRoot: string;
  evalRoot: string;
  calibrate?: boolean;
}

export interface RunResult {
  runId?: string;
  batchId?: string;
  verdict: string;
}

// ── Suite-level runner ────────────────────────────────────────────────────────

export async function runSuite(opts: {
  suite: EvalSuite;
  suiteFilePath: string;
  evalRoot: string;
  projectRoot: string;
  sampleId?: string;
  tags?: string[];
  tagMatch?: 'any' | 'all';
  maxSamples?: number;
  repeat?: number;
  calibrate?: boolean;
}): Promise<{ runId: string; gateResult: EvalGateResult }> {
  const { suite, suiteFilePath, evalRoot, projectRoot, calibrate } = opts;

  const datasetDir = path.join(evalRoot, 'datasets', suite.dataset);
  const runsDir = path.join(evalRoot, 'runs');

  // Load dataset
  const loader = new DatasetLoader(datasetDir);
  const { samples, selectedIds } = loader.loadForRun({
    sampleId: opts.sampleId,
    tags: opts.tags,
    tagMatch: opts.tagMatch,
    maxSamples: opts.maxSamples,
  });

  // Generate run ID and create run directory
  const runId = generateRunId(getGitSha(projectRoot));
  const runDir = path.join(runsDir, runId);
  fs.mkdirSync(runDir, { recursive: true });

  // Build manifest and capture it
  buildManifest({
    suite,
    suiteFilePath,
    datasetDir,
    selectedIds,
    projectRoot,
    runDir,
  });

  const manifest = readManifest(runDir);
  const targetModel = manifest.target_model;

  let executedAttempts = 0;
  const repeatCount = opts.repeat ?? suite.repeat ?? 1;

  // Execute each sample × attempt
  for (const sample of samples) {
    const sampleDir = path.join(runDir, 'samples', sample.id);
    fs.mkdirSync(sampleDir, { recursive: true });

    for (let attempt = 0; attempt < repeatCount; attempt++) {
      const attemptDir = path.join(sampleDir, `attempt-${attempt}`);
      fs.mkdirSync(attemptDir, { recursive: true });

      try {
        const execResult = await executeAttempt({
          config: suite.executor,
          sample,
          sampleDir,
          attemptDir,
          projectRoot,
        });

        // Call judge if defined
        if (suite.judge) {
          await runJudge(
            { ...suite, judge: suite.judge },
            sample,
            attemptDir,
            projectRoot,
            targetModel
          );
        }

        // Call scorer if available (scorer modules are loaded dynamically per suite)
        const score = await runScorer(suite, sample, attemptDir, projectRoot);
        fs.writeFileSync(
          path.join(attemptDir, 'score.json'),
          JSON.stringify(score, null, 2)
        );
      } catch (err) {
        // Fail-closed: write error score, continue to next sample
        const errorScore: SampleScore = {
          sample_id: sample.id,
          status: 'error',
          metrics: {},
          error: (err as Error).message,
        };
        fs.writeFileSync(
          path.join(attemptDir, 'score.json'),
          JSON.stringify(errorScore, null, 2)
        );
      }

      executedAttempts++;
    }
  }

  // Finalize manifest: executed_samples = unique samples, not attempt count
  finalizeManifest(runDir, samples.length, executedAttempts);

  // Aggregate metrics
  aggregateScores(runDir, suite.name, runId);

  // Compute gate result
  let gateResult = computeGateResult(suite, readMetrics(runDir), runId, runDir);

  // Run calibration if requested and thresholds are defined
  if (calibrate && suite.judge_calibration) {
    const calibrationDir = path.join(evalRoot, 'datasets', suite.dataset, 'calibration');
    if (fs.existsSync(calibrationDir)) {
      const calibrationResult = await runCalibration({
        suite,
        calibrationDir,
        projectRoot,
        targetModel,
      });

      // Write calibration result
      fs.writeFileSync(
        path.join(runDir, 'calibration.json'),
        JSON.stringify(calibrationResult, null, 2)
      );

      // Check calibration thresholds
      const calibrationFailures = checkCalibrationThresholds(
        suite.judge_calibration,
        calibrationResult
      );

      if (calibrationFailures.length > 0) {
        // Override verdict to needs_human_review
        gateResult = {
          ...gateResult,
          verdict: 'needs_human_review',
          hard_gate_failures: [...gateResult.hard_gate_failures, 'calibration_failed'],
        };

        // Rewrite gate result
        fs.writeFileSync(
          path.join(runDir, 'gate-result.json'),
          JSON.stringify(gateResult, null, 2)
        );
      }
    }
  }

  // Generate report
  generateRunReport(runDir);

  return { runId, gateResult };
}

// ── Scorer dispatch ───────────────────────────────────────────────────────────

async function runScorer(
  suite: EvalSuite,
  sample: DatasetSample,
  attemptDir: string,
  projectRoot: string
): Promise<SampleScore> {
  const scorerRef = resolveScorerModuleRef(suite.name);
  let scorerPath: string;
  try {
    scorerPath = resolveScorerModule(projectRoot, suite.name);
  } catch {
    // Only _test suite may run without a scorer; real suites fail-closed
    if (suite.name === '_test') {
      return {
        sample_id: sample.id,
        status: 'ok',
        metrics: {},
      };
    }
    throw new Error(
      `No scorer found for suite '${suite.name}' at ${scorerRef} (fail-closed)`
    );
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const scorerMod = require(scorerPath);
    if (typeof scorerMod.score !== 'function') {
      throw new Error(`Scorer at ${scorerPath} must export a 'score' function`);
    }
    const result = await Promise.resolve(scorerMod.score(sample, attemptDir));
    if (!result || typeof result !== 'object') {
      throw new Error('Scorer returned empty result (fail-closed)');
    }
    return result as SampleScore;
  } catch (err) {
    throw new Error(`Scorer error: ${(err as Error).message}`);
  }
}

async function runJudge(
  suite: { judge: NonNullable<EvalSuite['judge']>; name: string },
  sample: DatasetSample,
  attemptDir: string,
  projectRoot: string,
  targetModel: string
): Promise<void> {
  // Load judge module
  const judgePath = resolveRuntimeModule(projectRoot, 'src/eval/judge/judge');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const judgeMod = require(judgePath);
  if (typeof judgeMod.judge !== 'function') {
    throw new Error('Judge module must export a judge function');
  }
  const result = await Promise.resolve(
    judgeMod.judge(sample, attemptDir, suite.judge, { projectRoot, targetModel })
  );
  if (!result || typeof result !== 'object') {
    throw new Error('Judge returned empty result (fail-closed)');
  }
  fs.writeFileSync(
    path.join(attemptDir, 'judge-result.json'),
    JSON.stringify(result, null, 2)
  );
}

function checkCalibrationThresholds(
  thresholds: JudgeCalibrationThresholds,
  result: {
    judge_human_agreement: number;
    judge_human_kappa: number;
    critical_label_disagreement: number;
    invalid_judge_output_rate: number;
  }
): string[] {
  const failures: string[] = [];

  if (!evaluateThreshold(thresholds.judge_human_agreement, result.judge_human_agreement)) {
    failures.push('judge_human_agreement');
  }
  if (!evaluateThreshold(thresholds.judge_human_kappa, result.judge_human_kappa)) {
    failures.push('judge_human_kappa');
  }
  if (!evaluateThreshold(thresholds.critical_label_disagreement, result.critical_label_disagreement)) {
    failures.push('critical_label_disagreement');
  }
  if (!evaluateThreshold(thresholds.invalid_judge_output_rate, result.invalid_judge_output_rate)) {
    failures.push('invalid_judge_output_rate');
  }

  return failures;
}

function readMetrics(runDir: string) {
  return readMetricsFromFile(runDir);
}

// ── Batch plan runner ─────────────────────────────────────────────────────────

export async function runPlan(opts: {
  planPath: string;
  projectRoot: string;
  evalRoot: string;
}): Promise<{ batchId: string; gateResult: BatchGateResult }> {
  const { planPath, projectRoot, evalRoot } = opts;

  const plan = readPlan(planPath);
  const suitesDir = path.join(evalRoot, 'suites');
  const runsDir = path.join(evalRoot, 'runs');
  const batchesDir = path.join(evalRoot, 'batches');

  const { batchId, batchDir } = BatchBuilder.create(plan, batchesDir, projectRoot);

  for (const suiteEntry of plan.suites) {
    const { suite, filePath: suiteFilePath } = loadSuite(suitesDir, suiteEntry.name);

    let runId: string | undefined;
    let verdict: string = 'fail';

    try {
      const result = await runSuite({
        suite,
        suiteFilePath,
        evalRoot,
        projectRoot,
        tags: suiteEntry.tags,
        tagMatch: suiteEntry.tag_match,
        maxSamples: suiteEntry.max_samples,
        repeat: suiteEntry.repeat,
      });
      runId = result.runId;
      verdict = result.gateResult.verdict;
    } catch (err) {
      // Suite failed to run — treat as fail-closed
      runId = generateRunId(getGitSha(projectRoot));
      const runDir = path.join(runsDir, runId);
      fs.mkdirSync(runDir, { recursive: true });

      // Write synthetic manifest so batch integrity checks pass.
      // selectedIds is empty because no samples were executed.
      buildManifest({
        suite,
        suiteFilePath,
        datasetDir: path.join(evalRoot, 'datasets', suite.dataset),
        selectedIds: [],
        projectRoot,
        runDir,
      });
      finalizeManifest(runDir, 0, 0);

      const errorMsg = (err as Error).message;
      const errorGate = {
        run_id: runId,
        suite: suiteEntry.name,
        verdict: 'fail' as const,
        hard_gate_failures: [`runner_error: ${errorMsg.slice(0, 200)}`],
        threshold_failures: [],
      };
      fs.writeFileSync(
        path.join(runDir, 'gate-result.json'),
        JSON.stringify(errorGate, null, 2)
      );
      verdict = 'fail';
    }

    BatchBuilder.recordSuiteRun(
      batchDir,
      suiteEntry.name,
      runId,
      verdict as any,
      suiteEntry.required
    );
  }

  BatchBuilder.finalize(batchDir);

  const batchGateResult = BatchGate.aggregate(batchDir, runsDir);
  BatchReporter.generate(batchDir);

  return { batchId, gateResult: batchGateResult };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

