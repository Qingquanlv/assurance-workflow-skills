function effectiveStage(record) {
  return record.stage ?? 'collected';
}

function shouldIncludeChangeInWindow(state, changeId, source) {
  const record = (state.consumed_changes ?? []).find(
    (entry) => entry.change_id === changeId && entry.source === source,
  );
  if (!record) return true;
  return effectiveStage(record) === 'aggregated';
}

module.exports = { effectiveStage, shouldIncludeChangeInWindow };
