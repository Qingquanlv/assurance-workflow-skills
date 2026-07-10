// Shared helpers for eval-workflow-run.mjs and eval-aws-run.mjs

import fs from 'node:fs';
import path from 'node:path';
import {
  buildProcessSummaryForAttempt,
  buildSessionCommandFields,
  PROCESS_SUMMARY_FILENAME,
  writeProcessSummary,
} from './opencode-process-events.mjs';

export function resolveRepoRoot(explicit, scriptDir) {
  if (explicit) return path.resolve(explicit);
  return path.resolve(scriptDir, '..');
}

export function resolveAttemptDir(values, archiveDir) {
  if (values['attempt-dir']) return path.resolve(values['attempt-dir']);
  if (archiveDir) return path.dirname(path.resolve(archiveDir));
  return null;
}

/** Write stdout/stderr immediately after inner command (spawn) completes. */
export function writeAttemptLogs(attemptDir, stdout, stderr) {
  fs.mkdirSync(attemptDir, { recursive: true });
  fs.writeFileSync(path.join(attemptDir, 'stdout.log'), stdout ?? '');
  fs.writeFileSync(path.join(attemptDir, 'stderr.log'), stderr ?? '');
}

/** Write execution.json last — after write-scan and archive complete. */
export function writeExecutionJson(attemptDir, execution) {
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
export function writeOpenCodeProcessSummary(opts) {
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
export function buildOpenCodeProcessExecutionFields(summary, projectDir) {
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
}) {
  if (infrastructureError) return 1;
  if (!archiveCompleted || !evidenceCompleted) return 1;
  return 0;
}

export function buildExecutionPayload(base, innerExitCode, opts = {}) {
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
export function writeAttemptEvidence(attemptDir, { stdout, stderr, execution }) {
  writeAttemptLogs(attemptDir, stdout, stderr);
  writeExecutionJson(attemptDir, execution);
}
