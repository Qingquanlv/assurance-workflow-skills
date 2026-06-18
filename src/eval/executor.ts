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
  DatasetSample,
  ExecutionResult,
} from './types';

// ── Template expansion ────────────────────────────────────────────────────────

function expandTemplate(
  template: string,
  vars: Record<string, string>
): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, key: string) => {
    const trimmed = key.trim();
    const val = vars[trimmed];
    if (val === undefined) {
      throw new Error(`Template variable '${trimmed}' not found`);
    }
    return val;
  });
}

function buildTemplateVars(
  sample: DatasetSample,
  sandboxPath?: string
): Record<string, string> {
  const vars: Record<string, string> = {};
  // Flatten sample.input.*
  for (const [k, v] of Object.entries(sample.input)) {
    vars[`sample.input.${k}`] = String(v);
  }
  vars['sample.id'] = sample.id;
  if (sandboxPath) vars['sandbox.path'] = sandboxPath;
  return vars;
}

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

  const modulePath = path.isAbsolute(config.target_module)
    ? config.target_module
    : path.join(projectRoot, config.target_module);

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(modulePath);
  const fn = mod[config.target_export];
  if (typeof fn !== 'function') {
    throw new Error(
      `Export '${config.target_export}' not found or not a function in ${modulePath}`
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

// ── subprocess executor ────────────────────────────────────────────────────────

function runSubprocess(
  config: SubprocessExecutorConfig,
  sample: DatasetSample,
  sampleDir: string,
  projectRoot: string,
  templateVarsExtra: Record<string, string> = {}
): void {
  const rawOutputDir = path.join(sampleDir, 'raw-output');
  fs.mkdirSync(rawOutputDir, { recursive: true });

  // Prepare sandbox if configured
  let sandboxPath: string | undefined;
  if (config.sandbox) {
    const copyFrom = config.sandbox.copy_from
      ? expandTemplate(config.sandbox.copy_from, {
          ...buildTemplateVars(sample),
          ...templateVarsExtra,
        })
      : undefined;
    sandboxPath = prepareSandbox(
      copyFrom,
      config.sandbox.clean_before_run ?? true,
      sampleDir,
      projectRoot
    );
  }

  const templateVars = {
    ...buildTemplateVars(sample, sandboxPath),
    ...templateVarsExtra,
  };

  // Resolve workdir
  const workdir = config.workdir
    ? expandTemplate(config.workdir, templateVars)
    : sandboxPath ?? sampleDir;

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

  fs.writeFileSync(path.join(sampleDir, 'stdout.log'), regularLines.join('\n'));
  fs.writeFileSync(path.join(sampleDir, 'stderr.log'), result.stderr ?? '');

  if (toolEventLines.length > 0) {
    fs.writeFileSync(
      path.join(sampleDir, 'tool-events.jsonl'),
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

  // Verify expected outputs exist
  for (const expectedOutput of config.expected_outputs) {
    const outputPath = path.join(workdir, expectedOutput);
    if (!fs.existsSync(outputPath)) {
      throw new Error(
        `Expected output not found: ${outputPath} (subprocess produced no artifact)`
      );
    }
    // Copy expected output to raw-output preserving relative path structure
    const destPath = path.join(rawOutputDir, expectedOutput);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(outputPath, destPath);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

export interface ExecutorRunInput {
  config: ExecutorConfig;
  sample: DatasetSample;
  sampleDir: string;
  attemptDir: string;
  projectRoot: string;
}

export async function executeAttempt(
  input: ExecutorRunInput
): Promise<ExecutionResult> {
  const { config, sample, attemptDir, projectRoot } = input;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  let exitCode: number | undefined;

  try {
    if (config.type === 'in_process') {
      await runInProcess(config, sample, attemptDir, projectRoot);
    } else if (config.type === 'subprocess') {
      runSubprocess(config, sample, attemptDir, projectRoot);
      exitCode = 0;
    } else if (config.type === 'mixed') {
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
      if (subConfig.type === 'in_process') {
        await runInProcess(subConfig, sample, attemptDir, projectRoot);
      } else {
        runSubprocess(subConfig, sample, attemptDir, projectRoot);
        exitCode = 0;
      }
    }

    const completedAt = new Date().toISOString();
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

    fs.writeFileSync(
      path.join(attemptDir, 'execution.json'),
      JSON.stringify(result, null, 2)
    );
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

    fs.writeFileSync(
      path.join(attemptDir, 'execution.json'),
      JSON.stringify(result, null, 2)
    );
    throw err;
  }
}
