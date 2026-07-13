const fs = require('node:fs');
const path = require('node:path');
const { shouldIncludeChangeInWindow } = require('./state.cjs');
const { listDirNames } = require('./utils.cjs');

const EVIDENCE_FILES = [
  'events.jsonl',
  'workflow-state.yaml',
  'inspect/failure-analysis.json',
  'healing',
];

function enumeratePhaseACandidates(sutRoot, state) {
  const archiveDir = path.join(sutRoot, 'qa', 'archive');
  const changesDir = path.join(sutRoot, 'qa', 'changes');
  const archiveIds = new Set(listDirNames(archiveDir));
  const candidates = [];
  const evidenceIncomplete = [];

  for (const changeId of archiveIds) {
    if (!shouldIncludeChangeInWindow(state, changeId, 'archive')) continue;
    const changePath = path.join(archiveDir, changeId);
    if (!hasRequiredEvidence(changePath)) {
      evidenceIncomplete.push(changeId);
      continue;
    }
    candidates.push({ change_id: changeId, source: 'archive' });
  }

  for (const changeId of listDirNames(changesDir)) {
    if (archiveIds.has(changeId)) continue;
    if (!shouldIncludeChangeInWindow(state, changeId, 'unarchived')) continue;
    const changePath = path.join(changesDir, changeId);
    if (!hasRequiredEvidence(changePath)) {
      evidenceIncomplete.push(changeId);
      continue;
    }
    candidates.push({ change_id: changeId, source: 'unarchived' });
  }

  return { candidates, evidenceIncomplete };
}

function hasRequiredEvidence(changePath) {
  return fs.existsSync(path.join(changePath, 'events.jsonl'))
    && fs.existsSync(path.join(changePath, 'workflow-state.yaml'));
}

function snapshotUnarchivedEvidence(sutRoot, retroId, changeId) {
  const src = path.join(sutRoot, 'qa', 'changes', changeId);
  const dst = path.join(sutRoot, 'qa', 'retro', retroId, 'evidence', changeId);
  if (!fs.existsSync(src)) return;
  if (fs.existsSync(path.join(sutRoot, 'qa', 'archive', changeId))) return;

  fs.mkdirSync(dst, { recursive: true });
  for (const rel of EVIDENCE_FILES) {
    const from = path.join(src, rel);
    if (!fs.existsSync(from)) continue;
    const to = path.join(dst, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true });
  }
}

function isTerminalStatusExitCode(code) {
  return code === 10 || code === 20;
}

module.exports = {
  enumeratePhaseACandidates,
  snapshotUnarchivedEvidence,
  isTerminalStatusExitCode,
};
