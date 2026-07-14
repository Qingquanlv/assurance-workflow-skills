// E3 workflow-run wrapper: seed → git write-scan → aws run → archive → evidence (no OpenCode).
// See eval/contracts/evidence-spec.md — executor: eval-aws-run

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
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
  allowedWrites?: string[];
}

export function runAwsEval(input: AwsEvalInput): number {
  const repoRoot = resolveRepoRoot(input.repoRoot, __dirname);
  const projectDir = path.resolve(input.projectDir);
  const changeId = input.changeId;
  const archiveDir = path.resolve(input.archiveDir);
  const attemptDir = resolveAttemptDir(
    { 'attempt-dir': input.attemptDir },
    archiveDir,
  );
  const fixtureTier = input.fixtureTier ?? 'L3-run-seed';
  const timeoutMs = (input.timeoutSeconds ?? 900) * 1000;

  if (!projectDir || !changeId || !archiveDir || !attemptDir) {
    console.error(
      'aws-run requires projectDir, changeId, archiveDir, and attemptDir'
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
  const policy = input.allowedWrites
    ? { mode: 'allowlist' as const, patterns: input.allowedWrites }
    : { mode: 'denylist' as const, patterns: DEFAULT_RUN_DENYLIST };
  const useFake = process.env.EVAL_USE_FAKE_AWS_RUN === '1';

  const awsCliPath = path.join(repoRoot, 'dist/cli.js');
  const awsBin = input.awsBin ?? process.execPath;
  const awsArgs =
    input.awsBin != null
      ? ['run', '--change', changeId]
      : [awsCliPath, 'run', '--change', changeId];

  try {
    if (!input.skipSeed) {
      seedChange({ projectDir, changeId, fixtureTier });
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
      timedOut = spawnErrorCode(awsResult.error) === 'ETIMEDOUT';
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
          fixture_tier: fixtureTier,
          error: errorMessage(err),
        },
        awsExit,
        {
          infrastructureError: true,
          archiveCompleted: false,
          evidenceCompleted: false,
        }
      )
    );
    console.error(errorMessage(err));
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
    postError = errorMessage(err);
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
      fixture_tier: fixtureTier,
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function spawnErrorCode(error: Error | undefined): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}
