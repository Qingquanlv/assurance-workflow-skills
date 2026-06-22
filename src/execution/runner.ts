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
import * as yaml from 'js-yaml';
import { ensureDir } from '../utils/fs';
import { runPytest } from './pytest_runner';
import { runPlaywright } from './playwright_runner';
import { buildSummaryMd } from './summary_writer';
import { loadCoverageConfig, parseCoverage } from './coverage_parser';
import { runPerformance } from './locust_runner';
import { buildQualityGate } from '../report/quality_gate';
import { ApiResult, CoverageResult, E2eResult, ExecutionManifest, FuzzResult, PerformanceResult, QualityGateResult, SelectedTargets } from '../core/types';

export interface RunnerOptions {
  changeId: string;
  projectRoot: string;
  selectedTargets?: SelectedTargets;
}

export interface RunnerResult {
  api: ApiResult | null;
  e2e: E2eResult | null;
  /** Always present — SKIPPED(api_unselected) when api=false, so downstream never reads a stale file. */
  coverage: CoverageResult;
  fuzz: FuzzResult | null;
  performance: PerformanceResult | null;
  qualityGate: QualityGateResult;
  selectedTargets: SelectedTargets;
  manifest: ExecutionManifest;
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
  const selectedTargets = opts.selectedTargets ?? resolveSelectedTargets(projectRoot, changeId);

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

  let apiResult: ApiResult | null = null;
  let coverageResult: CoverageResult | null = null;
  let e2eResult: E2eResult | null = null;
  let fuzzResult: FuzzResult | null = null;
  let performanceResult: PerformanceResult | null = null;

  if (selectedTargets.api) {
    const pytestResult = runPytest({
      changeId,
      batchId,
      targets: apiTargets,
      batchDir,
      cwd: projectRoot,
      coverage: { enabled: coverageConfig.enabled, targetPackage: coverageConfig.target_package },
    });
    apiResult = pytestResult.result;
    coverageResult = parseCoverage({
      changeId,
      batchId,
      available: pytestResult.coverage.available,
      coverageJsonPath: pytestResult.coverage.coverageJsonPath,
      coverageXmlPath: pytestResult.coverage.coverageXmlPath,
      threshold: coverageConfig.threshold,
      targetPackage: coverageConfig.target_package,
    });
  } else {
    // Coverage is derived from API pytest; write an explicit SKIPPED result so
    // downstream inspect/report stages never read a stale file.
    coverageResult = {
      schema_version: '1.0',
      change_id: changeId,
      batch_id: batchId,
      kind: 'coverage',
      available: false,
      line_coverage: 0,
      branch_coverage: 0,
      threshold: coverageConfig.threshold,
      status: 'SKIPPED',
      skip_reason: 'api_unselected',
      uncovered_critical_files: [],
      source: { coverage_json: '', coverage_xml: '' },
    };
  }

  if (selectedTargets.e2e) {
    e2eResult = runPlaywright({
      changeId,
      batchId,
      targets: e2eTargets,
      batchDir,
      cwd: projectRoot,
    }).result;
  }

  if (selectedTargets.fuzz) {
    const fuzzPytest = runPytest({
      changeId,
      batchId,
      targets: fuzzTargets,
      batchDir,
      cwd: projectRoot,
      kind: 'fuzz',
    });
    fuzzResult = { ...fuzzPytest.result, target: 'fuzz' };
  }

  if (selectedTargets.performance) {
    performanceResult = runPerformance({
      changeId,
      batchId,
      batchDir,
      cwd: projectRoot,
    });
  }

  const qualityGate = buildQualityGate({
    changeId,
    batchId,
    apiResult,
    e2eResult,
    coverageResult,
    coverageGateMode: coverageConfig.gate_mode,
    fuzzResult,
    performanceResult,
  });

  // ── Write per-batch result files ──────────────────────────────────────────
  const batchApiResultPath = path.join(batchDir, 'api-result.json');
  const batchE2eResultPath = path.join(batchDir, 'e2e-result.json');
  const batchCoveragePath  = path.join(batchDir, 'coverage-result.json');
  const batchFuzzPath      = path.join(batchDir, 'fuzz-result.json');
  const batchPerfPath      = path.join(batchDir, 'performance-result.json');
  const batchSummaryPath   = path.join(batchDir, 'summary.md');

  const resultFiles: ExecutionManifest['result_files'] = {};
  if (apiResult) {
    fs.writeFileSync(batchApiResultPath, JSON.stringify(apiResult, null, 2), 'utf-8');
    resultFiles.api = `runs/${batchId}/api-result.json`;
  }
  if (e2eResult) {
    fs.writeFileSync(batchE2eResultPath, JSON.stringify(e2eResult, null, 2), 'utf-8');
    resultFiles.e2e = `runs/${batchId}/e2e-result.json`;
  }
  // Coverage is always written — either a real result when api=true, or SKIPPED(api_unselected).
  fs.writeFileSync(batchCoveragePath, JSON.stringify(coverageResult, null, 2), 'utf-8');
  resultFiles.coverage = `runs/${batchId}/coverage-result.json`;
  if (fuzzResult) {
    fs.writeFileSync(batchFuzzPath, JSON.stringify(fuzzResult, null, 2), 'utf-8');
    resultFiles.fuzz = `runs/${batchId}/fuzz-result.json`;
  }
  if (performanceResult) {
    fs.writeFileSync(batchPerfPath, JSON.stringify(performanceResult, null, 2), 'utf-8');
    resultFiles.performance = `runs/${batchId}/performance-result.json`;
  }
  const summaryMd = buildSummaryMd(changeId, batchId, {
    api: apiResult,
    e2e: e2eResult,
    coverage: coverageResult,
    fuzz: fuzzResult,
    performance: performanceResult,
    qualityGate,
    selectedTargets,
  });
  fs.writeFileSync(batchSummaryPath, summaryMd, 'utf-8');
  resultFiles.summary = `runs/${batchId}/summary.md`;

  const manifest: ExecutionManifest = {
    schema_version: '1.0',
    change_id: changeId,
    batch_id: batchId,
    selected_targets: selectedTargets,
    result_files: resultFiles,
    final_status: qualityGate.final_status,
  };
  const batchManifestPath = path.join(batchDir, 'execution-manifest.yaml');
  fs.writeFileSync(batchManifestPath, yaml.dump(manifest), 'utf-8');

  // Write quality-gate to batch dir so inspector can read rather than re-compute.
  const batchGatePath = path.join(batchDir, 'quality-gate-result.json');
  fs.writeFileSync(batchGatePath, JSON.stringify(qualityGate, null, 2), 'utf-8');
  resultFiles.summary = `runs/${batchId}/summary.md`;

  // ── Write top-level "latest" pointer files (backward compat) ─────────────
  // Only top-level execution/*.json files are replaced — execution/runs/** is an
  // append-only audit archive and is NEVER deleted or overwritten here.
  const latestApiPath      = path.join(executionDir, 'api-result.json');
  const latestE2ePath      = path.join(executionDir, 'e2e-result.json');
  const latestCoveragePath = path.join(executionDir, 'coverage-result.json');
  const latestFuzzPath     = path.join(executionDir, 'fuzz-result.json');
  const latestPerfPath     = path.join(executionDir, 'performance-result.json');
  const latestSummaryPath  = path.join(executionDir, 'summary.md');

  removeIfExists(latestApiPath);
  removeIfExists(latestE2ePath);
  removeIfExists(latestCoveragePath);
  removeIfExists(latestFuzzPath);
  removeIfExists(latestPerfPath);

  if (apiResult) fs.writeFileSync(latestApiPath, JSON.stringify(apiResult, null, 2), 'utf-8');
  if (e2eResult) fs.writeFileSync(latestE2ePath, JSON.stringify(e2eResult, null, 2), 'utf-8');
  // Coverage always written (may be SKIPPED with reason=api_unselected).
  fs.writeFileSync(latestCoveragePath, JSON.stringify(coverageResult, null, 2), 'utf-8');
  if (fuzzResult) fs.writeFileSync(latestFuzzPath, JSON.stringify(fuzzResult, null, 2), 'utf-8');
  if (performanceResult) fs.writeFileSync(latestPerfPath, JSON.stringify(performanceResult, null, 2), 'utf-8');
  fs.writeFileSync(latestSummaryPath, summaryMd, 'utf-8');
  fs.writeFileSync(path.join(executionDir, 'execution-manifest.yaml'), yaml.dump(manifest), 'utf-8');
  fs.writeFileSync(path.join(executionDir, 'quality-gate-result.json'), JSON.stringify(qualityGate, null, 2), 'utf-8');

  return {
    api: apiResult,
    e2e: e2eResult,
    coverage: coverageResult,
    fuzz: fuzzResult,
    performance: performanceResult,
    qualityGate,
    selectedTargets,
    manifest,
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

function removeIfExists(filePath: string): void {
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

const ALL_TARGETS: SelectedTargets = { api: true, e2e: true, fuzz: true, performance: true };

function resolveSelectedTargets(projectRoot: string, changeId: string): SelectedTargets {
  const fromState = readSelectedTargetsFromWorkflowState(projectRoot, changeId);
  if (fromState) return fromState;

  const changesBase = path.join(projectRoot, 'qa', 'changes', changeId);
  const plansDir = path.join(changesBase, 'plans');
  const planSelection: SelectedTargets = {
    api: fs.existsSync(path.join(plansDir, 'api-codegen-plan.md')),
    e2e: fs.existsSync(path.join(plansDir, 'e2e-codegen-plan.md')),
    fuzz: fs.existsSync(path.join(plansDir, 'fuzz-codegen-plan.md')),
    performance: fs.existsSync(path.join(plansDir, 'performance-codegen-plan.md')),
  };
  if (Object.values(planSelection).some(Boolean)) return planSelection;

  return { ...ALL_TARGETS };
}

function readSelectedTargetsFromWorkflowState(projectRoot: string, changeId: string): SelectedTargets | null {
  const statePath = path.join(projectRoot, 'qa', 'changes', changeId, 'workflow-state.yaml');
  if (!fs.existsSync(statePath)) return null;
  try {
    const doc = yaml.load(fs.readFileSync(statePath, 'utf-8')) as Record<string, unknown> | null;
    const explicit = normaliseTargets(doc?.selected_targets);
    if (explicit) return explicit;
    const layers = normaliseTargets(doc?.layers);
    if (layers) return layers;
  } catch {
    return null;
  }
  return null;
}

function normaliseTargets(value: unknown): SelectedTargets | null {
  if (!value || typeof value !== 'object') return null;
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
