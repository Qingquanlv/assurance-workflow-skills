import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { sha256File } from '../../utils/hash';
import type { TestTreeIntegrityResult } from './healing_state';

export interface WriteTestChangesOverrideEvidenceOptions {
  projectRoot: string;
  changeId: string;
  batchId: string;
  batchDir: string;
  reason: string;
  integrity: TestTreeIntegrityResult;
  createdAt?: string;
}

export interface TestChangesOverrideEvidenceResult {
  relPath: string;
  absPath: string;
  sha256: string;
  changedFilesCount: number;
}

export function writeTestChangesOverrideEvidence(
  opts: WriteTestChangesOverrideEvidenceOptions,
): TestChangesOverrideEvidenceResult {
  fs.mkdirSync(opts.batchDir, { recursive: true });
  const diffFileName = writeGitDiff(opts.projectRoot, opts.batchDir);
  const relPath = `execution/runs/${opts.batchId}/test-changes-override.json`;
  const absPath = path.join(opts.batchDir, 'test-changes-override.json');
  const payload = {
    schema_version: '1.0',
    change_id: opts.changeId,
    batch_id: opts.batchId,
    baseline_batch_id: opts.integrity.previousBatchId ?? null,
    reason: opts.reason,
    created_at: opts.createdAt ?? new Date().toISOString(),
    changed_files: opts.integrity.changedFiles,
    git_diff_file: diffFileName,
  };

  fs.writeFileSync(absPath, JSON.stringify(payload, null, 2), 'utf-8');
  const hash = sha256File(absPath);
  if (!hash) throw new Error(`OVERRIDE-EVIDENCE-WRITE-FAILED: ${relPath}`);
  return {
    relPath,
    absPath,
    sha256: hash,
    changedFilesCount: opts.integrity.changedFiles.length,
  };
}

function writeGitDiff(projectRoot: string, batchDir: string): string | null {
  const git = spawnSync('git', ['diff', '--', 'tests/'], {
    cwd: projectRoot,
    encoding: 'utf-8',
  });
  if (git.status !== 0) return null;
  const diff = git.stdout ?? '';
  if (diff.trim().length === 0) return null;
  const fileName = 'test-changes-override.diff';
  fs.writeFileSync(path.join(batchDir, fileName), diff, 'utf-8');
  return fileName;
}
