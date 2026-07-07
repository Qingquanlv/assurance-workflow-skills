import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import { ApiResult, E2eResult } from '../core/types';
import { ArchiveBatchSample, Layer } from './types';

export interface SampledArchive {
  archive_id: string;
  archive_path: string;
  archived_at_ms: number;
  latest_batch: ArchiveBatchSample | null;
}

function readArchivedAt(archivePath: string): number | null {
  const summaryPath = path.join(archivePath, 'archive-summary.md');
  if (fs.existsSync(summaryPath)) {
    const text = fs.readFileSync(summaryPath, 'utf-8');
    const m = text.match(/archived_at:\s*['"]?([^'"\n]+)/i);
    if (m?.[1]) {
      const t = Date.parse(m[1].trim());
      if (!Number.isNaN(t)) return t;
    }
  }
  try {
    return fs.statSync(archivePath).mtimeMs;
  } catch {
    return null;
  }
}

function findLatestBatch(archivePath: string, archiveId: string): ArchiveBatchSample | null {
  const runsDir = path.join(archivePath, 'execution', 'runs');
  if (!fs.existsSync(runsDir)) {
    const legacyExec = path.join(archivePath, 'execution');
    if (fs.existsSync(path.join(legacyExec, 'api-result.json'))) {
      return {
        archive_id: archiveId,
        batch_id: 'legacy',
        batch_path: legacyExec,
        batch_mtime_ms: fs.statSync(legacyExec).mtimeMs,
        api_result_path: path.join(legacyExec, 'api-result.json'),
        e2e_result_path: fs.existsSync(path.join(legacyExec, 'e2e-result.json'))
          ? path.join(legacyExec, 'e2e-result.json')
          : undefined,
      };
    }
    return null;
  }

  let best: ArchiveBatchSample | null = null;
  for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const batchPath = path.join(runsDir, entry.name);
    const mtime = fs.statSync(batchPath).mtimeMs;
    const apiPath = path.join(batchPath, 'api-result.json');
    const e2ePath = path.join(batchPath, 'e2e-result.json');
    const sample: ArchiveBatchSample = {
      archive_id: archiveId,
      batch_id: entry.name,
      batch_path: batchPath,
      batch_mtime_ms: mtime,
      api_result_path: fs.existsSync(apiPath) ? apiPath : undefined,
      e2e_result_path: fs.existsSync(e2ePath) ? e2ePath : undefined,
    };
    if (!best || mtime > best.batch_mtime_ms) best = sample;
  }
  return best;
}

export function sampleArchives(projectRoot: string, depth: number): SampledArchive[] {
  const archiveRoot = path.join(projectRoot, 'qa', 'archive');
  if (!fs.existsSync(archiveRoot)) return [];

  const entries = fs
    .readdirSync(archiveRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const archivePath = path.join(archiveRoot, e.name);
      return {
        archive_id: e.name,
        archive_path: archivePath,
        archived_at_ms: readArchivedAt(archivePath) ?? fs.statSync(archivePath).mtimeMs,
      };
    })
    .sort((a, b) => b.archived_at_ms - a.archived_at_ms)
    .slice(0, depth);

  return entries.map((e) => ({
    ...e,
    latest_batch: findLatestBatch(e.archive_path, e.archive_id),
  }));
}

export function readLayerResult(
  filePath: string,
  layer: Layer,
): ApiResult | E2eResult | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ApiResult | E2eResult;
    if (layer === 'api' && data.target !== 'api') return null;
    if (layer === 'e2e' && data.target !== 'e2e') return null;
    return data;
  } catch {
    return null;
  }
}

export function loadExecutionManifestBatchDir(archivePath: string): string | null {
  const manifestPath = path.join(archivePath, 'execution', 'execution-manifest.yaml');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const doc = yaml.load(fs.readFileSync(manifestPath, 'utf-8')) as { batch_id?: string } | null;
    if (doc?.batch_id) {
      const batchDir = path.join(archivePath, 'execution', 'runs', doc.batch_id);
      if (fs.existsSync(batchDir)) return batchDir;
    }
  } catch {
    /* ignore */
  }
  return null;
}
