import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { DatasetSample, SampleScore } from '../types';
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

export function scoreHealingTriggeredRate(rawOutputDir: string): number {
  const statePath = path.join(rawOutputDir, 'workflow-state.yaml');
  if (!fs.existsSync(statePath)) return 0;
  try {
    const state = yaml.load(fs.readFileSync(statePath, 'utf8')) as {
      phases?: { healing?: { status?: string; attempts?: unknown[] } };
    };
    const healing = state.phases?.healing;
    if (!healing) return 0;
    const status = (healing.status ?? '').toLowerCase();
    if (status === 'skipped' || status === 'pending' || status === '') return 0;
    if (Array.isArray(healing.attempts) && healing.attempts.length > 0) return 1;
    return status === 'done' || status === 'in_progress' || status === 'pass' ? 1 : 0;
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
