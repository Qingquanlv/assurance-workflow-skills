import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { QaEvent } from '../core/events';
import type {
  ArchivedChange,
  ArchiveReadOptions,
  ApplySummaryFile,
  FailureAnalysisFile,
  FixProposalFile,
  HealingArtifacts,
  WorkflowStateFile,
} from './types';

function readArchivedAt(archivePath: string): number {
  const summaryPath = path.join(archivePath, 'archive-summary.md');
  if (fs.existsSync(summaryPath)) {
    const text = fs.readFileSync(summaryPath, 'utf-8');
    const match = text.match(/archived_at:\s*['"]?([^'"\n]+)/i);
    if (match?.[1]) {
      const parsed = Date.parse(match[1].trim());
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return fs.statSync(archivePath).mtimeMs;
}

function readEventsJsonl(archivePath: string): QaEvent[] {
  const file = path.join(archivePath, 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as QaEvent];
      } catch {
        return [];
      }
    });
}

function readFailureAnalysis(archivePath: string): FailureAnalysisFile | null {
  const file = path.join(archivePath, 'inspect', 'failure-analysis.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as FailureAnalysisFile;
  } catch {
    return null;
  }
}

function readJson<T>(file: string): T | null {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function readHealingArtifacts(archivePath: string): HealingArtifacts {
  const healingDir = path.join(archivePath, 'healing');
  const fixProposal = readJson<FixProposalFile>(
    path.join(healingDir, 'fix-proposal.json'),
  );
  const applySummaries: ApplySummaryFile[] = [];
  if (fs.existsSync(healingDir)) {
    for (const entry of fs.readdirSync(healingDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('-apply-summary.json')) continue;
      const summary = readJson<ApplySummaryFile>(path.join(healingDir, entry.name));
      if (summary) applySummaries.push(summary);
    }
  }
  return {
    fix_proposal: fixProposal,
    apply_summaries: applySummaries.sort((a, b) =>
      String(a.target ?? '').localeCompare(String(b.target ?? '')),
    ),
  };
}

function readWorkflowState(archivePath: string): WorkflowStateFile | null {
  const file = path.join(archivePath, 'workflow-state.yaml');
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = yaml.load(fs.readFileSync(file, 'utf-8'));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as WorkflowStateFile)
      : null;
  } catch {
    return null;
  }
}

function readArchive(projectRoot: string, changeId: string): ArchivedChange {
  const archivePath = path.join(projectRoot, 'qa', 'archive', changeId);
  if (!fs.existsSync(archivePath)) {
    throw new Error(`Archived change not found: ${changeId}`);
  }
  return {
    change_id: changeId,
    archive_path: archivePath,
    archived_at_ms: readArchivedAt(archivePath),
    events: readEventsJsonl(archivePath),
    failure_analysis: readFailureAnalysis(archivePath),
    healing: readHealingArtifacts(archivePath),
    workflow_state: readWorkflowState(archivePath),
  };
}

export function readArchivedChanges(
  projectRoot: string,
  opts: ArchiveReadOptions,
): ArchivedChange[] {
  const archiveRoot = path.join(projectRoot, 'qa', 'archive');
  if (opts.changes?.length) {
    return opts.changes
      .map((changeId) => readArchive(projectRoot, changeId))
      .sort((a, b) => a.archived_at_ms - b.archived_at_ms);
  }

  if (!fs.existsSync(archiveRoot)) return [];
  const sinceMs = opts.since ? Date.parse(opts.since) : Date.now() - 30 * 86400_000;
  const cutoff = Number.isNaN(sinceMs) ? Date.now() - 30 * 86400_000 : sinceMs;

  return fs
    .readdirSync(archiveRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readArchive(projectRoot, entry.name))
    .filter((change) => change.archived_at_ms >= cutoff)
    .sort((a, b) => a.archived_at_ms - b.archived_at_ms);
}
