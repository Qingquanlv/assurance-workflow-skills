#!/usr/bin/env node
// E0/E2a/E4 wrapper: seed → write-scan → driver|opencode → write-scan → archive → evidence.
// See eval/contracts/evidence-spec.md — executor: eval-workflow-run
//
// Default entry: TS driver (`aws workflow run --adapter headless`).
// Legacy: --entry orchestrator|phase-skill still uses OpenCode + skill prompt.
// Fake CI (EVAL_USE_FAKE_OPENCODE=1): one-shot golden stub (bypasses live LLM / phase loop).

import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  captureWriteScanAfter,
  captureWriteScanBefore,
  parseSingleTestType,
  resolveWritePolicy,
} from './lib/write-scan.mjs';
import {
  buildExecutionPayload,
  buildOpenCodeProcessExecutionFields,
  resolveAttemptDir,
  resolveRepoRoot,
  writeAttemptLogs,
  writeExecutionJson,
  writeOpenCodeProcessSummary,
} from './lib/eval-wrapper-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function mapScope(runMode) {
  // case-only / full need intake+execute phases → full driver scope
  // codegen-only / plan-only style execute work → execute scope
  if (runMode === 'codegen-only' || runMode === 'plan-only' || runMode === 'review-plan') {
    return 'execute';
  }
  return 'full';
}

function resolveAwsInvocation(repoRoot, awsBinOpt) {
  if (awsBinOpt) {
    if (awsBinOpt.endsWith('.js') || awsBinOpt.endsWith('.mjs') || awsBinOpt.endsWith('.cjs')) {
      return { command: process.execPath, prefixArgs: [path.resolve(awsBinOpt)] };
    }
    return { command: awsBinOpt, prefixArgs: [] };
  }
  const distCli = path.join(repoRoot, 'dist', 'cli.js');
  if (fs.existsSync(distCli)) {
    return { command: process.execPath, prefixArgs: [distCli] };
  }
  return { command: 'aws', prefixArgs: [] };
}

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
      entry: { type: 'string', default: 'driver' },
      'archive-dir': { type: 'string' },
      'attempt-dir': { type: 'string' },
      'skip-seed': { type: 'boolean', default: false },
      'opencode-bin': { type: 'string', default: process.env.OPENCODE_BIN ?? 'opencode' },
      'aws-bin': { type: 'string' },
      'agent-cmd': { type: 'string' },
    },
  });

  const repoRoot = resolveRepoRoot(values['repo-root'], __dirname);
  const projectDir = path.resolve(values['project-dir'] ?? '');
  const changeId = values.change;
  const archiveDir = values['archive-dir'] ? path.resolve(values['archive-dir']) : null;
  const attemptDir = resolveAttemptDir(values, archiveDir);
  const runMode = values['run-mode'] ?? 'full';
  const timeoutMs = Number(values['timeout-seconds']) * 1000;
  const entry = values.entry ?? 'driver';

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
  let testType = 'api';
  try {
    testType = runMode === 'codegen-only' ? parseSingleTestType(values['test-types']) : 'api';
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const writePolicy = resolveWritePolicy(runMode, values['test-types']);

  const fakeScript = path.join(repoRoot, 'scripts/fake-opencode-eval.mjs');
  let runBin;
  let runArgs;
  let spawnCwd;
  let executorMode = 'driver-headless';

  if (useFake) {
    // CI smoke: one-shot golden materialization (not a live driver loop).
    executorMode = 'fake-opencode';
    runBin = process.execPath;
    runArgs = [fakeScript, runMode];
    spawnCwd = repoRoot;
  } else if (entry === 'driver') {
    executorMode = 'driver-headless';
    const scope = mapScope(runMode);
    const params = {
      run_mode: runMode,
      test_types: values['test-types'],
      run_tests: values['run-tests'] === 'true',
      auto_archive: false,
      max_healing_attempts: 0,
    };
    const agentCmd =
      values['agent-cmd'] ??
      `${values['opencode-bin']} run --dir ${projectDir} --format json`;
    const aws = resolveAwsInvocation(repoRoot, values['aws-bin']);
    runBin = aws.command;
    runArgs = [
      ...aws.prefixArgs,
      'workflow',
      'run',
      '--change',
      changeId,
      '--scope',
      scope,
      '--adapter',
      'headless',
      '--agent-cmd',
      agentCmd,
      '--params',
      JSON.stringify(params),
    ];
    spawnCwd = projectDir;
  } else {
    // Legacy: OpenCode + orchestrator / phase skill prompt
    executorMode = entry === 'phase-skill' ? 'opencode-phase-skill' : 'opencode-orchestrator';
    runBin = values['opencode-bin'];
    const CODEGEN_SKILLS = {
      api: 'aws-api-codegen',
      e2e: 'aws-e2e-codegen',
      fuzz: 'aws-fuzz-codegen',
      performance: 'aws-performance-codegen',
    };
    const skill =
      entry === 'phase-skill' && runMode === 'codegen-only'
        ? CODEGEN_SKILLS[testType] ?? 'aws-api-codegen'
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
    runArgs = ['run', '--dir', projectDir, '--format', 'json', prompt];
    if (allowUnsafe) {
      runArgs.splice(3, 0, '--dangerously-skip-permissions');
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

    const result = spawnSync(runBin, runArgs, {
      cwd: spawnCwd,
      timeout: timeoutMs,
      encoding: 'utf8',
      env: {
        ...process.env,
        EVAL_CHANGE_ID: changeId,
        EVAL_PROJECT_DIR: projectDir,
        EVAL_REPO_ROOT: repoRoot,
        EVAL_TEST_TYPES: testType,
        EVAL_EXECUTOR_MODE: executorMode,
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
    const processSummary = writeOpenCodeProcessSummary({
      attemptDir,
      stdoutText: opencodeStdout,
      safetyMode,
      projectDir,
    });
    writeExecutionJson(
      attemptDir,
      buildExecutionPayload(
        {
          executor: 'eval-workflow-run',
          executor_mode: executorMode,
          command: [runBin, ...runArgs],
          cwd: spawnCwd,
          signal: opencodeSignal,
          duration_ms: durationMs,
          timed_out: timedOut,
          safety_mode: safetyMode,
          change_id: changeId,
          fixture_tier: values['fixture-tier'],
          run_mode: runMode,
          error: err.message,
          ...buildOpenCodeProcessExecutionFields(processSummary, projectDir),
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
  let processSummary = null;

  try {
    captureWriteScanAfter(attemptDir, projectDir, writePolicy, beforePorcelain);
    evidenceCompleted = true;

    processSummary = writeOpenCodeProcessSummary({
      attemptDir,
      stdoutText: opencodeStdout,
      safetyMode,
      projectDir,
    });

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
    if (!processSummary) {
      processSummary = writeOpenCodeProcessSummary({
        attemptDir,
        stdoutText: opencodeStdout,
        safetyMode,
        projectDir,
      });
    }
  }

  const durationMs = Date.now() - t0;
  if (!processSummary) {
    processSummary = writeOpenCodeProcessSummary({
      attemptDir,
      stdoutText: opencodeStdout,
      safetyMode,
      projectDir,
    });
  }

  const execution = buildExecutionPayload(
    {
      executor: 'eval-workflow-run',
      executor_mode: executorMode,
      command: [runBin, ...runArgs],
      cwd: spawnCwd,
      signal: opencodeSignal,
      duration_ms: durationMs,
      timed_out: timedOut,
      safety_mode: safetyMode,
      change_id: changeId,
      fixture_tier: values['fixture-tier'],
      run_mode: runMode,
      ...(postError ? { error: postError } : {}),
      ...buildOpenCodeProcessExecutionFields(processSummary, projectDir),
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
