#!/usr/bin/env node
// E3 workflow-run wrapper: seed → git write-scan → aws run → archive → evidence (no OpenCode).
// See eval/contracts/evidence-spec.md — executor: eval-aws-run

import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  captureWriteScanAfter,
  captureWriteScanBefore,
  DEFAULT_RUN_DENYLIST,
} from './lib/write-scan.mjs';
import {
  buildExecutionPayload,
  resolveAttemptDir,
  resolveRepoRoot,
  writeAttemptLogs,
  writeExecutionJson,
} from './lib/eval-wrapper-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function main() {
  const { values } = parseArgs({
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
  });

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
    process.exit(2);
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

  const awsCliPath = path.join(repoRoot, 'dist/cli.js');
  const awsBin = values['aws-bin'] ?? process.execPath;
  const awsArgs =
    values['aws-bin'] != null
      ? ['run', '--change', changeId]
      : [awsCliPath, 'run', '--change', changeId];

  try {
    if (!values['skip-seed']) {
      const seedScript = path.join(repoRoot, 'scripts/eval-seed-change.mjs');
      if (!fs.existsSync(seedScript)) {
        throw new Error(
          `eval-seed-change.mjs not found at ${seedScript}; pass --skip-seed if change dir is pre-seeded`
        );
      }
      execFileSync(
        process.execPath,
        [
          seedScript,
          '--project-dir',
          projectDir,
          '--change',
          changeId,
          '--fixture-tier',
          values['fixture-tier'],
        ],
        { stdio: 'inherit', cwd: repoRoot }
      );
    }

    beforePorcelain = captureWriteScanBefore(attemptDir, projectDir, policy);

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
    process.exit(1);
  }

  let archiveCompleted = false;
  let evidenceCompleted = false;
  let postError = null;

  try {
    captureWriteScanAfter(attemptDir, projectDir, policy, beforePorcelain);
    evidenceCompleted = true;

    execFileSync(
      process.execPath,
      [
        path.join(repoRoot, 'scripts/eval-archive-artifacts.mjs'),
        '--project-dir',
        projectDir,
        '--change',
        changeId,
        '--archive-dir',
        archiveDir,
      ],
      { stdio: 'inherit', cwd: repoRoot }
    );
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
  process.exit(execution.wrapper_exit_code);
}

main();
