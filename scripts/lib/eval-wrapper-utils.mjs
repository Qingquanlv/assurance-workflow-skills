// Shared helpers for eval-workflow-run.mjs and eval-aws-run.mjs

import fs from 'node:fs';
import path from 'node:path';

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
