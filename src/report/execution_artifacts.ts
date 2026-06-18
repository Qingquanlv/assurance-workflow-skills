/**
 * Load execution artifacts via execution-manifest.yaml (primary) or latest pointers (compat).
 * Shared by inspect and report generation so both read the same batch-scoped evidence.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
  ApiResult,
  CoverageResult,
  E2eResult,
  ExecutionManifest,
  FuzzResult,
  PerformanceResult,
  QualityGateResult,
} from '../core/types';
import { normalizeExecutionManifest } from '../execution/manifest_parser';

export interface ExecutionArtifactBundle {
  executionDir: string;
  manifest: ExecutionManifest | null;
  sourceManifest: string;
  isCompatFallback: boolean;
  resultRoot: string;
  batchId: string;
  selectedTargets: ExecutionManifest['selected_targets'];
  apiResult: ApiResult | null;
  e2eResult: E2eResult | null;
  coverageResult: CoverageResult | null;
  fuzzResult: FuzzResult | null;
  performanceResult: PerformanceResult | null;
  batchGate: QualityGateResult | null;
}

export function loadExecutionManifest(
  executionDir: string
): { manifest: ExecutionManifest; path: string } | null {
  const manifestPath = path.join(executionDir, 'execution-manifest.yaml');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const raw = yaml.load(fs.readFileSync(manifestPath, 'utf-8'));
    const manifest = normalizeExecutionManifest(raw, executionDir);
    if (!manifest) return null;
    return { manifest, path: manifestPath };
  } catch {
    return null;
  }
}

export function resultFilePath(
  executionDir: string,
  resultRoot: string,
  manifest: ExecutionManifest | null,
  key: keyof ExecutionManifest['result_files'],
  fallbackName: string
): string {
  const manifestPath = manifest?.result_files?.[key];
  if (manifestPath) return path.join(executionDir, manifestPath);
  return path.join(resultRoot, fallbackName);
}

function loadJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

export function loadExecutionArtifacts(
  executionDir: string
): ExecutionArtifactBundle {
  const manifestInfo = loadExecutionManifest(executionDir);
  const manifest = manifestInfo?.manifest ?? null;
  const sourceManifest = manifestInfo?.path ?? '';
  const isCompatFallback = manifest === null;
  const selectedTargets =
    manifest?.selected_targets ?? {
      api: true,
      e2e: true,
      fuzz: true,
      performance: true,
    };
  const resultRoot = manifest
    ? path.join(executionDir, 'runs', manifest.batch_id)
    : executionDir;

  const apiResult = selectedTargets.api
    ? loadJson<ApiResult>(
        resultFilePath(executionDir, resultRoot, manifest, 'api', 'api-result.json')
      )
    : null;
  const e2eResult = selectedTargets.e2e
    ? loadJson<E2eResult>(
        resultFilePath(executionDir, resultRoot, manifest, 'e2e', 'e2e-result.json')
      )
    : null;
  const coverageResult = selectedTargets.api
    ? loadJson<CoverageResult>(
        resultFilePath(
          executionDir,
          resultRoot,
          manifest,
          'coverage',
          'coverage-result.json'
        )
      )
    : null;
  const fuzzResult = selectedTargets.fuzz
    ? loadJson<FuzzResult>(
        resultFilePath(executionDir, resultRoot, manifest, 'fuzz', 'fuzz-result.json')
      )
    : null;
  const performanceResult = selectedTargets.performance
    ? loadJson<PerformanceResult>(
        resultFilePath(
          executionDir,
          resultRoot,
          manifest,
          'performance',
          'performance-result.json'
        )
      )
    : null;

  const batchId =
    manifest?.batch_id ??
    apiResult?.batch_id ??
    e2eResult?.batch_id ??
    coverageResult?.batch_id ??
    fuzzResult?.batch_id ??
    performanceResult?.batch_id ??
    '';

  const batchGate = manifest
    ? loadJson<QualityGateResult>(path.join(resultRoot, 'quality-gate-result.json'))
    : null;

  return {
    executionDir,
    manifest,
    sourceManifest,
    isCompatFallback,
    resultRoot,
    batchId,
    selectedTargets,
    apiResult,
    e2eResult,
    coverageResult,
    fuzzResult,
    performanceResult,
    batchGate,
  };
}
