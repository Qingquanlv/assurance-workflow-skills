/**
 * Coverage configuration loading and normalisation (M1).
 *
 * Reads coverage.py native JSON (produced by pytest-cov `--cov-report=json`)
 * and normalises it into the canonical CoverageResult. Never fabricates numbers:
 * when coverage data is missing the result is marked `available: false` / SKIPPED.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { CoverageConfig } from '../core/types';
import type {
  CoverageResult,
  CoverageScopeResult,
  CoverageThreshold,
  UncoveredFile,
} from '../schema/contracts';

const DEFAULT_COVERAGE_CONFIG: CoverageConfig = {
  enabled: true,
  mode: 'pytest-cov',
  target_package: 'app',
  threshold: { line: 70, branch: 60 },
  gate_mode: 'warn',
};

/** Loads the `coverage:` block from .aws/config.yaml, falling back to defaults. */
export function loadCoverageConfig(projectRoot: string): CoverageConfig {
  const configPath = path.join(projectRoot, '.aws', 'config.yaml');
  if (!fs.existsSync(configPath)) return { ...DEFAULT_COVERAGE_CONFIG };
  try {
    const doc = yaml.load(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown> | null;
    const cov = (doc?.coverage ?? {}) as Partial<CoverageConfig> & { threshold?: Partial<CoverageThreshold> };
    return {
      enabled: cov.enabled ?? DEFAULT_COVERAGE_CONFIG.enabled,
      mode: cov.mode === 'server-process' ? 'server-process' : 'pytest-cov',
      ...(typeof cov.server_command === 'string' ? { server_command: cov.server_command } : {}),
      ...(typeof cov.server_port === 'number' ? { server_port: cov.server_port } : {}),
      target_package: cov.target_package ?? DEFAULT_COVERAGE_CONFIG.target_package,
      threshold: {
        line: cov.threshold?.line ?? DEFAULT_COVERAGE_CONFIG.threshold.line,
        branch: cov.threshold?.branch ?? DEFAULT_COVERAGE_CONFIG.threshold.branch,
        ...(typeof cov.threshold?.module_line === 'number' ? { module_line: cov.threshold.module_line } : {}),
        ...(typeof cov.threshold?.diff_line === 'number' ? { diff_line: cov.threshold.diff_line } : {}),
      },
      gate_mode: cov.gate_mode === 'block' ? 'block' : 'warn',
    };
  } catch {
    return { ...DEFAULT_COVERAGE_CONFIG };
  }
}

export interface ParseCoverageOptions {
  changeId: string;
  batchId: string;
  /** Whether pytest-cov ran and produced data. */
  available: boolean;
  coverageJsonPath: string;
  coverageXmlPath: string;
  threshold: CoverageThreshold;
  targetPackage: string;
  projectRoot?: string;
}

interface CoveragePyFileSummary {
  num_statements?: number;
  covered_lines?: number;
  percent_covered?: number;
  num_branches?: number;
  covered_branches?: number;
}

interface CoveragePyJson {
  files?: Record<string, { summary?: CoveragePyFileSummary }>;
  totals?: CoveragePyFileSummary;
}

/** Normalises coverage.py JSON into a canonical CoverageResult. */
export function parseCoverage(opts: ParseCoverageOptions): CoverageResult {
  const { changeId, batchId, available, coverageJsonPath, coverageXmlPath, threshold, targetPackage } = opts;

  const source = { coverage_json: coverageJsonPath, coverage_xml: coverageXmlPath };

  if (!available || !fs.existsSync(coverageJsonPath)) {
    return {
      schema_version: '1.0',
      change_id: changeId,
      batch_id: batchId,
      kind: 'coverage',
      available: false,
      line_coverage: 0,
      branch_coverage: 0,
      threshold,
      status: 'SKIPPED',
      uncovered_critical_files: [],
      source,
    };
  }

  let doc: CoveragePyJson;
  try {
    doc = JSON.parse(fs.readFileSync(coverageJsonPath, 'utf-8')) as CoveragePyJson;
  } catch {
    return {
      schema_version: '1.0',
      change_id: changeId,
      batch_id: batchId,
      kind: 'coverage',
      available: false,
      line_coverage: 0,
      branch_coverage: 0,
      threshold,
      status: 'SKIPPED',
      uncovered_critical_files: [],
      source,
    };
  }

  const totals = doc.totals ?? {};
  const lineCoverage = round1(totals.percent_covered ?? 0);
  const branchCoverage = computeBranchCoverage(totals);

  const uncovered: UncoveredFile[] = [];
  for (const [file, entry] of Object.entries(doc.files ?? {})) {
    const summary = entry.summary ?? {};
    const pct = round1(summary.percent_covered ?? 0);
    if (pct < threshold.line && isUnderTarget(file, targetPackage)) {
      uncovered.push({ file, line_coverage: pct });
    }
  }
  uncovered.sort((a, b) => a.line_coverage - b.line_coverage);

  const meetsLine = lineCoverage >= threshold.line;
  const meetsBranch = branchCoverage >= threshold.branch;
  const scope = opts.projectRoot
    ? buildScopeCoverage(opts.projectRoot, changeId, doc, threshold.module_line ?? threshold.line)
    : undefined;
  const meetsScope = !scope || scope.status !== 'PASS_WITH_WARNINGS';
  const status: CoverageResult['status'] = meetsLine && meetsBranch && meetsScope ? 'PASS' : 'PASS_WITH_WARNINGS';

  return {
    schema_version: '1.0',
    change_id: changeId,
    batch_id: batchId,
    kind: 'coverage',
    available: true,
    line_coverage: lineCoverage,
    branch_coverage: branchCoverage,
    threshold,
    status,
    uncovered_critical_files: uncovered.slice(0, 10),
    ...(scope ? { scope } : {}),
    source,
  };
}

function buildScopeCoverage(
  projectRoot: string,
  changeId: string,
  doc: CoveragePyJson,
  threshold: number,
): CoverageScopeResult | undefined {
  const inScope = loadInScopeFiles(projectRoot, changeId);
  if (inScope.length === 0) return undefined;

  const matched: { file: string; line_coverage: number; statements: number; covered: number }[] = [];
  for (const [file, entry] of Object.entries(doc.files ?? {})) {
    if (!inScope.some(scopePath => matchesScope(file, scopePath))) continue;
    const summary = entry.summary ?? {};
    const statements = summary.num_statements ?? 0;
    const covered = summary.covered_lines ?? 0;
    matched.push({
      file,
      line_coverage: round1(summary.percent_covered ?? 0),
      statements,
      covered,
    });
  }
  if (matched.length === 0) {
    return {
      source: 'advisory.test_strategy.scope.in_scope',
      files: [],
      module_line_coverage: 0,
      threshold,
      status: 'SKIPPED',
    };
  }

  const totalStatements = matched.reduce((sum, f) => sum + f.statements, 0);
  const totalCovered = matched.reduce((sum, f) => sum + f.covered, 0);
  const moduleLine = totalStatements > 0
    ? round1((totalCovered / totalStatements) * 100)
    : round1(matched.reduce((sum, f) => sum + f.line_coverage, 0) / matched.length);
  return {
    source: 'advisory.test_strategy.scope.in_scope',
    files: matched.map(({ file, line_coverage }) => ({ file, line_coverage })).sort((a, b) => a.file.localeCompare(b.file)),
    module_line_coverage: moduleLine,
    threshold,
    status: moduleLine >= threshold ? 'PASS' : 'PASS_WITH_WARNINGS',
  };
}

function loadInScopeFiles(projectRoot: string, changeId: string): string[] {
  const changeDir = path.join(projectRoot, 'qa', 'changes', changeId);
  const candidates = [
    path.join(changeDir, 'risk-advisory', 'advisory.json'),
    path.join(changeDir, 'explore', 'advisory.json'),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
      const strategy = isRecord(doc.test_strategy) ? doc.test_strategy as Record<string, unknown> : {};
      const scope = isRecord(strategy.scope) ? strategy.scope as Record<string, unknown> : {};
      const inScope = Array.isArray(scope.in_scope) ? scope.in_scope.filter((p): p is string => typeof p === 'string') : [];
      return inScope.filter(p => p.endsWith('.py') || p.includes('.py::') || p.endsWith('/'));
    } catch {
      continue;
    }
  }
  return [];
}

function matchesScope(file: string, scopePath: string): boolean {
  const normalizedFile = file.replace(/\\/g, '/');
  const normalizedScope = scopePath.replace(/\\/g, '/').replace(/::.*$/, '');
  if (normalizedScope.endsWith('/')) return normalizedFile.startsWith(normalizedScope);
  return normalizedFile === normalizedScope || normalizedFile.endsWith('/' + normalizedScope);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function computeBranchCoverage(totals: CoveragePyFileSummary): number {
  const numBranches = totals.num_branches ?? 0;
  if (numBranches <= 0) return 100; // no branches → nothing to miss
  const covered = totals.covered_branches ?? 0;
  return round1((covered / numBranches) * 100);
}

function isUnderTarget(file: string, targetPackage: string): boolean {
  if (!targetPackage) return true;
  const normalized = file.replace(/\\/g, '/');
  return normalized === targetPackage ||
    normalized.startsWith(targetPackage + '/') ||
    normalized.includes('/' + targetPackage + '/');
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
