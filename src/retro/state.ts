import * as fs from 'fs';
import * as path from 'path';

export type RetroEvidenceSource = 'archive' | 'unarchived';

/**
 * Two-stage consumption (see docs/design/nightly-driver.md §4):
 * - `aggregated`: written right after `aws retro` builds context.json, but the
 *   collect run has not finished (PHASE C/D may still fail). Replayable.
 * - `collected`: the collect run completed and produced its review queue (or a
 *   valid no-op). Terminal — never reconsumed.
 * Legacy records without a stage are treated as `collected`.
 */
export type RetroConsumeStage = 'aggregated' | 'collected';

export interface ConsumedChangeRecord {
  change_id: string;
  source: RetroEvidenceSource;
  consumed_at: string;
  retro_id: string;
  stage?: RetroConsumeStage;
}

export interface RetroState {
  schema_version: '1.1';
  last_retro_ts: string | null;
  last_retro_id: string | null;
  consumed_changes: ConsumedChangeRecord[];
}

function statePath(projectRoot: string): string {
  return path.join(projectRoot, 'qa', 'retro', '_state.json');
}

export function readRetroState(projectRoot: string): RetroState {
  const file = statePath(projectRoot);
  if (!fs.existsSync(file)) {
    return {
      schema_version: '1.1',
      last_retro_ts: null,
      last_retro_id: null,
      consumed_changes: [],
    };
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<RetroState>;
  return {
    schema_version: '1.1',
    last_retro_ts: parsed.last_retro_ts ?? null,
    last_retro_id: parsed.last_retro_id ?? null,
    consumed_changes: parsed.consumed_changes ?? [],
  };
}

export function writeRetroState(projectRoot: string, state: RetroState): void {
  const file = statePath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

export function hasConsumedChange(
  projectRoot: string,
  changeId: string,
  source: RetroEvidenceSource,
): boolean {
  return readRetroState(projectRoot).consumed_changes.some(
    (entry) => entry.change_id === changeId && entry.source === source,
  );
}

export function markConsumedChange(
  projectRoot: string,
  record: ConsumedChangeRecord,
): void {
  const state = readRetroState(projectRoot);
  const staged: ConsumedChangeRecord = { stage: 'aggregated', ...record };
  const existing = state.consumed_changes.find(
    (entry) => entry.change_id === record.change_id && entry.source === record.source,
  );
  if (existing) {
    // A prior aggregated (replayable) record is re-stamped to this run; a
    // collected record is terminal and must not be overwritten here.
    if (effectiveStage(existing) === 'aggregated') {
      existing.consumed_at = staged.consumed_at;
      existing.retro_id = staged.retro_id;
      existing.stage = 'aggregated';
    }
  } else {
    state.consumed_changes.push(staged);
  }
  state.last_retro_ts = record.consumed_at;
  state.last_retro_id = record.retro_id;
  writeRetroState(projectRoot, state);
}

function effectiveStage(record: ConsumedChangeRecord): RetroConsumeStage {
  return record.stage ?? 'collected';
}

/**
 * A change is replayable when its most recent consumption is still `aggregated`
 * (the owning collect run never completed). `collected` and legacy records are
 * terminal.
 */
export function isReplayableChange(
  projectRoot: string,
  changeId: string,
  source: RetroEvidenceSource,
): boolean {
  const record = readRetroState(projectRoot).consumed_changes.find(
    (entry) => entry.change_id === changeId && entry.source === source,
  );
  if (!record) return false;
  return effectiveStage(record) === 'aggregated';
}

/** Upgrade every aggregated record of a retro run to collected (terminal). */
export function completeRetroStage(projectRoot: string, retroId: string): void {
  const state = readRetroState(projectRoot);
  for (const record of state.consumed_changes) {
    if (record.retro_id === retroId && effectiveStage(record) === 'aggregated') {
      record.stage = 'collected';
    }
  }
  writeRetroState(projectRoot, state);
}

/** Whether PHASE A should include a change in the current window (nightly driver). */
export function shouldIncludeChangeInWindow(
  projectRoot: string,
  changeId: string,
  source: RetroEvidenceSource,
): boolean {
  const record = readRetroState(projectRoot).consumed_changes.find(
    (entry) => entry.change_id === changeId && entry.source === source,
  );
  if (!record) return true;
  return effectiveStage(record) === 'aggregated';
}
