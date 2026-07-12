import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DatasetSample, SampleScore } from '../types';
import { deriveHealingState } from '../../core/healing_state';
import { scoreOpenCodeProcessMetrics } from './_shared/opencode_process_metrics';
import {
  resolveRawOutputDir,
  scoreEvidenceIntegrity,
  scoreExecutionPassRate,
} from './_shared/workflow_metrics';

function readExecutionJson(attemptDir: string): Record<string, unknown> {
  const p = path.join(attemptDir, 'execution.json');
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function scoreFullRunCompletedRate(attemptDir: string): number {
  const exec = readExecutionJson(attemptDir);
  if (exec.timed_out === true) return 0;
  if (exec.infrastructureError === true) return 0;
  return 1;
}

export function scoreWallTimeSeconds(attemptDir: string): number {
  const exec = readExecutionJson(attemptDir);
  const ms = typeof exec.duration_ms === 'number' ? exec.duration_ms : 0;
  return ms / 1000;
}

function archivedChangeId(rawOutputDir: string): string {
  const manifestPath = path.join(rawOutputDir, 'archive-manifest.json');
  if (!fs.existsSync(manifestPath)) return 'eval-change';
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      change_id?: unknown;
    };
    return typeof manifest.change_id === 'string' && manifest.change_id
      ? manifest.change_id
      : 'eval-change';
  } catch {
    return 'eval-change';
  }
}

/**
 * Mount a flat change-dir archive (eval raw-output) so deriveHealingState can
 * read events + healing artifacts instead of stale workflow-state.yaml fields.
 */
function withMountedChangeArchive<T>(
  rawOutputDir: string,
  fn: (projectRoot: string, changeId: string) => T,
): T {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-eval-heal-'));
  const changeId = archivedChangeId(rawOutputDir);
  const changeDir = path.join(projectRoot, 'qa', 'changes', changeId);
  try {
    fs.mkdirSync(path.dirname(changeDir), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'tests'), { recursive: true });
    try {
      fs.symlinkSync(path.resolve(rawOutputDir), changeDir, 'dir');
    } catch {
      fs.cpSync(path.resolve(rawOutputDir), changeDir, { recursive: true });
    }
    return fn(projectRoot, changeId);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

/**
 * 1 when the change entered healing beyond idle states; 0 otherwise.
 * Uses evidence-derived healing state (events + artifacts), not YAML status.
 */
export function scoreHealingTriggeredRate(rawOutputDir: string): number {
  if (!fs.existsSync(rawOutputDir)) return 0;
  try {
    return withMountedChangeArchive(rawOutputDir, (projectRoot, changeId) => {
      const derived = deriveHealingState(projectRoot, changeId);
      if (derived.attempts_used > 0) return 1;
      const status = derived.status;
      if (status === 'pending' || status === 'skipped' || status === 'not_needed') return 0;
      return 1;
    });
  } catch {
    return 0;
  }
}

/** E4 observe-only scorer — canonical attemptDir only. */
export function score(sample: DatasetSample, attemptDir: string): SampleScore {
  const rawOutputDir = resolveRawOutputDir(attemptDir);

  const metrics: Record<string, number> = {
    full_run_completed_rate: scoreFullRunCompletedRate(attemptDir),
    end_to_end_pass_rate: scoreExecutionPassRate(rawOutputDir),
    healing_triggered_rate: scoreHealingTriggeredRate(rawOutputDir),
    wall_time_seconds: scoreWallTimeSeconds(attemptDir),
    evidence_integrity_diag: scoreEvidenceIntegrity(attemptDir),
    ...scoreOpenCodeProcessMetrics(attemptDir),
  };

  return {
    sample_id: sample.id,
    status: 'ok',
    metrics,
  };
}
