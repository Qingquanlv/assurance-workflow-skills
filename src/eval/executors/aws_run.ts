// @ts-nocheck
// E3 workflow-run wrapper: seed → git write-scan → aws run → archive → evidence (no OpenCode).
// See eval/contracts/evidence-spec.md — executor: eval-aws-run

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { archiveArtifacts } from '../archive_artifacts';
import { seedChange } from '../seed_change';
import {
  captureWriteScanAfter,
  captureWriteScanBefore,
  DEFAULT_RUN_DENYLIST,
} from '../write_scan';
import {
  buildExecutionPayload,
  resolveAttemptDir,
  resolveRepoRoot,
  writeAttemptLogs,
  writeExecutionJson,
} from '../wrapper_utils';
import { writeFakeExecutionEvidence } from '../fake_execution_evidence';

export interface AwsEvalInput {
  repoRoot?: string;
  projectDir: string;
  changeId: string;
  fixtureTier?: string;
  archiveDir: string;
  attemptDir?: string;
  skipSeed?: boolean;
  awsBin?: string;
  timeoutSeconds?: number;
}

export function runAwsEval(input: AwsEvalInput | string[]): number {
  const values = Array.isArray(input) ? parseArgs({
    args: input,
    options: {
      'repo-root': { type: 'string' },
      'project-dir': { type: 'string' },
      change: { type: 'string' },
      'fixture-tier': { type: 'string', default: 'L3-run-seed' },
      'archive-dir': { type: 'string' },
      'attempt-dir': { type: 'string' },
      'skip-seed': { type: 'boolean', default: false },
      'aws-bin': { type: 'string' },
      'timeout-seconds': { type: 'string', default: '900' },
    },
  }).values : {
    'repo-root': input.repoRoot,
    'project-dir': input.projectDir,
    change: input.changeId,
    'fixture-tier': input.fixtureTier ?? 'L3-run-seed',
    'archive-dir': input.archiveDir,
    'attempt-dir': input.attemptDir,
    'skip-seed': input.skipSeed ?? false,
    'aws-bin': input.awsBin,
    'timeout-seconds': String(input.timeoutSeconds ?? 900),
  };

  const repoRoot = resolveRepoRoot(values['repo-root'], __dirname);
  const projectDir = path.resolve(values['project-dir'] ?? '');
  const changeId = values.change;
  const archiveDir = values['archive-dir'] ? path.resolve(values['archive-dir']) : null;
  const attemptDir = resolveAttemptDir(values, archiveDir);
  const timeoutMs = Number(values['timeout-seconds']) * 1000;

  if (!projectDir || !changeId || !archiveDir || !attemptDir) {
    console.error(
      'Usage: eval-aws-run.mjs --project-dir <bench> --change <id> --archive-dir <attempt>/raw-output [--repo-root <repo>]'
    );
    return 2;
  }

  fs.mkdirSync(attemptDir, { recursive: true });
  fs.mkdirSync(archiveDir, { recursive: true });

  const t0 = Date.now();
  let awsStdout = '';
  let awsStderr = '';
  let awsExit = 0;
  let awsSignal = null;
  let timedOut = false;
  let beforePorcelain = '';
  const policy = { mode: 'denylist', patterns: DEFAULT_RUN_DENYLIST };
  const useFake = process.env.EVAL_USE_FAKE_AWS_RUN === '1';

  const awsCliPath = path.join(repoRoot, 'dist/cli.js');
  const awsBin = values['aws-bin'] ?? process.execPath;
  const awsArgs =
    values['aws-bin'] != null
      ? ['run', '--change', changeId]
      : [awsCliPath, 'run', '--change', changeId];

  try {
    if (!values['skip-seed']) {
      seedChange({ projectDir, changeId, fixtureTier: values['fixture-tier'] });
    }

    beforePorcelain = captureWriteScanBefore(attemptDir, projectDir, policy);

    if (useFake) {
      const executionDir = path.join(projectDir, 'qa', 'changes', changeId, 'execution');
      writeFakeExecutionEvidence({
        executionDir,
        changeId,
        batchId: 'eval-fake-run',
        summary:
          '# Eval fake workflow-run\n\nSynthetic E3 execution artifact for CI smoke.\n',
      });
      awsStdout = `eval-aws-run: wrote fake execution for ${changeId}\n`;
      awsExit = 0;
    } else {
      const awsResult = spawnSync(awsBin, awsArgs, {
        cwd: projectDir,
        timeout: timeoutMs,
        encoding: 'utf8',
        env: { ...process.env },
        maxBuffer: 100 * 1024 * 1024,
      });

      awsStdout = awsResult.stdout ?? '';
      awsStderr = awsResult.stderr ?? '';
      awsExit = awsResult.status ?? 1;
      awsSignal = awsResult.signal;
      timedOut = awsResult.error?.code === 'ETIMEDOUT';
    }

    writeAttemptLogs(attemptDir, awsStdout, awsStderr);
  } catch (err) {
    const durationMs = Date.now() - t0;
    writeAttemptLogs(attemptDir, awsStdout, awsStderr);
    writeExecutionJson(
      attemptDir,
      buildExecutionPayload(
        {
          executor: 'eval-aws-run',
          command: [awsBin, ...awsArgs],
          cwd: projectDir,
          signal: awsSignal,
          duration_ms: durationMs,
          timed_out: timedOut,
          safety_mode: 'enabled',
          change_id: changeId,
          fixture_tier: values['fixture-tier'],
          error: err.message,
        },
        awsExit,
        {
          infrastructureError: true,
          archiveCompleted: false,
          evidenceCompleted: false,
        }
      )
    );
    console.error(err.message);
    return 1;
  }

  let archiveCompleted = false;
  let evidenceCompleted = false;
  let postError = null;

  try {
    captureWriteScanAfter(attemptDir, projectDir, policy, beforePorcelain);
    evidenceCompleted = true;

    archiveArtifacts({ projectDir, changeId, archiveDir });
    archiveCompleted = true;
  } catch (err) {
    postError = err.message;
  }

  const durationMs = Date.now() - t0;
  const execution = buildExecutionPayload(
    {
      executor: 'eval-aws-run',
      command: [awsBin, ...awsArgs],
      cwd: projectDir,
      signal: awsSignal,
      duration_ms: durationMs,
      timed_out: timedOut,
      safety_mode: 'enabled',
      change_id: changeId,
      fixture_tier: values['fixture-tier'],
      ...(postError ? { error: postError } : {}),
    },
    awsExit,
    {
      infrastructureError: !!postError,
      archiveCompleted,
      evidenceCompleted,
    }
  );

  writeExecutionJson(attemptDir, execution);
  if (postError) {
    console.error(postError);
  }
  return execution.wrapper_exit_code;
}
