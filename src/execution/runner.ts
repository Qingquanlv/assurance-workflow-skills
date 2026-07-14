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
import { ChildProcess, spawn, spawnSync } from 'child_process';
import { ensureDir } from '../utils/fs';
import { runPytest } from './pytest_runner';
import { runPlaywright } from './playwright_runner';
import { buildSummaryMd } from './summary_writer';
import { loadCoverageConfig, parseCoverage } from './coverage_parser';
import { runPerformance } from './locust_runner';
import { buildQualityGate } from '../report/quality_gate';
import type { ApiResult, E2eResult, FuzzResult } from '../core/types';
import type {
  CoverageResult,
  ExecutionManifest,
  PerformanceResult,
  QualityGateResult,
  SelectedTargets,
} from '../schema/contracts';
import { hashProductTree, hashTestTree } from '../core/hash';
import { loadProductCodeRoots } from '../core/healing_state';
import { publishExecutionEvidence } from './evidence';

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

interface ServerCoverageArtifacts {
  available: boolean;
  coverageJsonPath: string;
  coverageXmlPath: string;
  coverageFile: string;
  process: ChildProcess | null;
}

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
  const testTreeHash = hashTestTree(projectRoot);
  const productTreeHash = hashProductTree(projectRoot, loadProductCodeRoots(projectRoot));

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
  const serverCoverage = selectedTargets.api && coverageConfig.enabled && coverageConfig.mode === 'server-process'
    ? startServerCoverage(projectRoot, batchDir, coverageConfig.server_command, coverageConfig.server_port)
    : null;

  let apiResult: ApiResult | null = null;
  let coverageResult: CoverageResult | null = null;
  let e2eResult: E2eResult | null = null;
  let fuzzResult: FuzzResult | null = null;
  let performanceResult: PerformanceResult | null = null;
  let pytestCoverage: ReturnType<typeof runPytest>['coverage'] | null = null;

  try {
    if (selectedTargets.api) {
      const pytestResult = runPytest({
        changeId,
        batchId,
        targets: apiTargets,
        batchDir,
        cwd: projectRoot,
        coverage: {
          enabled: coverageConfig.enabled && coverageConfig.mode !== 'server-process',
          targetPackage: coverageConfig.target_package,
        },
      });
      apiResult = pytestResult.result;
      pytestCoverage = pytestResult.coverage;
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
  } finally {
    stopServerCoverage(projectRoot, serverCoverage);
  }

  if (selectedTargets.api) {
    const coverageArtifacts = serverCoverage ?? pytestCoverage;
    coverageResult = parseCoverage({
      changeId,
      batchId,
      available: coverageArtifacts?.available ?? false,
      coverageJsonPath: coverageArtifacts?.coverageJsonPath ?? path.join(batchDir, 'raw', 'coverage.json'),
      coverageXmlPath: coverageArtifacts?.coverageXmlPath ?? path.join(batchDir, 'raw', 'coverage.xml'),
      threshold: coverageConfig.threshold,
      targetPackage: coverageConfig.target_package,
      projectRoot,
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

  const summaryMd = buildSummaryMd(changeId, batchId, {
    api: apiResult,
    e2e: e2eResult,
    coverage: coverageResult,
    fuzz: fuzzResult,
    performance: performanceResult,
    qualityGate,
    selectedTargets,
  });
  const { manifest } = publishExecutionEvidence({
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
    summary: summaryMd,
    hashes: {
      testsTreeSha256: testTreeHash.aggregate,
      testFilesSha256: testTreeHash.files,
      productTreeSha256: productTreeHash.aggregate,
      productFilesSha256: productTreeHash.files,
    },
  });

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

function startServerCoverage(
  projectRoot: string,
  batchDir: string,
  serverCommand: string | undefined,
  serverPort: number | undefined,
): ServerCoverageArtifacts | null {
  if (!serverCommand?.trim()) return null;
  const rawDir = path.join(batchDir, 'raw');
  const coverageJsonPath = path.join(rawDir, 'coverage.json');
  const coverageXmlPath = path.join(rawDir, 'coverage.xml');
  const coverageFile = path.join(rawDir, '.coverage');

  if (serverPort && portAcceptsConnection(serverPort)) {
    throw new Error(`COVERAGE-SERVER-PORT-IN-USE: port ${serverPort} is already accepting connections. Stop the existing SUT and rerun so aws run can launch it under coverage.`);
  }

  const command = `uv run coverage run --branch -m ${serverCommand}`;
  const proc = spawn(command, {
    cwd: projectRoot,
    shell: true,
    detached: false,
    stdio: 'ignore',
    env: { ...process.env, COVERAGE_FILE: coverageFile },
  });

  if (serverPort && !waitForPort(serverPort, 20_000)) {
    proc.kill('SIGTERM');
    return { available: false, coverageJsonPath, coverageXmlPath, coverageFile, process: null };
  }

  return { available: false, coverageJsonPath, coverageXmlPath, coverageFile, process: proc };
}

function stopServerCoverage(projectRoot: string, artifacts: ServerCoverageArtifacts | null): void {
  if (!artifacts) return;
  if (artifacts.process && !artifacts.process.killed) {
    // Uvicorn/coverage.py flushes reliably on Ctrl-C style shutdown. A plain
    // SIGTERM can stop the wrapper before coverage writes the data file.
    artifacts.process.kill('SIGINT');
  }
  waitForFile(artifacts.coverageFile, 5_000);
  const json = spawnSync('uv', ['run', 'coverage', 'json', '-o', artifacts.coverageJsonPath], {
    cwd: projectRoot,
    encoding: 'utf-8',
    env: { ...process.env, COVERAGE_FILE: artifacts.coverageFile },
  });
  spawnSync('uv', ['run', 'coverage', 'xml', '-o', artifacts.coverageXmlPath], {
    cwd: projectRoot,
    encoding: 'utf-8',
    env: { ...process.env, COVERAGE_FILE: artifacts.coverageFile },
  });
  artifacts.available = json.status === 0 && fs.existsSync(artifacts.coverageJsonPath);
}

function waitForFile(filePath: string, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return true;
    spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 100)'], { timeout: 250 });
  }
  return fs.existsSync(filePath);
}

function waitForPort(port: number, timeoutMs: number): boolean {
  const script = `
const net = require('net');
const port = Number(process.argv[1]);
const deadline = Date.now() + Number(process.argv[2]);
function once() {
  const socket = net.createConnection({ port, host: '127.0.0.1' });
  socket.once('connect', () => { socket.destroy(); process.exit(0); });
  socket.once('error', () => {
    socket.destroy();
    if (Date.now() > deadline) process.exit(1);
    setTimeout(once, 250);
  });
}
once();
`;
  return spawnSync(process.execPath, ['-e', script, String(port), String(timeoutMs)], { timeout: timeoutMs + 1000 }).status === 0;
}

function portAcceptsConnection(port: number): boolean {
  const script = `
const net = require('net');
const socket = net.createConnection({ port: Number(process.argv[1]), host: '127.0.0.1' });
socket.once('connect', () => { socket.destroy(); process.exit(0); });
socket.once('error', () => { socket.destroy(); process.exit(1); });
`;
  return spawnSync(process.execPath, ['-e', script, String(port)], { timeout: 1000 }).status === 0;
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

const ALL_TARGETS: SelectedTargets = { api: true, e2e: true, fuzz: true, performance: true };

export function resolveSelectedTargets(projectRoot: string, changeId: string): SelectedTargets {
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
