import * as fs from 'fs';
import * as path from 'path';
import { shouldIncludeChangeInWindow } from './state';
import { listDirNames } from './utils';
import type { ChangeCandidate, NightlyState } from './types';

const EVIDENCE_FILES = [
  'events.jsonl',
  'workflow-state.yaml',
  'inspect/failure-analysis.json',
  'healing',
];

export function enumeratePhaseACandidates(
  sutRoot: string,
  state: NightlyState,
): { candidates: ChangeCandidate[]; evidenceIncomplete: string[] } {
  const archiveDir = path.join(sutRoot, 'qa', 'archive');
  const changesDir = path.join(sutRoot, 'qa', 'changes');
  const archiveIds = new Set(listDirNames(archiveDir));
  const candidates: ChangeCandidate[] = [];
  const evidenceIncomplete: string[] = [];

  for (const changeId of archiveIds) {
    if (!shouldIncludeChangeInWindow(state, changeId, 'archive')) continue;
    if (!hasRequiredEvidence(path.join(archiveDir, changeId))) {
      evidenceIncomplete.push(changeId);
      continue;
    }
    candidates.push({ change_id: changeId, source: 'archive' });
  }

  for (const changeId of listDirNames(changesDir)) {
    if (archiveIds.has(changeId)) continue;
    if (!shouldIncludeChangeInWindow(state, changeId, 'unarchived')) continue;
    if (!hasRequiredEvidence(path.join(changesDir, changeId))) {
      evidenceIncomplete.push(changeId);
      continue;
    }
    candidates.push({ change_id: changeId, source: 'unarchived' });
  }
  return { candidates, evidenceIncomplete };
}

function hasRequiredEvidence(changePath: string): boolean {
  return fs.existsSync(path.join(changePath, 'events.jsonl'))
    && fs.existsSync(path.join(changePath, 'workflow-state.yaml'));
}

export function snapshotUnarchivedEvidence(
  sutRoot: string,
  retroId: string,
  changeId: string,
): void {
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

export function isTerminalStatusExitCode(code: number): boolean {
  return code === 10 || code === 20;
}
