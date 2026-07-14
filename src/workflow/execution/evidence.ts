/**
 * Public boundary for reading execution evidence.
 *
 * Consumers should ask this module for one coherent snapshot instead of
 * interpreting manifests, batch directories, and latest-pointer files
 * independently.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type {
  ApiResult,
  E2eResult,
  FuzzResult,
} from '../core/types';
import type {
  CoverageResult,
  ExecutionManifest,
  PerformanceResult,
  QualityGateResult,
  SelectedTargets,
} from '../../schema/contracts';
import { normalizeExecutionManifest } from './manifest_parser';

export type ExecutionEvidenceTarget = 'api' | 'e2e' | 'fuzz' | 'performance';

export interface ExecutionEvidenceIntegrityIssue {
  target: ExecutionEvidenceTarget;
  path: string;
  batchId: string;
  reason?: 'batch_mismatch';
  actualBatchId?: string;
}

export interface ExecutionEvidence {
  mode: 'primary' | 'compat';
  executionDir: string;
  sourceManifest: string;
  resultRoot: string;
  batchId: string;
  manifest: ExecutionManifest | null;
  selectedTargets: ExecutionManifest['selected_targets'];
  apiResult: ApiResult | null;
  e2eResult: E2eResult | null;
  coverageResult: CoverageResult | null;
  fuzzResult: FuzzResult | null;
  performanceResult: PerformanceResult | null;
  qualityGate: QualityGateResult | null;
  resultPaths: Record<
    ExecutionEvidenceTarget | 'coverage' | 'qualityGate',
    string
  >;
  integrityIssues: ExecutionEvidenceIntegrityIssue[];
}

export interface PublishExecutionEvidenceInput {
  executionDir: string;
  changeId: string;
  batchId: string;
  selectedTargets: SelectedTargets;
  apiResult: ApiResult | null;
  e2eResult: E2eResult | null;
  coverageResult: CoverageResult;
  fuzzResult: FuzzResult | null;
  performanceResult: PerformanceResult | null;
  qualityGate: QualityGateResult;
  summary: string;
  hashes: {
    testsTreeSha256: string;
    testFilesSha256: Record<string, string>;
    productTreeSha256: string;
    productFilesSha256: Record<string, string>;
  };
}

export interface PublishedExecutionEvidence {
  manifest: ExecutionManifest;
  batchDir: string;
}

type ManifestLoadResult =
  | { state: 'absent'; path: string }
  | { state: 'invalid'; path: string }
  | {
      state: 'valid';
      path: string;
      manifest: ExecutionManifest;
      supportsPrimaryRouting: boolean;
    };

class InvalidExecutionManifestError extends Error {
  constructor(manifestPath: string) {
    super(`EXECUTION-MANIFEST-INVALID: ${manifestPath}`);
    this.name = 'InvalidExecutionManifestError';
  }
}

class InvalidExecutionEvidencePathError extends Error {
  constructor(filePath: string, batchRoot: string) {
    super(
      `EXECUTION-EVIDENCE-PATH-INVALID: ${filePath} is outside ${batchRoot}`,
    );
    this.name = 'InvalidExecutionEvidencePathError';
  }
}

interface ManifestInfo {
  state: 'valid';
  path: string;
  manifest: ExecutionManifest;
  supportsPrimaryRouting: boolean;
}

function loadManifest(executionDir: string): ManifestLoadResult {
  const manifestPath = path.join(executionDir, 'execution-manifest.yaml');
  if (!fs.existsSync(manifestPath)) {
    return { state: 'absent', path: manifestPath };
  }

  try {
    const raw = yaml.load(fs.readFileSync(manifestPath, 'utf-8'));
    const manifest = normalizeExecutionManifest(raw, executionDir, {
      allowMissingSelectedTargets: true,
    });
    if (!manifest) return { state: 'invalid', path: manifestPath };
    const supportsPrimaryRouting =
      !!raw &&
      typeof raw === 'object' &&
      !Array.isArray(raw) &&
      Object.prototype.hasOwnProperty.call(raw, 'selected_targets');
    return {
      state: 'valid',
      manifest,
      path: manifestPath,
      supportsPrimaryRouting,
    };
  } catch {
    return { state: 'invalid', path: manifestPath };
  }
}

function loadJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function loadTargetResult<T extends { batch_id: string }>(
  selected: boolean,
  filePath: string,
  manifest: ExecutionManifest | null,
): { result: T | null; actualBatchId?: string } {
  if (!selected) return { result: null };
  const result = loadJson<T>(filePath);
  if (!result || !manifest) return { result };
  if (result.batch_id === manifest.batch_id) return { result };
  return {
    result: null,
    ...(typeof result.batch_id === 'string'
      ? { actualBatchId: result.batch_id }
      : {}),
  };
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

function removeIfExists(filePath: string): void {
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

function assertSafeBatchId(batchId: string, executionDir: string): void {
  if (
    !batchId ||
    batchId === '.' ||
    batchId === '..' ||
    batchId.includes('/') ||
    batchId.includes('\\') ||
    path.isAbsolute(batchId)
  ) {
    throw new InvalidExecutionEvidencePathError(
      path.resolve(executionDir, 'runs', batchId),
      path.resolve(executionDir, 'runs'),
    );
  }
}

/**
 * Publishes a complete batch before promoting its compatibility pointers.
 * The top-level manifest is written last and therefore acts as the primary
 * evidence commit marker for readers.
 */
export function publishExecutionEvidence(
  input: PublishExecutionEvidenceInput,
): PublishedExecutionEvidence {
  const {
    executionDir,
    changeId,
    batchId,
    selectedTargets,
    apiResult,
    e2eResult,
    coverageResult,
    fuzzResult,
    performanceResult,
    qualityGate,
    summary,
    hashes,
  } = input;
  assertSafeBatchId(batchId, executionDir);
  const batchDir = path.join(executionDir, 'runs', batchId);
  fs.mkdirSync(batchDir, { recursive: true });

  const resultFiles: ExecutionManifest['result_files'] = {};
  const resultDefinitions = [
    { key: 'api', name: 'api-result.json', value: apiResult },
    { key: 'e2e', name: 'e2e-result.json', value: e2eResult },
    { key: 'fuzz', name: 'fuzz-result.json', value: fuzzResult },
    {
      key: 'performance',
      name: 'performance-result.json',
      value: performanceResult,
    },
  ] as const;

  for (const result of resultDefinitions) {
    if (!result.value) continue;
    writeJson(path.join(batchDir, result.name), result.value);
    resultFiles[result.key] = `runs/${batchId}/${result.name}`;
  }
  writeJson(path.join(batchDir, 'coverage-result.json'), coverageResult);
  resultFiles.coverage = `runs/${batchId}/coverage-result.json`;
  fs.writeFileSync(path.join(batchDir, 'summary.md'), summary, 'utf-8');
  resultFiles.summary = `runs/${batchId}/summary.md`;

  const manifest: ExecutionManifest = {
    schema_version: '1.0',
    change_id: changeId,
    batch_id: batchId,
    selected_targets: selectedTargets,
    result_files: resultFiles,
    tests_tree_sha256: hashes.testsTreeSha256,
    test_files_sha256: hashes.testFilesSha256,
    product_tree_sha256: hashes.productTreeSha256,
    final_status: qualityGate.final_status,
  };

  writeJson(
    path.join(batchDir, 'product-files-sha256.json'),
    hashes.productFilesSha256,
  );
  fs.writeFileSync(
    path.join(batchDir, 'execution-manifest.yaml'),
    yaml.dump(manifest),
    'utf-8',
  );
  writeJson(path.join(batchDir, 'quality-gate-result.json'), qualityGate);

  fs.mkdirSync(executionDir, { recursive: true });
  for (const result of resultDefinitions) {
    const latestPath = path.join(executionDir, result.name);
    removeIfExists(latestPath);
    if (result.value) writeJson(latestPath, result.value);
  }
  writeJson(path.join(executionDir, 'coverage-result.json'), coverageResult);
  fs.writeFileSync(path.join(executionDir, 'summary.md'), summary, 'utf-8');
  writeJson(path.join(executionDir, 'quality-gate-result.json'), qualityGate);
  fs.writeFileSync(
    path.join(executionDir, 'execution-manifest.yaml'),
    yaml.dump(manifest),
    'utf-8',
  );

  return { manifest, batchDir };
}

function resultFilePath(
  executionDir: string,
  resultRoot: string,
  manifest: ExecutionManifest | null,
  key: keyof ExecutionManifest['result_files'],
  fallbackName: string,
): string {
  const manifestPath = manifest?.result_files[key];
  if (!manifestPath) return path.join(resultRoot, fallbackName);

  const resolvedPath = path.resolve(executionDir, manifestPath);
  const resolvedRoot = path.resolve(resultRoot);
  if (!isInsideDirectory(resolvedPath, resolvedRoot)) {
    throw new InvalidExecutionEvidencePathError(resolvedPath, resolvedRoot);
  }
  if (fs.existsSync(resolvedPath) && fs.existsSync(resolvedRoot)) {
    const realPath = fs.realpathSync(resolvedPath);
    const realRoot = fs.realpathSync(resolvedRoot);
    if (!isInsideDirectory(realPath, realRoot)) {
      throw new InvalidExecutionEvidencePathError(realPath, realRoot);
    }
  }
  return resolvedPath;
}

function isInsideDirectory(filePath: string, directory: string): boolean {
  return filePath.startsWith(`${directory}${path.sep}`);
}

export function loadExecutionEvidence(executionDir: string): ExecutionEvidence {
  const manifestLoad = loadManifest(executionDir);
  if (manifestLoad.state === 'invalid') {
    throw new InvalidExecutionManifestError(manifestLoad.path);
  }
  const manifestInfo: ManifestInfo | null =
    manifestLoad.state === 'valid' ? manifestLoad : null;
  const manifest = manifestInfo?.manifest ?? null;
  const mode = manifestInfo?.supportsPrimaryRouting ? 'primary' : 'compat';
  const routingManifest = mode === 'primary' ? manifest : null;
  if (routingManifest) {
    assertSafeBatchId(routingManifest.batch_id, executionDir);
  }
  const selectedTargets = manifest?.selected_targets ?? {
    api: true,
    e2e: true,
    fuzz: true,
    performance: true,
  };
  const resultRoot = mode === 'primary' && manifest
    ? path.join(executionDir, 'runs', manifest.batch_id)
    : executionDir;

  const apiPath = resultFilePath(
    executionDir,
    resultRoot,
    routingManifest,
    'api',
    'api-result.json',
  );
  const e2ePath = resultFilePath(
    executionDir,
    resultRoot,
    routingManifest,
    'e2e',
    'e2e-result.json',
  );
  const coveragePath = resultFilePath(
    executionDir,
    resultRoot,
    routingManifest,
    'coverage',
    'coverage-result.json',
  );
  const fuzzPath = resultFilePath(
    executionDir,
    resultRoot,
    routingManifest,
    'fuzz',
    'fuzz-result.json',
  );
  const performancePath = resultFilePath(
    executionDir,
    resultRoot,
    routingManifest,
    'performance',
    'performance-result.json',
  );

  const api = loadTargetResult<ApiResult>(
    selectedTargets.api,
    apiPath,
    routingManifest,
  );
  const e2e = loadTargetResult<E2eResult>(
    selectedTargets.e2e,
    e2ePath,
    routingManifest,
  );
  const coverage = loadTargetResult<CoverageResult>(
    selectedTargets.api,
    coveragePath,
    routingManifest,
  );
  const fuzz = loadTargetResult<FuzzResult>(
    selectedTargets.fuzz,
    fuzzPath,
    routingManifest,
  );
  const performance = loadTargetResult<PerformanceResult>(
    selectedTargets.performance,
    performancePath,
    routingManifest,
  );
  const apiResult = api.result;
  const e2eResult = e2e.result;
  const coverageResult = coverage.result;
  const fuzzResult = fuzz.result;
  const performanceResult = performance.result;
  const resultBatchId =
    apiResult?.batch_id ??
    e2eResult?.batch_id ??
    coverageResult?.batch_id ??
    fuzzResult?.batch_id ??
    performanceResult?.batch_id ??
    '';

  const targetResults = [
    {
      target: 'api',
      selected: selectedTargets.api,
      path: apiPath,
      result: apiResult,
      actualBatchId: api.actualBatchId,
    },
    {
      target: 'e2e',
      selected: selectedTargets.e2e,
      path: e2ePath,
      result: e2eResult,
      actualBatchId: e2e.actualBatchId,
    },
    {
      target: 'fuzz',
      selected: selectedTargets.fuzz,
      path: fuzzPath,
      result: fuzzResult,
      actualBatchId: fuzz.actualBatchId,
    },
    {
      target: 'performance',
      selected: selectedTargets.performance,
      path: performancePath,
      result: performanceResult,
      actualBatchId: performance.actualBatchId,
    },
  ] as const;
  const integrityIssues = targetResults
    .filter(
      item => mode === 'primary' && item.selected && item.result === null,
    )
    .map(item => ({
      target: item.target,
      path: item.path,
      batchId: manifest?.batch_id ?? '',
      ...(item.actualBatchId
        ? {
            reason: 'batch_mismatch' as const,
            actualBatchId: item.actualBatchId,
          }
        : {}),
    }));
  const batchGatePath = path.join(resultRoot, 'quality-gate-result.json');
  const latestGatePath = path.join(executionDir, 'quality-gate-result.json');
  let qualityGatePath = mode === 'primary' ? batchGatePath : latestGatePath;
  const batchGate = mode === 'primary' && manifest
    ? loadJson<QualityGateResult>(batchGatePath)
    : null;
  let qualityGate =
    batchGate?.batch_id === manifest?.batch_id ? batchGate : null;
  if (mode === 'primary' && manifest && !qualityGate) {
    const latestGate = loadJson<QualityGateResult>(latestGatePath);
    if (latestGate?.batch_id === manifest.batch_id) {
      qualityGate = latestGate;
      qualityGatePath = latestGatePath;
    }
  } else if (mode === 'compat') {
    qualityGate = loadJson<QualityGateResult>(latestGatePath);
  }
  const batchId =
    mode === 'primary'
      ? manifest?.batch_id ?? ''
      : resultBatchId || qualityGate?.batch_id || manifest?.batch_id || '';

  return {
    mode,
    executionDir,
    sourceManifest: manifestInfo?.path ?? '',
    resultRoot,
    batchId,
    manifest,
    selectedTargets,
    apiResult,
    e2eResult,
    coverageResult,
    fuzzResult,
    performanceResult,
    qualityGate,
    resultPaths: {
      api: apiPath,
      e2e: e2ePath,
      coverage: coveragePath,
      fuzz: fuzzPath,
      performance: performancePath,
      qualityGate: qualityGatePath,
    },
    integrityIssues,
  };
}
