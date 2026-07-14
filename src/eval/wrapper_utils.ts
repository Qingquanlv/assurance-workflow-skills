// Shared helpers for the compiled workflow-run and aws-run executors.

import fs from 'node:fs';
import path from 'node:path';
import {
  buildProcessSummaryForAttempt,
  buildSessionCommandFields,
  PROCESS_SUMMARY_FILENAME,
  writeProcessSummary,
  type OpenCodeProcessSummary,
} from './opencode_process_events';

type ExecutionPayload = Record<string, unknown>;

interface WrapperCompletion {
  infrastructureError?: boolean;
  archiveCompleted?: boolean;
  evidenceCompleted?: boolean;
}

export function resolveRepoRoot(explicit: string | undefined, scriptDir: string): string {
  if (explicit) return path.resolve(explicit);
  return path.resolve(scriptDir, '..');
}

export function resolveAttemptDir(
  values: Record<string, string | boolean | undefined>,
  archiveDir: string | null,
): string | null {
  if (typeof values['attempt-dir'] === 'string') {
    return path.resolve(values['attempt-dir']);
  }
  if (archiveDir) return path.dirname(path.resolve(archiveDir));
  return null;
}

/** Write stdout/stderr immediately after inner command (spawn) completes. */
export function writeAttemptLogs(attemptDir: string, stdout: string, stderr: string): void {
  fs.mkdirSync(attemptDir, { recursive: true });
  fs.writeFileSync(path.join(attemptDir, 'stdout.log'), stdout ?? '');
  fs.writeFileSync(path.join(attemptDir, 'stderr.log'), stderr ?? '');
}

/** Write execution.json last — after write-scan and archive complete. */
export function writeExecutionJson(attemptDir: string, execution: ExecutionPayload): void {
  fs.mkdirSync(attemptDir, { recursive: true });
  fs.writeFileSync(
    path.join(attemptDir, 'execution.json'),
    JSON.stringify(execution, null, 2)
  );
}

/**
 * Parse OpenCode stdout into process-summary.json (before execution.json).
 * Never throws — parser failures become observability_available=false.
 */
export function writeOpenCodeProcessSummary(opts: {
  attemptDir: string;
  stdoutText: string;
  safetyMode?: 'enabled' | 'disabled';
  projectDir?: string | null;
}): OpenCodeProcessSummary {
  const {
    attemptDir,
    stdoutText,
    safetyMode = 'enabled',
    projectDir = null,
  } = opts;

  const summary = buildProcessSummaryForAttempt({
    stdoutText: stdoutText ?? '',
    safetyMode,
    projectDir,
    attemptDir,
  });
  writeProcessSummary(attemptDir, summary);
  return summary;
}

/** Session + process observability fields for eval-workflow-run execution.json. */
export function buildOpenCodeProcessExecutionFields(
  summary: OpenCodeProcessSummary | null,
  projectDir: string,
): ExecutionPayload {
  const sessionFields = buildSessionCommandFields(summary?.session_id, projectDir);
  return {
    ...sessionFields,
    process_observability_available: Boolean(summary?.observability_available),
    process_summary_path: PROCESS_SUMMARY_FILENAME,
  };
}

/**
 * P0-2 exit code policy:
 * - wrapper infrastructure failure → exit 1
 * - inner command (aws run / opencode) non-zero but archive + evidence OK → exit 0
 */
export function resolveWrapperExitCode({
  infrastructureError,
  archiveCompleted,
  evidenceCompleted,
}: WrapperCompletion): number {
  if (infrastructureError) return 1;
  if (!archiveCompleted || !evidenceCompleted) return 1;
  return 0;
}

export function buildExecutionPayload(
  base: ExecutionPayload,
  innerExitCode: number,
  opts: WrapperCompletion = {},
): ExecutionPayload & { wrapper_exit_code: number } {
  const wrapperExit = resolveWrapperExitCode(opts);
  const innerExitKey =
    base.executor === 'eval-aws-run' ? 'aws_run_exit_code' : 'opencode_exit_code';
  return {
    ...base,
    exit_code: wrapperExit,
    wrapper_exit_code: wrapperExit,
    archive_completed: opts.archiveCompleted ?? false,
    evidence_completed: opts.evidenceCompleted ?? false,
    [innerExitKey]: innerExitCode,
  };
}

/** @deprecated use writeAttemptLogs + writeExecutionJson */
export function writeAttemptEvidence(
  attemptDir: string,
  { stdout, stderr, execution }: {
    stdout: string;
    stderr: string;
    execution: ExecutionPayload;
  },
): void {
  writeAttemptLogs(attemptDir, stdout, stderr);
  writeExecutionJson(attemptDir, execution);
}
