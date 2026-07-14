/**
 * Normalises execution-manifest.yaml to the canonical CLI shape.
 *
 * Supports:
 * - CLI primary format: top-level `result_files` map (paths relative to execution/)
 * - Skill extended format: `primary_runner.result_files` as a path array, plus
 *   optional layer_results / warnings / final_status (ignored for inspect routing)
 */
import * as path from 'path';
import type { ExecutionManifest, SelectedTargets } from '../schema/contracts';

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
  options: { allowMissingSelectedTargets?: boolean } = {},
): ExecutionManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const doc = raw as Record<string, unknown>;

  const batchId = typeof doc.batch_id === 'string' ? doc.batch_id : '';
  const changeId = typeof doc.change_id === 'string' ? doc.change_id : '';
  const selectedTargets =
    doc.selected_targets === undefined && options.allowMissingSelectedTargets
      ? { api: true, e2e: true, fuzz: true, performance: true }
      : normaliseTargets(doc.selected_targets);
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
  const testFilesSha256 = normaliseHashMap(doc.test_files_sha256);
  const finalStatus = normaliseFinalStatus(doc);

  return {
    schema_version: '1.0',
    change_id: changeId,
    batch_id: batchId,
    selected_targets: selectedTargets,
    result_files: resultFiles,
    ...(typeof doc.tests_tree_sha256 === 'string'
      ? { tests_tree_sha256: doc.tests_tree_sha256 }
      : {}),
    ...(testFilesSha256
      ? { test_files_sha256: testFilesSha256 }
      : {}),
    ...(typeof doc.product_tree_sha256 === 'string'
      ? { product_tree_sha256: doc.product_tree_sha256 }
      : {}),
    ...(finalStatus
      ? { final_status: finalStatus }
      : {}),
  };
}

function normaliseHashMap(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  return Object.fromEntries(entries);
}

function normaliseFinalStatus(
  doc: Record<string, unknown>,
): ExecutionManifest['final_status'] | null {
  const direct = doc.final_status;
  if (isFinalStatus(direct)) return direct;
  const qualityGate = doc.quality_gate;
  if (
    qualityGate &&
    typeof qualityGate === 'object' &&
    !Array.isArray(qualityGate)
  ) {
    const nested = (qualityGate as Record<string, unknown>).final_status;
    if (isFinalStatus(nested)) return nested;
  }
  return null;
}

function isFinalStatus(
  value: unknown,
): value is NonNullable<ExecutionManifest['final_status']> {
  return (
    value === 'PASS' ||
    value === 'PASS_WITH_WARNINGS' ||
    value === 'FAIL' ||
    value === 'SKIPPED'
  );
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
