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
import { CoverageConfig, CoverageResult, UncoveredFile } from '../core/types';

const DEFAULT_COVERAGE_CONFIG: CoverageConfig = {
  enabled: true,
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
    const cov = (doc?.coverage ?? {}) as Partial<CoverageConfig> & { threshold?: Partial<{ line: number; branch: number }> };
    return {
      enabled: cov.enabled ?? DEFAULT_COVERAGE_CONFIG.enabled,
      target_package: cov.target_package ?? DEFAULT_COVERAGE_CONFIG.target_package,
      threshold: {
        line: cov.threshold?.line ?? DEFAULT_COVERAGE_CONFIG.threshold.line,
        branch: cov.threshold?.branch ?? DEFAULT_COVERAGE_CONFIG.threshold.branch,
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
  threshold: { line: number; branch: number };
  targetPackage: string;
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
  const status: CoverageResult['status'] = meetsLine && meetsBranch ? 'PASS' : 'PASS_WITH_WARNINGS';

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
    source,
  };
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
