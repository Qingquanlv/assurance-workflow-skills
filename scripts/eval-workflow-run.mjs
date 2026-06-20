#!/usr/bin/env node
// E0/E2a/E4 wrapper: seed → write-scan → opencode → write-scan → archive → evidence.
// See eval/contracts/evidence-spec.md — executor: eval-workflow-run

import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  captureWriteScanAfter,
  captureWriteScanBefore,
  resolveWritePolicy,
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
      'fixture-tier': { type: 'string' },
      'run-mode': { type: 'string' },
      'test-types': { type: 'string', default: 'api' },
      'run-tests': { type: 'string', default: 'false' },
      'timeout-seconds': { type: 'string', default: '7200' },
      entry: { type: 'string', default: 'orchestrator' },
      'archive-dir': { type: 'string' },
      'attempt-dir': { type: 'string' },
      'skip-seed': { type: 'boolean', default: false },
      'opencode-bin': { type: 'string', default: process.env.OPENCODE_BIN ?? 'opencode' },
    },
  });

  const repoRoot = resolveRepoRoot(values['repo-root'], __dirname);
  const projectDir = path.resolve(values['project-dir'] ?? '');
  const changeId = values.change;
  const archiveDir = values['archive-dir'] ? path.resolve(values['archive-dir']) : null;
  const attemptDir = resolveAttemptDir(values, archiveDir);
  const runMode = values['run-mode'] ?? 'full';
  const timeoutMs = Number(values['timeout-seconds']) * 1000;

  if (!projectDir || !changeId || !archiveDir || !attemptDir || !values['fixture-tier']) {
    console.error(
      'Usage: eval-workflow-run.mjs --project-dir <bench> --change <id> --fixture-tier <tier> --run-mode <mode> --archive-dir <attempt>/raw-output'
    );
    process.exit(2);
  }

  const useFake = process.env.EVAL_USE_FAKE_OPENCODE === '1';
  const allowUnsafe = process.env.EVAL_ALLOW_UNSAFE_PERMISSIONS === '1';
  const safetyMode = useFake || allowUnsafe ? 'disabled' : 'enabled';

  fs.mkdirSync(attemptDir, { recursive: true });
  fs.mkdirSync(archiveDir, { recursive: true });

  const t0 = Date.now();
  let opencodeStdout = '';
  let opencodeStderr = '';
  let opencodeExit = 0;
  let opencodeSignal = null;
  let timedOut = false;
  let beforePorcelain = '';
  const writePolicy = resolveWritePolicy(runMode);

  const fakeScript = path.join(repoRoot, 'scripts/fake-opencode-eval.mjs');
  let opencodeBin;
  let opencodeArgs;
  let spawnCwd;

  if (useFake) {
    opencodeBin = process.execPath;
    opencodeArgs = [fakeScript, runMode];
    spawnCwd = repoRoot;
  } else {
    opencodeBin = values['opencode-bin'];
    const skill =
      values.entry === 'phase-skill' && runMode === 'codegen-only'
        ? 'aws-api-codegen'
        : 'aws-workflow';
    const prompt = [
      `use skill ${skill}`,
      '',
      `Change id: ${changeId}`,
      `Run mode: ${runMode}`,
      `Test types: ${values['test-types']}`,
      `Run tests: ${values['run-tests']}`,
      'Auto archive: false',
      'Max healing attempts: 0',
    ].join('\n');
    opencodeArgs = ['run', '--dir', projectDir, '--format', 'json', prompt];
    if (allowUnsafe) {
      opencodeArgs.splice(3, 0, '--dangerously-skip-permissions');
    }
    spawnCwd = projectDir;
  }

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

    beforePorcelain = captureWriteScanBefore(attemptDir, projectDir, writePolicy);

    const result = spawnSync(opencodeBin, opencodeArgs, {
      cwd: spawnCwd,
      timeout: timeoutMs,
      encoding: 'utf8',
      env: {
        ...process.env,
        EVAL_CHANGE_ID: changeId,
        EVAL_PROJECT_DIR: projectDir,
        EVAL_REPO_ROOT: repoRoot,
      },
      maxBuffer: 100 * 1024 * 1024,
    });

    opencodeStdout = result.stdout ?? '';
    opencodeStderr = result.stderr ?? '';
    opencodeExit = result.status ?? 1;
    opencodeSignal = result.signal;
    timedOut = result.error?.code === 'ETIMEDOUT';

    writeAttemptLogs(attemptDir, opencodeStdout, opencodeStderr);
  } catch (err) {
    const durationMs = Date.now() - t0;
    writeAttemptLogs(attemptDir, opencodeStdout, opencodeStderr);
    writeExecutionJson(
      attemptDir,
      buildExecutionPayload(
        {
          executor: 'eval-workflow-run',
          command: [opencodeBin, ...opencodeArgs],
          cwd: spawnCwd,
          signal: opencodeSignal,
          duration_ms: durationMs,
          timed_out: timedOut,
          safety_mode: safetyMode,
          change_id: changeId,
          fixture_tier: values['fixture-tier'],
          run_mode: runMode,
          error: err.message,
        },
        opencodeExit,
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
    captureWriteScanAfter(attemptDir, projectDir, writePolicy, beforePorcelain);
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
      executor: 'eval-workflow-run',
      command: [opencodeBin, ...opencodeArgs],
      cwd: spawnCwd,
      signal: opencodeSignal,
      duration_ms: durationMs,
      timed_out: timedOut,
      safety_mode: safetyMode,
      change_id: changeId,
      fixture_tier: values['fixture-tier'],
      run_mode: runMode,
      ...(postError ? { error: postError } : {}),
    },
    opencodeExit,
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
