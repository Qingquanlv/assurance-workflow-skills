// E0/E2a/E4 wrapper: seed → write-scan → driver|opencode → write-scan → archive → evidence.
// See eval/contracts/evidence-spec.md — executor: eval-workflow-run
//
// Default entry: TS driver (`aws workflow run --adapter headless`).
// Legacy: --entry orchestrator|phase-skill still uses OpenCode + skill prompt.
// Fake CI (EVAL_USE_FAKE_OPENCODE=1): one-shot golden stub (bypasses live LLM / phase loop).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { archiveArtifacts } from '../archive_artifacts';
import { seedChange } from '../seed_change';
import {
  captureWriteScanAfter,
  captureWriteScanBefore,
  parseSingleTestType,
  resolveWritePolicy,
} from '../write_scan';
import {
  buildExecutionPayload,
  buildOpenCodeProcessExecutionFields,
  resolveAttemptDir,
  resolveRepoRoot,
  writeAttemptLogs,
  writeExecutionJson,
  writeOpenCodeProcessSummary,
} from '../wrapper_utils';

export interface WorkflowEvalInput {
  repoRoot?: string;
  projectDir: string;
  changeId: string;
  fixtureTier: string;
  runMode?: string;
  testTypes?: string;
  runTests?: boolean;
  timeoutSeconds?: number;
  entry?: string;
  archiveDir: string;
  attemptDir?: string;
  skipSeed?: boolean;
  opencodeBin?: string;
  awsBin?: string;
  agentCmd?: string;
  allowedWrites?: string[];
}

function mapScope(runMode: string): 'execute' | 'full' {
  // case-only / full need intake+execute phases → full driver scope
  // codegen-only / plan-only style execute work → execute scope
  if (runMode === 'codegen-only' || runMode === 'plan-only' || runMode === 'review-plan') {
    return 'execute';
  }
  return 'full';
}

function resolveAwsInvocation(
  repoRoot: string,
  awsBinOpt: string | undefined,
): { command: string; prefixArgs: string[] } {
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

export function runWorkflowEval(input: WorkflowEvalInput): number {
  const repoRoot = resolveRepoRoot(input.repoRoot, __dirname);
  const projectDir = path.resolve(input.projectDir);
  const changeId = input.changeId;
  const archiveDir = path.resolve(input.archiveDir);
  const attemptDir = resolveAttemptDir(
    { 'attempt-dir': input.attemptDir },
    archiveDir,
  );
  const runMode = input.runMode ?? 'full';
  const testTypes = input.testTypes ?? 'api';
  const runTests = input.runTests ?? false;
  const timeoutMs = (input.timeoutSeconds ?? 7200) * 1000;
  const entry = input.entry ?? 'driver';
  const opencodeBin = input.opencodeBin ?? process.env.OPENCODE_BIN ?? 'opencode';

  if (!projectDir || !changeId || !archiveDir || !attemptDir || !input.fixtureTier) {
    console.error(
      'workflow-run requires projectDir, changeId, fixtureTier, runMode, archiveDir, and attemptDir'
    );
    return 2;
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
    testType = runMode === 'codegen-only' ? parseSingleTestType(testTypes) : 'api';
  } catch (err) {
    console.error(errorMessage(err));
    return 2;
  }
  const writePolicy = input.allowedWrites
    ? { mode: 'allowlist' as const, patterns: input.allowedWrites }
    : resolveWritePolicy(runMode, testTypes);

  const fakeScript = path.join(repoRoot, 'eval/fixtures/fakes/fake-opencode-eval.mjs');
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
      test_types: testTypes,
      run_tests: runTests,
      auto_archive: false,
      max_healing_attempts: 0,
    };
    const agentCmd =
      input.agentCmd ??
      `${opencodeBin} run --dir ${projectDir} --format json`;
    const aws = resolveAwsInvocation(repoRoot, input.awsBin);
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
    runBin = opencodeBin;
    const CODEGEN_SKILLS = {
      api: 'aws-api-codegen',
      e2e: 'aws-e2e-codegen',
      fuzz: 'aws-fuzz-codegen',
      performance: 'aws-performance-codegen',
    };
    const skill =
      entry === 'phase-skill' && runMode === 'codegen-only'
        ? CODEGEN_SKILLS[testType as keyof typeof CODEGEN_SKILLS] ?? 'aws-api-codegen'
        : 'aws-workflow';
    const prompt = [
      `use skill ${skill}`,
      '',
      `Change id: ${changeId}`,
      `Run mode: ${runMode}`,
      `Test types: ${testTypes}`,
      `Run tests: ${runTests}`,
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
    if (!input.skipSeed) {
      seedChange({ projectDir, changeId, fixtureTier: input.fixtureTier });
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
    timedOut = spawnErrorCode(result.error) === 'ETIMEDOUT';

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
          fixture_tier: input.fixtureTier,
          run_mode: runMode,
          error: errorMessage(err),
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
    console.error(errorMessage(err));
    return 1;
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

    archiveArtifacts({ projectDir, changeId, archiveDir });
    archiveCompleted = true;
  } catch (err) {
    postError = errorMessage(err);
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
      fixture_tier: input.fixtureTier,
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
  return execution.wrapper_exit_code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function spawnErrorCode(error: Error | undefined): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}
