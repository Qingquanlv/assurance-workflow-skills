/**
 * Orchestrates plan reading, test target discovery, pytest, and Playwright runs.
 *
 * Each invocation of run() generates a unique batch_id (YYYYMMDD-HHmmss).
 * Results are written to:
 *   execution/runs/<batch-id>/   ← per-run archive (never overwritten)
 *   execution/api-result.json    ← latest run (backward-compat pointer)
 *   execution/e2e-result.json    ← latest run (backward-compat pointer)
 *   execution/summary.md         ← latest run (backward-compat pointer)
 */
import * as fs from 'fs';
import * as path from 'path';
import { ensureDir } from '../utils/fs';
import { runPytest } from './pytest_runner';
import { runPlaywright } from './playwright_runner';
import { buildSummaryMd } from './summary_writer';
import { loadCoverageConfig, parseCoverage } from './coverage_parser';
import { runPerformance } from './locust_runner';
import { ApiResult, CoverageResult, E2eResult, FuzzResult, PerformanceResult } from '../core/types';

export interface RunnerOptions {
  changeId: string;
  projectRoot: string;
}

export interface RunnerResult {
  api: ApiResult;
  e2e: E2eResult;
  coverage: CoverageResult;
  fuzz: FuzzResult;
  performance: PerformanceResult;
  executionDir: string;
  batchDir: string;
  batchId: string;
}

const TEST_FILE_RE = /(?:tests?\/[^\s,]+\.(?:py|ts|js))/gi;

/** Generate a sortable timestamp-based batch ID: YYYYMMDD-HHmmss */
function generateBatchId(): string {
  const now = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
  ].join('') + '-' + [
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
}

export function run(opts: RunnerOptions): RunnerResult {
  const { changeId, projectRoot } = opts;
  const changesBase = path.join(projectRoot, 'qa', 'changes', changeId);
  const executionDir = path.join(changesBase, 'execution');
  const batchId = generateBatchId();
  const batchDir = path.join(executionDir, 'runs', batchId);

  // Create per-batch subdirectories
  ensureDir(batchDir);
  ensureDir(path.join(batchDir, 'raw'));
  ensureDir(path.join(batchDir, 'traces'));
  ensureDir(path.join(batchDir, 'screenshots'));
  ensureDir(path.join(batchDir, 'videos'));

  // Ensure top-level execution dir exists (for latest pointers)
  ensureDir(executionDir);

  // Discover test targets from plans
  const apiTargets = discoverTargets(changesBase, 'api-codegen-plan.md', projectRoot, ['tests/api', 'tests/test_*.py']);
  const e2eTargets = discoverTargets(changesBase, 'e2e-codegen-plan.md', projectRoot, ['tests/e2e']);
  const fuzzTargets = discoverTargets(changesBase, 'fuzz-codegen-plan.md', projectRoot, ['tests/fuzz']);

  // Coverage config (M1): collected only during API pytest runs.
  const coverageConfig = loadCoverageConfig(projectRoot);

  // Run pytest — raw artifacts go into batchDir
  const pytestResult = runPytest({
    changeId,
    batchId,
    targets: apiTargets,
    batchDir,
    cwd: projectRoot,
    coverage: { enabled: coverageConfig.enabled, targetPackage: coverageConfig.target_package },
  });

  // Normalise coverage into canonical result (M1).
  const coverageResult = parseCoverage({
    changeId,
    batchId,
    available: pytestResult.coverage.available,
    coverageJsonPath: pytestResult.coverage.coverageJsonPath,
    coverageXmlPath: pytestResult.coverage.coverageXmlPath,
    threshold: coverageConfig.threshold,
    targetPackage: coverageConfig.target_package,
  });

  // Run Playwright — raw artifacts go into batchDir
  const pwResult = runPlaywright({
    changeId,
    batchId,
    targets: e2eTargets,
    batchDir,
    cwd: projectRoot,
  });

  // Run Fuzz (schemathesis via pytest) — separate raw filenames, no coverage (M3 Phase B).
  const fuzzPytest = runPytest({
    changeId,
    batchId,
    targets: fuzzTargets,
    batchDir,
    cwd: projectRoot,
    kind: 'fuzz',
  });
  const fuzzResult: FuzzResult = { ...fuzzPytest.result, target: 'fuzz' };

  // Run Performance (Locust) — absolute thresholds, env SKIPPED when locust/host unavailable (M3 Phase C).
  const performanceResult = runPerformance({
    changeId,
    batchId,
    batchDir,
    cwd: projectRoot,
  });

  // ── Write per-batch result files ──────────────────────────────────────────
  const batchApiResultPath = path.join(batchDir, 'api-result.json');
  const batchE2eResultPath = path.join(batchDir, 'e2e-result.json');
  const batchCoveragePath  = path.join(batchDir, 'coverage-result.json');
  const batchFuzzPath      = path.join(batchDir, 'fuzz-result.json');
  const batchPerfPath      = path.join(batchDir, 'performance-result.json');
  const batchSummaryPath   = path.join(batchDir, 'summary.md');

  fs.writeFileSync(batchApiResultPath, JSON.stringify(pytestResult.result, null, 2), 'utf-8');
  fs.writeFileSync(batchE2eResultPath, JSON.stringify(pwResult.result, null, 2), 'utf-8');
  fs.writeFileSync(batchCoveragePath, JSON.stringify(coverageResult, null, 2), 'utf-8');
  fs.writeFileSync(batchFuzzPath, JSON.stringify(fuzzResult, null, 2), 'utf-8');
  fs.writeFileSync(batchPerfPath, JSON.stringify(performanceResult, null, 2), 'utf-8');
  fs.writeFileSync(batchSummaryPath, buildSummaryMd(changeId, batchId, pytestResult.result, pwResult.result), 'utf-8');

  // ── Write top-level "latest" pointer files (backward compat) ─────────────
  const latestApiPath      = path.join(executionDir, 'api-result.json');
  const latestE2ePath      = path.join(executionDir, 'e2e-result.json');
  const latestCoveragePath = path.join(executionDir, 'coverage-result.json');
  const latestFuzzPath     = path.join(executionDir, 'fuzz-result.json');
  const latestPerfPath     = path.join(executionDir, 'performance-result.json');
  const latestSummaryPath  = path.join(executionDir, 'summary.md');

  fs.writeFileSync(latestApiPath, JSON.stringify(pytestResult.result, null, 2), 'utf-8');
  fs.writeFileSync(latestE2ePath, JSON.stringify(pwResult.result, null, 2), 'utf-8');
  fs.writeFileSync(latestCoveragePath, JSON.stringify(coverageResult, null, 2), 'utf-8');
  fs.writeFileSync(latestFuzzPath, JSON.stringify(fuzzResult, null, 2), 'utf-8');
  fs.writeFileSync(latestPerfPath, JSON.stringify(performanceResult, null, 2), 'utf-8');
  fs.writeFileSync(latestSummaryPath, buildSummaryMd(changeId, batchId, pytestResult.result, pwResult.result), 'utf-8');

  return {
    api: pytestResult.result,
    e2e: pwResult.result,
    coverage: coverageResult,
    fuzz: fuzzResult,
    performance: performanceResult,
    executionDir,
    batchDir,
    batchId,
  };
}

/**
 * Reads a codegen plan to extract test file paths. Falls back to defaults.
 */
function discoverTargets(
  changesBase: string,
  planFile: string,
  projectRoot: string,
  defaults: string[],
): string[] {
  const planPath = path.join(changesBase, 'plans', planFile);
  if (fs.existsSync(planPath)) {
    const content = fs.readFileSync(planPath, 'utf-8');
    const found = Array.from(content.matchAll(TEST_FILE_RE)).map(m => m[0]);
    if (found.length > 0) {
      return [...new Set(found)];
    }
  }
  return defaults.filter(d => fs.existsSync(path.resolve(projectRoot, d)));
}
