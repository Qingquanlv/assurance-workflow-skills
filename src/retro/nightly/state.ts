import type { NightlyState } from './types';

export function effectiveStage(record: { stage?: string }): string {
  return record.stage ?? 'collected';
}

export function shouldIncludeChangeInWindow(
  state: NightlyState,
  changeId: string,
  source: string,
): boolean {
  const record = (state.consumed_changes ?? []).find(
    (entry) => entry.change_id === changeId && entry.source === source,
  );
  if (!record) return true;
  return effectiveStage(record) === 'aggregated';
}
