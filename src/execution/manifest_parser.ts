/**
 * Normalises execution-manifest.yaml to the canonical CLI shape.
 *
 * Supports:
 * - CLI primary format: top-level `result_files` map (paths relative to execution/)
 * - Skill extended format: `primary_runner.result_files` as a path array, plus
 *   optional layer_results / warnings / final_status (ignored for inspect routing)
 */
import * as path from 'path';
import { ExecutionManifest, SelectedTargets } from '../core/types';

const BASENAME_TO_KEY: Record<string, keyof ExecutionManifest['result_files']> = {
  'api-result.json': 'api',
  'e2e-result.json': 'e2e',
  'fuzz-result.json': 'fuzz',
  'performance-result.json': 'performance',
  'coverage-result.json': 'coverage',
  'summary.md': 'summary',
};

const VALID_RESULT_KEYS = new Set<string>(Object.values(BASENAME_TO_KEY));

/** Normalises raw YAML to canonical ExecutionManifest, or null if unusable. */
export function normalizeExecutionManifest(
  raw: unknown,
  executionDir: string,
): ExecutionManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const doc = raw as Record<string, unknown>;

  const batchId = typeof doc.batch_id === 'string' ? doc.batch_id : '';
  const changeId = typeof doc.change_id === 'string' ? doc.change_id : '';
  const selectedTargets = normaliseTargets(doc.selected_targets);
  if (!batchId || !selectedTargets) return null;

  let resultFiles = normaliseResultFilesMap(doc.result_files, executionDir);
  if (Object.keys(resultFiles).length === 0) {
    const primary = doc.primary_runner;
    if (primary && typeof primary === 'object' && !Array.isArray(primary)) {
      resultFiles = resultFilesFromPathList(
        (primary as Record<string, unknown>).result_files,
        executionDir,
      );
    }
  }

  return {
    schema_version: '1.0',
    change_id: changeId,
    batch_id: batchId,
    selected_targets: selectedTargets,
    result_files: resultFiles,
    ...(typeof doc.final_status === 'string' ? { final_status: doc.final_status as ExecutionManifest['final_status'] } : {}),
  };
}

function normaliseTargets(value: unknown): SelectedTargets | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys: (keyof SelectedTargets)[] = ['api', 'e2e', 'fuzz', 'performance'];
  if (!keys.some(k => typeof record[k] === 'boolean')) return null;
  return {
    api: record.api === true,
    e2e: record.e2e === true,
    fuzz: record.fuzz === true,
    performance: record.performance === true,
  };
}

function normaliseResultFilesMap(
  value: unknown,
  executionDir: string,
): ExecutionManifest['result_files'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: ExecutionManifest['result_files'] = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== 'string' || !VALID_RESULT_KEYS.has(k)) continue;
    out[k as keyof ExecutionManifest['result_files']] = toExecutionRelativePath(v, executionDir);
  }
  return out;
}

function resultFilesFromPathList(
  files: unknown,
  executionDir: string,
): ExecutionManifest['result_files'] {
  if (!Array.isArray(files)) return {};
  const out: ExecutionManifest['result_files'] = {};
  for (const item of files) {
    if (typeof item !== 'string') continue;
    const key = BASENAME_TO_KEY[path.basename(item)];
    if (key) out[key] = toExecutionRelativePath(item, executionDir);
  }
  return out;
}

/** Converts absolute or repo-relative paths to execution/-relative paths. */
export function toExecutionRelativePath(filePath: string, executionDir: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  if (path.isAbsolute(filePath)) {
    const rel = path.relative(executionDir, filePath).replace(/\\/g, '/');
    if (rel && !rel.startsWith('..')) return rel;
  }
  const marker = '/execution/';
  const idx = normalized.lastIndexOf(marker);
  if (idx >= 0) return normalized.slice(idx + marker.length);
  return normalized;
}
