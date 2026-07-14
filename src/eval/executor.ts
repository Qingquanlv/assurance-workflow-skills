// src/eval/executor.ts — Execute eval targets (in_process / subprocess / mixed)
// CONSTRAINT: Must NOT import anything from src/eval/scorers/*

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync, spawnSync } from 'child_process';
import type {
  ExecutorConfig,
  InProcessExecutorConfig,
  SubprocessExecutorConfig,
  WorkflowRunExecutorConfig,
  AwsRunExecutorConfig,
  LeafExecutorConfig,
  DatasetSample,
  ExecutionResult,
} from './types';
import { requireRuntimeModule } from './module_resolver';
import { expandTemplate, expandTemplateVars } from './executor_template';
import { resolveSampleSut } from './sut_registry';
import micromatch from 'micromatch';
import { runWorkflowEval } from './executors/workflow_run';
import { runAwsEval } from './executors/aws_run';

// ── Sandbox management ────────────────────────────────────────────────────────

function prepareSandbox(
  copyFrom: string | undefined,
  cleanBeforeRun: boolean,
  sampleDir: string,
  projectRoot: string
): string {
  const sandboxPath = path.join(sampleDir, 'sandbox');

  if (cleanBeforeRun && fs.existsSync(sandboxPath)) {
    fs.rmSync(sandboxPath, { recursive: true, force: true });
  }
  fs.mkdirSync(sandboxPath, { recursive: true });

  if (copyFrom) {
    const srcPath = path.isAbsolute(copyFrom)
      ? copyFrom
      : path.join(projectRoot, copyFrom);
    if (!fs.existsSync(srcPath)) {
      throw new Error(`sandbox.copy_from source not found: ${srcPath}`);
    }
    copyDirRecursive(srcPath, sandboxPath);
  }

  return sandboxPath;
}

function copyDirRecursive(src: string, dest: string): void {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyDirRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

// ── in_process executor ────────────────────────────────────────────────────────

async function runInProcess(
  config: InProcessExecutorConfig,
  sample: DatasetSample,
  sampleDir: string,
  projectRoot: string
): Promise<void> {
  const rawOutputDir = path.join(sampleDir, 'raw-output');
  fs.mkdirSync(rawOutputDir, { recursive: true });

  const mod = requireRuntimeModule(projectRoot, config.target_module);
  const fn = mod[config.target_export];
  if (typeof fn !== 'function') {
    throw new Error(
      `Export '${config.target_export}' not found or not a function in ${config.target_module}`
    );
  }

  const result = await Promise.resolve(fn(sample));

  if (result === null || result === undefined || result === '') {
    throw new Error('in_process executor returned empty response (fail-closed)');
  }

  fs.writeFileSync(
    path.join(rawOutputDir, 'prediction.json'),
    JSON.stringify(result, null, 2)
  );
}

function writeMinimalAttemptLogs(attemptDir: string, stdout = 'eval in_process ok\n'): void {
  fs.mkdirSync(attemptDir, { recursive: true });
  const stdoutPath = path.join(attemptDir, 'stdout.log');
  const stderrPath = path.join(attemptDir, 'stderr.log');
  if (!fs.existsSync(stdoutPath)) {
    fs.writeFileSync(stdoutPath, stdout);
  }
  if (!fs.existsSync(stderrPath)) {
    fs.writeFileSync(stderrPath, '');
  }
}

// ── External evidence (eval-aws-run / eval-workflow-run wrappers) ───────────────

const EXTERNAL_EVIDENCE_EXECUTORS = new Set([
  'eval-aws-run',
  'eval-workflow-run',
  'aws-run-wrapper',
]);

function attemptHasExternalEvidence(attemptDir: string): boolean {
  const execPath = path.join(attemptDir, 'execution.json');
  if (!fs.existsSync(execPath)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(execPath, 'utf8')) as {
      executor?: string;
    };
    return (
      typeof data.executor === 'string' &&
      EXTERNAL_EVIDENCE_EXECUTORS.has(data.executor)
    );
  } catch {
    return false;
  }
}

function assertExternalEvidenceArtifacts(attemptDir: string): void {
  for (const name of ['stdout.log', 'stderr.log', 'execution.json']) {
    const filePath = path.join(attemptDir, name);
    if (!fs.existsSync(filePath)) {
      throw new Error(
        `External evidence missing ${name} under ${attemptDir} (evidence-spec E4)`
      );
    }
  }
}

function writeExecutionJson(attemptDir: string, result: ExecutionResult): void {
  if (attemptHasExternalEvidence(attemptDir)) return;
  fs.writeFileSync(
    path.join(attemptDir, 'execution.json'),
    JSON.stringify(result, null, 2)
  );
}

// ── Expected output verification ───────────────────────────────────────────────

function isGlobPattern(p: string): boolean {
  return /[*?[\]{}]/.test(p);
}

function walkFiles(rootDir: string, currentDir = rootDir, files: string[] = []): string[] {
  if (!fs.existsSync(currentDir)) return files;
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const abs = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(rootDir, abs, files);
    } else if (entry.isFile()) {
      files.push(path.relative(rootDir, abs).split(path.sep).join('/'));
    }
  }
  return files;
}

function resolveExpectedOutputBase(
  pattern: string,
  expanded: string,
  workdir: string,
  attemptDir: string
): { baseDir: string; relativePattern: string } {
  if (
    pattern.includes('{{attempt.dir}}') ||
    (path.isAbsolute(expanded) && expanded.startsWith(attemptDir))
  ) {
    return {
      baseDir: attemptDir,
      relativePattern: path.isAbsolute(expanded)
        ? path.relative(attemptDir, expanded)
        : expanded,
    };
  }

  if (path.isAbsolute(expanded)) {
    return {
      baseDir: path.dirname(expanded),
      relativePattern: path.basename(expanded),
    };
  }

  return { baseDir: workdir, relativePattern: expanded };
}

function verifyAndCopyExpectedOutputs(
  patterns: string[],
  templateVars: Record<string, string>,
  workdir: string,
  attemptDir: string,
  rawOutputDir: string
): void {
  for (const pattern of patterns) {
    const expanded = expandTemplate(pattern, templateVars);
    const { baseDir, relativePattern } = resolveExpectedOutputBase(
      pattern,
      expanded,
      workdir,
      attemptDir
    );

    if (isGlobPattern(relativePattern)) {
      const allFiles = walkFiles(baseDir);
      const matches = micromatch(allFiles, relativePattern, { dot: true });
      if (matches.length === 0) {
        throw new Error(
          `Expected output glob matched no files: ${pattern} (base: ${baseDir})`
        );
      }
      for (const match of matches) {
        const outputPath = path.join(baseDir, match);
        const destPath = path.join(rawOutputDir, match);
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(outputPath, destPath);
      }
      continue;
    }

    const outputPath = path.isAbsolute(expanded)
      ? expanded
      : path.join(baseDir, relativePattern);
    if (!fs.existsSync(outputPath)) {
      throw new Error(
        `Expected output not found: ${outputPath} (subprocess produced no artifact)`
      );
    }

    const destPath = path.join(rawOutputDir, relativePattern);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(outputPath, destPath);
  }
}

// ── subprocess executor ────────────────────────────────────────────────────────

function runSubprocess(
  config: SubprocessExecutorConfig,
  sample: DatasetSample,
  attemptDir: string,
  projectRoot: string,
  baseTemplateVars: Record<string, string>
): void {
  const rawOutputDir = path.join(attemptDir, 'raw-output');
  fs.mkdirSync(rawOutputDir, { recursive: true });

  // Prepare sandbox if configured
  let sandboxPath: string | undefined;
  if (config.sandbox) {
    const copyFrom = config.sandbox.copy_from
      ? expandTemplate(config.sandbox.copy_from, baseTemplateVars)
      : undefined;
    sandboxPath = prepareSandbox(
      copyFrom,
      config.sandbox.clean_before_run ?? true,
      attemptDir,
      projectRoot
    );
  }

  const templateVars = expandTemplateVars({
    sample,
    projectRoot: baseTemplateVars['workspace.root'],
    runId: baseTemplateVars['run.id'],
    attemptDir: baseTemplateVars['attempt.dir'],
    sandboxPath,
    sutDir: baseTemplateVars['sut.dir'],
  });

  // Resolve workdir
  const workdir = config.workdir
    ? expandTemplate(config.workdir, templateVars)
    : sandboxPath ?? attemptDir;

  // Expand command
  const command = expandTemplate(config.command, templateVars);
  const [cmd, ...args] = command.split(/\s+/);

  // Build environment
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (config.env) {
    for (const [k, v] of Object.entries(config.env)) {
      env[k] = expandTemplate(v, templateVars);
    }
  }

  const result = spawnSync(cmd, args, {
    cwd: workdir,
    env,
    timeout: config.timeout_seconds * 1000,
    encoding: 'utf-8',
    maxBuffer: 100 * 1024 * 1024,
  });

  // Separate tool events from stdout
  const stdoutLines = (result.stdout ?? '').split('\n');
  const toolEventLines: string[] = [];
  const regularLines: string[] = [];
  for (const line of stdoutLines) {
    if (line.startsWith('TOOL_EVENT:')) {
      toolEventLines.push(line.slice('TOOL_EVENT:'.length).trim());
    } else {
      regularLines.push(line);
    }
  }

  if (!attemptHasExternalEvidence(attemptDir)) {
    fs.writeFileSync(path.join(attemptDir, 'stdout.log'), regularLines.join('\n'));
    fs.writeFileSync(path.join(attemptDir, 'stderr.log'), result.stderr ?? '');
  } else {
    assertExternalEvidenceArtifacts(attemptDir);
  }

  if (toolEventLines.length > 0) {
    fs.writeFileSync(
      path.join(attemptDir, 'tool-events.jsonl'),
      toolEventLines.join('\n')
    );
  }

  if (result.error) {
    throw new Error(`Subprocess error: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(
      `Subprocess exited with code ${result.status ?? 'null'} (fail-closed)`
    );
  }

  verifyAndCopyExpectedOutputs(
    config.expected_outputs,
    templateVars,
    workdir,
    attemptDir,
    rawOutputDir
  );
}

function requireSampleString(sample: DatasetSample, key: string): string {
  const value = sample.input[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${key} is required for typed eval executor`);
  }
  return value;
}

function withExpandedEnv<T>(
  envConfig: Record<string, string> | undefined,
  templateVars: Record<string, string>,
  operation: () => T,
): T {
  if (!envConfig) return operation();
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(envConfig)) {
    previous.set(key, process.env[key]);
    process.env[key] = expandTemplate(value, templateVars);
  }
  try {
    return operation();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function runCompiledWrapper(
  config: WorkflowRunExecutorConfig | AwsRunExecutorConfig,
  sample: DatasetSample,
  attemptDir: string,
  projectRoot: string,
  templateVars: Record<string, string>,
  sutDir: string | undefined,
): void {
  if (!sutDir) throw new Error('sut.dir is required for typed eval executor');
  const changeId = requireSampleString(sample, 'change_id');
  const archiveDir = path.join(attemptDir, 'raw-output');
  const fixtureTier = requireSampleString(sample, 'fixture_tier');

  let sandboxPath: string | undefined;
  if (config.sandbox) {
    const copyFrom = config.sandbox.copy_from
      ? expandTemplate(config.sandbox.copy_from, templateVars)
      : undefined;
    sandboxPath = prepareSandbox(
      copyFrom,
      config.sandbox.clean_before_run ?? true,
      attemptDir,
      projectRoot,
    );
  }
  const policyTemplateVars = expandTemplateVars({
    sample,
    projectRoot,
    runId: templateVars['run.id'],
    attemptDir,
    sandboxPath,
    sutDir,
  });
  const workdir = config.workdir
    ? expandTemplate(config.workdir, policyTemplateVars)
    : sandboxPath ?? sutDir;
  if (!fs.existsSync(workdir)) {
    throw new Error(`executor workdir not found: ${workdir}`);
  }
  const executorProjectDir = sandboxPath ?? sutDir;
  const allowedWrites = config.allowed_writes?.map((pattern) =>
    expandTemplate(pattern, policyTemplateVars)
  );

  const exitCode = withExpandedEnv(config.env, policyTemplateVars, () => (
    config.type === 'workflow-run'
      ? runWorkflowEval({
        repoRoot: projectRoot,
        projectDir: executorProjectDir,
        changeId,
        fixtureTier,
        runMode: expandTemplate(config.run_mode, policyTemplateVars),
        testTypes: config.test_type,
        runTests: config.run_tests ?? false,
        timeoutSeconds: config.timeout_seconds,
        entry: config.entry,
        archiveDir,
        attemptDir,
        skipSeed: config.skip_seed,
        opencodeBin: config.opencode_bin
          ? expandTemplate(config.opencode_bin, policyTemplateVars)
          : undefined,
        awsBin: config.aws_bin
          ? expandTemplate(config.aws_bin, policyTemplateVars)
          : undefined,
        agentCmd: config.agent_cmd
          ? expandTemplate(config.agent_cmd, policyTemplateVars)
          : undefined,
        allowedWrites,
      })
      : runAwsEval({
        repoRoot: projectRoot,
        projectDir: executorProjectDir,
        changeId,
        fixtureTier,
        timeoutSeconds: config.timeout_seconds,
        archiveDir,
        attemptDir,
        skipSeed: config.skip_seed,
        awsBin: config.aws_bin
          ? expandTemplate(config.aws_bin, policyTemplateVars)
          : undefined,
        allowedWrites,
      })
  ));
  if (exitCode !== 0) throw new Error(`${config.type} executor failed with code ${exitCode}`);
  assertExternalEvidenceArtifacts(attemptDir);
  verifyAndCopyExpectedOutputs(
    config.expected_outputs,
    policyTemplateVars,
    workdir,
    attemptDir,
    archiveDir,
  );
}

async function runLeafExecutor(
  config: LeafExecutorConfig,
  sample: DatasetSample,
  attemptDir: string,
  projectRoot: string,
  templateVars: Record<string, string>,
  sutDir: string | undefined,
): Promise<number | undefined> {
  if (config.type === 'in_process') {
    await runInProcess(config, sample, attemptDir, projectRoot);
    return undefined;
  }
  if (config.type === 'subprocess') {
    runSubprocess(config, sample, attemptDir, projectRoot, templateVars);
    return 0;
  }
  runCompiledWrapper(config, sample, attemptDir, projectRoot, templateVars, sutDir);
  return 0;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export interface ExecutorRunInput {
  config: ExecutorConfig;
  sample: DatasetSample;
  sampleDir: string;
  attemptDir: string;
  projectRoot: string;
  runId: string;
  sutDir?: string;
}

export async function executeAttempt(
  input: ExecutorRunInput
): Promise<ExecutionResult> {
  const { config, sample, attemptDir, projectRoot, runId, sutDir } = input;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const resolvedSutDir =
    sutDir ?? resolveSampleSut(sample.input, projectRoot)?.dir;

  const baseTemplateVars = expandTemplateVars({
    sample,
    projectRoot,
    runId,
    attemptDir,
    sutDir: resolvedSutDir,
  });

  let exitCode: number | undefined;

  try {
    if (config.type !== 'mixed') {
      exitCode = await runLeafExecutor(
        config,
        sample,
        attemptDir,
        projectRoot,
        baseTemplateVars,
        resolvedSutDir,
      );
    } else {
      const checkType = sample.check_type;
      if (!checkType) {
        throw new Error('mixed executor requires sample.check_type to be set');
      }
      const subConfig = config.per_check_type[checkType];
      if (!subConfig) {
        throw new Error(
          `mixed executor has no entry for check_type '${checkType}'`
        );
      }
      exitCode = await runLeafExecutor(
        subConfig,
        sample,
        attemptDir,
        projectRoot,
        baseTemplateVars,
        resolvedSutDir,
      );
    }

    const completedAt = new Date().toISOString();
    writeMinimalAttemptLogs(attemptDir);
    const result: ExecutionResult = {
      sample_id: sample.id,
      attempt: 0,
      executor_type: config.type,
      check_type: sample.check_type,
      started_at: startedAt,
      completed_at: completedAt,
      duration_ms: Date.now() - t0,
      exit_code: exitCode,
      status: 'ok',
    };

    writeExecutionJson(attemptDir, result);
    return result;
  } catch (err) {
    const completedAt = new Date().toISOString();
    const result: ExecutionResult = {
      sample_id: sample.id,
      attempt: 0,
      executor_type: config.type,
      check_type: sample.check_type,
      started_at: startedAt,
      completed_at: completedAt,
      duration_ms: Date.now() - t0,
      status: (err as Error).message.includes('timeout') ? 'timeout' : 'error',
      error: (err as Error).message,
    };

    writeExecutionJson(attemptDir, result);
    throw err;
  }
}
